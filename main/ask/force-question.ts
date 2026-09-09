import { BrowserWindow, Notification, ipcMain, powerMonitor, screen, shell } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { getAllSettings, listWorkspaces, setSettings } from '../db';
import {
    dropDraft,
    parseDraftStore,
    pruneDrafts,
    putDraft,
    serializeDraftStore,
    type AskDraftEntry,
    type AskDraftStore,
} from './draft-store';
import { LOCAL_CONN_KEY, openTestingBrowser } from '../testing-browser';
import { wireAskLinkRouting } from './link-route';
import { playAlertSound } from '../notify-sound';
import { demandWindowAttention } from '../attention-flash';
import type {
    ForceAnswer,
    ForceQuestion,
    ForceQuestionResult,
} from '../mcp/protocol';
import type { QuestionTransport } from '../host-core/ports';
import { insertByPriority, type QuestionPriority } from './question-priority';
import { deriveAskKey } from './ask-key';
import {
    dbQuestionStore,
    type PersistedQuestion,
    type QuestionStorePort,
} from './question-store';
import { ASK_MODAL_WIDTH, askWindowBounds } from './drawer-bounds';
import {
    asFtqAvailability,
    resolveDndMessage,
    resolveFtqAvailability,
    type FtqAvailability,
} from './availability';

/** The scope a question belongs to — drives the per-workspace/per-workstation
 *  availability resolution. Both optional: absent ⇒ that scope is unset (inherit). */
export interface QuestionScope {
    workspaceId?: string;
    workstationId?: string;
}

interface AvailabilityDecision {
    availability: FtqAvailability;
    dndMessage: string;
}

/** Parse a JSON `{ id: 'available'|'dnd' }` scope-map setting; tolerant of junk. */
function parseScopeMap(v: unknown): Record<string, unknown> {
    if (typeof v !== 'string' || v === '') return {};
    try {
        const o = JSON.parse(v);
        return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** Resolve availability + the DND notice from settings for a question's scope.
 *  Most-specific wins: workspace → workstation → global → Available default. */
function readAvailabilityFromSettings(scope: QuestionScope): AvailabilityDecision {
    try {
        const s = getAllSettings();
        const wsMap = parseScopeMap(s.ftq_availability_workspaces);
        const wkMap = parseScopeMap(s.ftq_availability_workstations);
        return {
            availability: resolveFtqAvailability({
                workspace: scope.workspaceId ? asFtqAvailability(wsMap[scope.workspaceId]) : undefined,
                workstation: scope.workstationId
                    ? asFtqAvailability(wkMap[scope.workstationId])
                    : undefined,
                global: asFtqAvailability(s.ftq_availability),
            }),
            dndMessage: resolveDndMessage(s.ftq_dnd_message),
        };
    } catch {
        return { availability: 'available', dndMessage: resolveDndMessage(undefined) };
    }
}

/** Injectable so the desktop enqueue path is unit-testable without the settings
 *  DB (tests install a fake); default reads live settings. */
let availabilityReader: (scope: QuestionScope) => AvailabilityDecision = readAvailabilityFromSettings;
export function setAvailabilityReader(
    r: ((scope: QuestionScope) => AvailabilityDecision) | null,
): void {
    availabilityReader = r ?? readAvailabilityFromSettings;
}

/**
 * The local root of the workspace a question came from — what the modal's file
 * drawer resolves a named path against (Tynn story #272). A question that says
 * `.ai/plans/spec.md` means that file in ITS workspace, and the read is confined
 * to that root by the existing `files:read` handler.
 *
 * Injectable like {@link availabilityReader} so the enqueue path stays testable
 * without the workspaces table; unreadable ⇒ undefined ⇒ the chips render as
 * plain text and open nothing, which is exactly what shipped before.
 */
function readWorkspacePath(workspaceId: string): string | undefined {
    try {
        return listWorkspaces().find((w) => w.id === workspaceId)?.path || undefined;
    } catch {
        return undefined;
    }
}
let workspacePathReader: (workspaceId: string) => string | undefined = readWorkspacePath;
export function setWorkspacePathReader(
    r: ((workspaceId: string) => string | undefined) | null,
): void {
    workspacePathReader = r ?? readWorkspacePath;
}

export interface UserPresence {
    away: boolean;
    idleSeconds: number;
}

const USER_AWAY_SECONDS = 5 * 60;
function readUserPresence(): UserPresence {
    try {
        const idleSeconds = Math.max(0, powerMonitor.getSystemIdleTime());
        return { away: idleSeconds >= USER_AWAY_SECONDS, idleSeconds };
    } catch {
        return { away: false, idleSeconds: 0 };
    }
}

let userPresenceReader: () => UserPresence = readUserPresence;
export function setUserPresenceReader(reader: (() => UserPresence) | null): void {
    userPresenceReader = reader ?? readUserPresence;
}

function deferredAgentMessage(decision: AvailabilityDecision): string {
    if (decision.availability === 'dnd') return decision.dndMessage;
    const presence = userPresenceReader();
    return presence.away
        ? 'the user appears away (no workstation activity for at least 5 minutes); the question is waiting in their Genie inbox and the answer will be delivered to your AgentInbox'
        : 'the user is active; the question is waiting in their Genie inbox and the answer will be delivered to your AgentInbox';
}

/**
 * WHY a ForceTheQuestion answer is arriving asynchronously rather than inline —
 * carried alongside the answer so the late "it was answered" message can name the
 * real reason instead of always assuming DND (genie #315). Every MCP
 * ForceTheQuestion answer is delivered through this same async channel (ping/poll/
 * pull), so the reason is the ONLY thing that distinguishes a genuine DND parking
 * from an ordinary modal answer.
 *   - `'dnd'`: the scope was in Do Not Disturb — the modal never popped.
 *   - `'unshowable'`: the modal could not be raised (no display) for an otherwise
 *     available user.
 *   - `'restart'`: Genie restarted while the question was pending, and it was
 *     rebuilt from the database into the inbox (see
 *     {@link rehydratePendingQuestions}). Distinct from the other two because the
 *     agent was never told anything about DND or a display — from its side the
 *     answer simply took an upgrade longer than expected.
 *   - `undefined`: the modal WAS shown and this is its ordinary answer; only the
 *     DELIVERY is asynchronous, by design (see `raiseDesktopModal`).
 */
export type DeferralReason = 'dnd' | 'unshowable' | 'restart';

/**
 * An asynchronous agent question's late answer, ready to hand back to the asker.
 * The composition root wires a sink that delivers it through the AgentInbox broker
 * (append → the agent PULLs it; notifyDelivery + wake = the PING) so both a
 * modal answer and a DND-deferred answer use the inbox: ping, poll, pull. Kept as an
 * injected port so `force-question` never imports the broker (testable + no cycle).
 */
export interface DeferredAnswerDelivery {
    /** The asking agent's terminal — the broker resolves it to the target agent. */
    terminalId: string;
    /** The deferred question id (matches the `questionId` the ask returned). */
    questionId: string;
    /** The questions as asked, so the delivered message can restate them. */
    questions: ForceQuestion[];
    /** The user's answer (selected options + note per question). */
    answers: ForceAnswer[];
    /** See {@link DeferralReason}. Absent ⇒ a plain, non-parked modal answer. */
    deferralReason?: DeferralReason;
}

/**
 * Render a deferred/async ForceTheQuestion answer as the AgentInbox message the
 * asking agent pulls (genie #62, genie #315). Restates each question with the
 * option(s) picked + any note, and phrases the intro to match the TRUE reason the
 * answer is arriving this way — a plain modal answer must never be mislabeled a
 * DND deferral just because delivery is (always, by design) asynchronous.
 */
/** What a caller must have for an answer to reach it. */
export interface AskDeliverability {
    /** The asking terminal's workspace, or null when it has none. */
    workspaceId: string | null;
    /** Whether an AgentInbox identity exists to deliver the answer to. */
    hasInboxIdentity: boolean;
}

/**
 * Why this caller must NOT be allowed to ask — or undefined when it may.
 *
 * `ForceTheQuestion` used to accept from anyone and promise "the answer will be
 * delivered to your AgentInbox", including from callers with no inbox at all.
 * The user answered, the question cleared, and the answer was DISCARDED with no
 * message ever created (genie#321). From the human's side that is
 * indistinguishable from the agent ignoring them.
 *
 * `agentinbox` and `submitFeedback` already refuse an unbound terminal plainly.
 * This applies the same rule at ask time, where it costs the agent an error
 * instead of costing the human their answer.
 *
 * ## The wording was as wrong as the lookup behind it (genie#502)
 *
 * The identity refusal used to add *"This happens when an agent was started by
 * hand rather than launched by Genie"* and end on *"Ask the user directly in
 * your own terminal instead."* Both were false for the caller it fired on most —
 * the workstation operator, a terminal Genie creates itself at boot — and the
 * advice is the one thing that provably does not work: nobody is reading that
 * terminal, which is the premise of the whole Genie protocol. A guessed cause
 * plus a dead end is worse than a bare refusal, because an agent acts on it.
 *
 * So neither branch names a cause it has not checked, and both end on something
 * a reader can actually do. The identity branch says what `agentinbox` says for
 * the same condition, deliberately: one answer to "this terminal has no agent",
 * not two that drift.
 */
export function forceQuestionRefusal(d: AskDeliverability): string | undefined {
    if (!d.workspaceId) {
        return (
            'This terminal is not in a workspace, so an answer could not be delivered back to it. ' +
            'A person has to attach it to one — through Genie’s Add Workspace flow, or by opening ' +
            'this folder as a workspace — before questions from here can be answered.'
        );
    }
    if (!d.hasInboxIdentity) {
        return (
            'No agent is registered on this terminal in the AgentInbox, so there is nowhere to ' +
            'deliver an answer. Register it with `registerAgent` (giving it a name and a purpose), ' +
            'or have it started through Genie so it is created as a named agent — the same thing ' +
            '`agentinbox` asks for when it refuses an unnamed terminal.'
        );
    }
    return undefined;
}

export function formatDeferredAnswer(d: DeferredAnswerDelivery): string {
    const lines = d.answers.map((a, i) => {
        const q = d.questions[i]?.question ?? d.questions[i]?.header ?? `Q${i + 1}`;
        const picked = a.selected.length ? a.selected.join(', ') : '(no option selected)';
        const note = a.note?.trim() ? ` — note: ${a.note.trim()}` : '';
        return `• ${q}\n  → ${picked}${note}`;
    });
    const intro =
        d.deferralReason === 'dnd'
            ? 'Your ForceTheQuestion was answered (it had been deferred while you were in DND):'
            : d.deferralReason === 'unshowable'
              ? 'Your ForceTheQuestion was answered (it had been deferred because the modal could not be shown):'
              : d.deferralReason === 'restart'
                ? 'Your ForceTheQuestion was answered (Genie restarted while it was pending, so it waited in the user’s inbox):'
                : 'Your ForceTheQuestion was answered:';
    return `${intro}\n\n${lines.join('\n')}\n\n(questionId: ${d.questionId})`;
}

/**
 * The clock every pending question is stamped with. Injectable so the arrival
 * time is assertable without freezing global time (tests install a fake; pass
 * null to restore the real clock).
 */
let questionClock: () => number = () => Date.now();
export function setQuestionClock(fn: (() => number) | null): void {
    questionClock = fn ?? (() => Date.now());
}

/**
 * Where a pending question is WRITTEN DOWN so it outlives this process.
 *
 * The queue below is in memory, and until this existed that was all it was: an
 * upgrade, a crash or a killed process erased every pending question. The agent
 * that asked was left waiting on an answer that could never arrive, and the
 * human never learned a question had existed. Genie upgrades constantly, so this
 * was not a rare edge.
 *
 * Injected (like {@link deferredAnswerSink}) so the queue stays unit-testable
 * without a database; the default is the real genie.db store, so durability does
 * not depend on a composition root remembering to wire it.
 */
let questionStore: QuestionStorePort = dbQuestionStore;
/** Install the durable question store. Pass null to restore the genie.db one. */
export function setQuestionStore(s: QuestionStorePort | null): void {
    questionStore = s ?? dbQuestionStore;
}

/**
 * Whether an answer actually reached the agent that asked for it.
 *
 * The transport (`AgentInboxBroker.deliverHumanMessageToTerminal`) has always
 * been able to say no — it returns false when the terminal has no registered
 * agent identity, because it closed, restarted, or the agent never rejoined. The
 * sink was typed `=> void` and the composition root threw the answer away, so
 * nothing could act on it (genie#482).
 *
 * `reason` is optional because the boolean transport cannot always tell
 * `no-agent` from `refused`; a transport that can distinguish them says so.
 */
export interface AnswerDelivery {
    delivered: boolean;
    reason?: 'no-agent' | 'refused';
}

/**
 * The sink may report the outcome. `void` is still accepted, and read as
 * DELIVERED: a sink that says nothing is not evidence of failure, and warning
 * the user on every answer would be a worse bug than the silence being fixed.
 */
let deferredAnswerSink:
    | ((d: DeferredAnswerDelivery) => AnswerDelivery | void)
    | null = null;
/** Install the deferred-answer delivery sink (composition root → AgentInbox broker).
 *  Pass null to disable delivery (the default; internal gates don't route back). */
export function setDeferredAnswerSink(
    fn: ((d: DeferredAnswerDelivery) => AnswerDelivery | void) | null,
): void {
    deferredAnswerSink = fn;
}

/**
 * Tell the USER that the answer they just gave did not reach anybody.
 *
 * This is the whole point of genie#482. The user answers, the card disappears,
 * and the disappearance IS the confirmation they read — so an answer that landed
 * nowhere is indistinguishable from one that worked, on a surface where they
 * have no other way to find out. The agent cannot tell them: it is precisely the
 * thing that is gone.
 *
 * An OS notification rather than inline text because there are three surfaces
 * that can answer — the always-on-top modal (which closes on answer), the
 * top-bar flyout, and the phone — and only this one reaches all three. It
 * mirrors `notifyForwardedAnswerFailed` in `main/remote/index.ts`, which exists
 * for the same situation over the bridge.
 *
 * Deliberately NOT gated on `notify_toast`: that setting governs ambient
 * chatter, and this is a failure the user has to know about to act on.
 */
function notifyAnswerUndelivered(d: DeferredAnswerDelivery): void {
    const named = d.questions[0]?.header ?? d.questions[0]?.question ?? 'a question';
    try {
        if (!Notification.isSupported()) return;
        new Notification({
            title: 'Genie — answer not delivered',
            body:
                `Your answer to "${named}" was recorded, but the agent that asked ` +
                `is no longer running, so it was not told.`,
        }).show();
    } catch {
        /* best-effort: never let the notice break answering the question */
    }
}

/**
 * Hand an answer to the asking agent, and tell the user if it did not land.
 *
 * The single place both answer paths funnel through — the DND-deferred inbox row
 * and the ordinary modal — so neither can quietly lose the outcome again. A sink
 * that throws counts as undelivered: it must not break answering the question
 * (the old comment was right about that) but it is not success either (the old
 * comment was wrong to stop there).
 *
 * Returns nothing ON PURPOSE. The outcome is CONSUMED here, by the notification,
 * rather than handed back to a caller that would have to remember to look at it
 * — which is the exact failure this whole change is about. Threading it onward
 * so the flyout can also say it inline is a follow-up, and it will replace this
 * signature rather than add a second, ignorable channel.
 */
function deliverAnswer(d: DeferredAnswerDelivery): void {
    if (!deferredAnswerSink) return; // nothing wired to deliver through
    let outcome: AnswerDelivery;
    try {
        const reported = deferredAnswerSink(d);
        outcome = reported && typeof reported === 'object' ? reported : { delivered: true };
    } catch {
        outcome = { delivered: false, reason: 'refused' };
    }
    if (!outcome.delivered) notifyAnswerUndelivered(d);
}

/**
 * DND "deferred" questions — the user is heads-down for this scope, so the modal
 * NEVER pops. The question sits HERE (surfaced in the top-bar inbox via
 * listPendingQuestions) for the user to answer at leisure; the agent already got
 * the DND notice back. Kept OUT of the modal `queue` so it can't disturb the
 * head/window-close invariants.
 */
interface DeferredQuestion {
    id: string;
    /** The derived re-attach key — present only for a question that was stored
     *  (i.e. one with an asking terminal). See {@link deriveAskKey}. */
    askKey?: string;
    questions: ForceQuestion[];
    workspaceLabel?: string;
    /** The asking workspace's id — stored so a rebuilt question still knows it. */
    workspaceId?: string;
    /** The workspace's local root — the file drawer resolves named paths against
     *  it (Tynn #272). Absent for a forwarded question: that path is on the HOST. */
    workspacePath?: string;
    priority?: QuestionPriority;
    remoteHost?: string;
    /** When the question ARRIVED (ms epoch) — stamped as it's deferred, so the
     *  inbox can say how long it has been waiting. A deferred question waits
     *  longest of all, which is exactly when "came in 3h ago" matters. */
    createdAt?: number;
    /**
     * Present ONLY for a FORWARDED DND deferral (a remote host the driver set to
     * DND). Its promise is still LIVE: answering it from the inbox must resolve
     * WITH the answer so the remote bridge POSTs it back to the host, and a
     * host-first resolution (`dismissForwardedQuestion`) must cancel it.
     */
    resolve?: (r: ForceQuestionResult) => void;
    forward?: { connKey: string; hostId: string };
    /**
     * A LOCAL deferral's delivery handle: the asking agent's terminal id. The
     * agent's ForceTheQuestion call already returned the deferred notice, so the
     * late flyout answer is delivered to THIS terminal's AgentInbox (ping/poll/pull)
     * via {@link deferredAnswerSink} — no longer dropped. Absent for an internal
     * gate (no MCP asker) or a forwarded question (which uses `resolve`).
     */
    askerTerminalId?: string;
    /**
     * WHY this row landed in the inbox instead of a modal — carried through to
     * {@link DeferredAnswerDelivery} so the late "it was answered" message can
     * tell the truth instead of assuming DND (genie #315). `'dnd'` for a genuine
     * DND parking, `'unshowable'` when the modal itself could not be raised.
     * Absent for a forwarded row (its own message lives on the remote driver).
     */
    deferralReason?: DeferralReason;
}
const deferred: DeferredQuestion[] = [];

/**
 * ForceTheQuestion — an OS-level, always-on-top modal an agent can raise to ask
 * the user one or more questions and block until they answer. Distinct from the
 * imDone glow (passive) and the in-window quit dialog (Genie-scoped): this
 * window floats above EVERY application (`screen-saver` z-level) so the user
 * can't miss it.
 *
 * Genie is multi-agent, so several agents can call ForceTheQuestion at once. We
 * present them ONE AT A TIME via a FIFO queue through a SINGLE shared window:
 * the first request opens the window, later requests enqueue, and each
 * answer/cancel/dismiss advances to the next. Each `forceQuestion(...)` call
 * still returns its OWN promise that resolves with THAT request's result, so the
 * MCP `tools/call` per-caller await is preserved. The request id rides in
 * `ask:show` (along with how many more are queued); the renderer replies with
 * `ask:answer` / `ask:cancel`, and closing the window counts as cancelling the
 * whole queue.
 */

interface Config {
    isDev: boolean;
    preloadPath: string;
    /** The master window (the only `notify:sound` subscriber), or null when
     *  tray-resident. Injected so the chime targets it instead of an arbitrary
     *  window (e.g. the ask modal, which doesn't subscribe). */
    getMasterWindow: () => BrowserWindow | null;
}

/** One queued ForceTheQuestion request awaiting (or currently taking) its turn. */
interface QueueItem {
    id: string;
    /** The derived re-attach key — present only for a question that was stored
     *  (i.e. one with an asking terminal). See {@link deriveAskKey}. */
    askKey?: string;
    resolve: (r: ForceQuestionResult) => void;
    questions: ForceQuestion[];
    workspaceLabel?: string;
    /** The asking workspace's id — stored so a rebuilt question still knows it. */
    workspaceId?: string;
    /** The workspace's local root — the file drawer resolves named paths against
     *  it (Tynn #272). Absent for a forwarded question: that path is on the HOST,
     *  so the drawer stays shut rather than reading a same-named local file. */
    workspacePath?: string;
    /** PendingQuestions v2 — orders the queue (default 'normal'). Higher priority
     *  is answered sooner but never preempts the shown head. */
    priority?: QuestionPriority;
    /**
     * Set when this is a host question FORWARDED to a remote driver (its modal
     * pops in the remote Genie). Carries the originating connection + the HOST's
     * pending-question id so the host can dismiss it (first-answer-wins) and so
     * the driver's answer routes back over the bridge instead of resolving a
     * local agent's promise.
     */
    forward?: { connKey: string; hostId: string; hostLabel?: string };
    /** When the question ARRIVED (ms epoch), stamped in `enqueue`. For a FORWARDED
     *  question this is the HOST's stamp when it sent one, so the driver sees when
     *  the agent actually asked rather than when we picked it up. */
    createdAt?: number;
    /** The asking agent's terminal — carried so that if the modal CAN'T be shown
     *  (createAskWindow throws) the question defers with a delivery handle, exactly
     *  like the DND path. Absent for an internal gate / forwarded question. */
    askerTerminalId?: string;
}

/**
 * Play the distinct ForceTheQuestion chime (gated by Settings → notify_sound).
 * Mirrors notifyImDone: send `notify:sound` to ONE live renderer so the chime
 * plays once; the renderer branches on `kind` to a more urgent motif.
 */
function notifyForceQuestion(): void {
    // Demand OS-level attention for the (local) master window hosting the asking
    // workspace, when it isn't focused — fired FIRST so it runs regardless of
    // the sound toggle, like the glow. The modal itself floats above every app;
    // this additionally flashes the taskbar / bounces the dock.
    demandWindowAttention(config?.getMasterWindow() ?? null);
    playForceQuestionChime();
}

/**
 * Play the FTQ chime ONLY — no window-attention / focus steal. Split out of
 * notifyForceQuestion so the DND path can give an AUDIBLE cue that a question
 * landed WITHOUT popping the modal or stealing focus (so a fullscreen game isn't
 * yanked out) when the owner opts in via `ftq_dnd_sound`. Gated by notify_sound
 * like every other chime; a null descriptor / unreadable settings → silent.
 */
function playForceQuestionChime(): void {
    // Master switch, this alert's own choice, delivery to the master renderer —
    // the same gate all eight alert kinds go through (genie#546). It never
    // throws: unreadable settings are silent, and a chime must never be able to
    // block the modal it is announcing.
    playAlertSound('forceQuestion', config?.getMasterWindow() ?? null);
}

/** True when the owner opted to still HEAR a question land while in DND (the chime
 *  plays, but the focus-stealing modal never pops). Fail-safe silent on error. */
function dndSoundEnabled(): boolean {
    try {
        return getAllSettings().ftq_dnd_sound === 'on';
    } catch {
        return false;
    }
}

let config: Config | null = null;
let registered = false;

/** The single shared modal window, or null when nothing is being asked. */
let win: BrowserWindow | null = null;
/** FIFO queue. The head (index 0) is the request currently shown in the window. */
const queue: QueueItem[] = [];

/**
 * Subscribers notified whenever the pending-question set changes (a question is
 * enqueued in forceQuestion, or removed in finish). The mobile server registers
 * one of these so it can push question:new / question:resolved to `/ws/events`.
 * Module-private; fired AFTER the queue mutation so a listener that reads
 * listPendingQuestions() sees the new state.
 */
const questionChangeListeners = new Set<() => void>();

function notifyQuestionsChanged(): void {
    for (const cb of questionChangeListeners) {
        try {
            cb();
        } catch {
            /* a listener throwing must never disturb the modal path */
        }
    }
}

/**
 * One pending ForceTheQuestion as the mobile server / API exposes it — the same
 * id + questions + workspaceLabel the desktop modal renders, plus a `queued`
 * timestamp so the phone can order them. Mirrors payloadFor() minus the live
 * "N behind" badge (the phone shows the whole list).
 */
export interface PendingQuestion {
    id: string;
    questions: ForceQuestion[];
    workspaceLabel?: string;
    /** The workspace's local root, when this question was raised locally — the
     *  modal's file drawer resolves a path the question names against it (Tynn
     *  #272). Absent for a FORWARDED question: that path is on the host. */
    workspacePath?: string;
    /** Position in the queue (0 = currently shown on the desktop). Already ordered
     *  by priority (v2), so index reflects answer order. */
    index: number;
    /** PendingQuestions v2 — the request's priority (default 'normal'), for the
     *  queue view to badge + the client to sort. */
    priority?: QuestionPriority;
    /** v2 §8 attribution — the remote host this question was FORWARDED from (its
     *  display name), or undefined for a LOCAL question. The queue view labels it so
     *  a host's question is never shown as if it were local. */
    remoteHost?: string;
    /** PendingQuestions UX — true for a DND-DEFERRED question: it never popped a
     *  modal (the user was heads-down), it's here to answer at leisure. The inbox
     *  styles it without the blocking-modal urgency. */
    deferred?: boolean;
    /**
     * When the question ARRIVED (ms epoch), stamped at enqueue — so the inbox can
     * say "came in 5m ago" instead of leaving the owner guessing whether an agent
     * has been blocked for seconds or all afternoon. Locally-raised questions
     * always carry it; a question FORWARDED from a host on an older build has
     * none, so consumers must degrade (show nothing) rather than assume epoch 0.
     */
    createdAt?: number;
}

/**
 * Snapshot the pending questions for the top-bar inbox / mobile `/api/questions` +
 * bootstrap. Read-only. The MODAL queue (blocking, one-at-a-time) comes first in
 * FIFO/priority order, then the DND-DEFERRED questions (answered at leisure).
 */
export function listPendingQuestions(): PendingQuestion[] {
    const active: PendingQuestion[] = queue.map((item, index) => ({
        id: item.id,
        questions: item.questions,
        workspaceLabel: item.workspaceLabel,
        workspacePath: item.workspacePath,
        index,
        priority: item.priority,
        remoteHost: item.forward?.hostLabel,
        createdAt: item.createdAt,
    }));
    const dnd: PendingQuestion[] = deferred.map((d, i) => ({
        id: d.id,
        questions: d.questions,
        workspaceLabel: d.workspaceLabel,
        workspacePath: d.workspacePath,
        index: queue.length + i,
        priority: d.priority,
        remoteHost: d.remoteHost,
        deferred: true,
        createdAt: d.createdAt,
    }));
    return [...active, ...dnd];
}

/**
 * Answer a pending question from the mobile phone. Routes through the SAME
 * private finish(id, …) the desktop's `ask:answer` uses, so the blocked agent
 * unblocks AND the desktop modal advances/closes exactly as if answered locally.
 * Returns false when `id` is unknown — the benign phone-after-desktop race (the
 * desktop already answered it), surfaced to the phone as "already answered".
 */
export function answerPendingQuestion(
    id: string,
    answers: ForceAnswer[],
): boolean {
    if (queue.some((q) => q.id === id)) {
        finish(id, { cancelled: false, answers: answers ?? [] });
        return true;
    }
    // A DND-deferred question. A FORWARDED deferral carries a live `resolve` —
    // answering it resolves the bridged promise WITH the answer, so the remote
    // bridge POSTs it back to the host. A LOCAL deferral (an MCP ForceTheQuestion
    // whose caller already returned the deferred notice) instead carries the asking
    // terminal: deliver the answer to THAT agent's AgentInbox (ping/poll/pull) so a
    // deferred question is no longer a dead end. An internal gate has neither → the
    // row just clears.
    const di = deferred.findIndex((d) => d.id === id);
    if (di !== -1) {
        const [d] = deferred.splice(di, 1);
        d.resolve?.({ cancelled: false, answers: answers ?? [] });
        // DELIVER FIRST, forget second. This ran the other way round, and doing
        // the irreversible thing before the reportable one is how the outcome
        // became unobservable: by the time delivery failed the durable row was
        // already gone, so there was nothing left to act on (genie#482).
        if (d.askerTerminalId) {
            deliverAnswer({
                terminalId: d.askerTerminalId,
                questionId: d.id,
                questions: d.questions,
                answers: answers ?? [],
                deferralReason: d.deferralReason,
            });
        }
        // Forgotten either way, INCLUDING when delivery failed. Keeping the row
        // would preserve the prompt and discard the reply: it is gone from the
        // flyout regardless, the next boot's `canDeliverTo` drops it for the very
        // condition that failed delivery, and if the agent did come back the user
        // would be re-asked something they had already answered — with the first
        // answer lost, because only the question is durable and the answer never
        // was. The missing thing is the report, not the retention. Keeping the
        // answer instead is genie#484.
        forget(d.id);
        notifyQuestionsChanged();
        return true;
    }
    return false;
}

/**
 * Write one question down so it survives this process.
 *
 * Only a question with BOTH an `askKey` and an `askerTerminalId` is stored, and
 * that pair is the whole eligibility rule: the key makes it re-joinable, and the
 * terminal is where an answer can still be delivered after a restart. Everything
 * else is deliberately NOT durable —
 *
 *  - an INTERNAL approval gate (a process run, a plugin consent) holds an
 *    in-process promise that dies with the process. Rebuilding it would put a
 *    question in front of the human for an operation nobody is waiting on;
 *  - a FORWARDED host question belongs to a live bridge connection. There is
 *    nothing to POST an answer back through after a restart, and the host
 *    re-forwards its own pending questions when the bridge reconnects, so a
 *    stored copy could only become a duplicate that resolves nothing.
 */
function persist(
    q: { id: string; askKey?: string; askerTerminalId?: string } & Omit<
        PersistedQuestion,
        'id' | 'askKey' | 'terminalId'
    >,
): void {
    if (!q.askKey || !q.askerTerminalId) return;
    questionStore.save({
        id: q.id,
        askKey: q.askKey,
        terminalId: q.askerTerminalId,
        questions: q.questions,
        workspaceId: q.workspaceId,
        workspaceLabel: q.workspaceLabel,
        workspacePath: q.workspacePath,
        priority: q.priority,
        deferred: q.deferred,
        deferralReason: q.deferralReason,
        createdAt: q.createdAt,
    });
}

/** Forget a stored question — it was answered, cancelled or retracted. A no-op
 *  for the questions that were never stored. */
function forget(id: string): void {
    questionStore.remove(id);
}

/**
 * The pending question this agent already raised with this exact content, if it
 * is still waiting. Searched across BOTH surfaces — the modal queue and the
 * inbox — because which one it landed in is the user's availability setting, not
 * something the reconnecting agent knows or should have to.
 */
function findByAskKey(askKey: string): string | undefined {
    return (
        queue.find((q) => q.askKey === askKey)?.id ??
        deferred.find((d) => d.askKey === askKey)?.id
    );
}

/**
 * Rebuild the pending queue from the database after a restart.
 *
 * Restored questions land in the INBOX, never the modal, even for a user who is
 * Available. Boot is the worst moment to throw always-on-top windows at someone:
 * they may not be at the machine, there may be several, and the agents that
 * asked were already told their answers arrive through AgentInbox — so the
 * inbox is where those questions were always going to be answered from.
 *
 * `canDeliverTo` decides whether a stored question comes back at all. A question
 * whose terminal no longer exists is DROPPED — deleted, not parked — because
 * asking the human for an answer that has nowhere to go is precisely the failure
 * `forceQuestionRefusal` already refuses at ask time (genie#321); putting it in
 * the inbox would spend their attention on an answer that gets discarded, and
 * leaving the row would re-offer it on every boot from now on.
 *
 * A question whose terminal IS still there is kept however old it is. Age alone
 * is not evidence that a decision stopped mattering, and the inbox already shows
 * how long each one has been waiting — so the human retires it, not a timer.
 *
 * A `canDeliverTo` that THROWS means "cannot tell", which is not the same answer
 * as `false` and must not be treated as one: dropping is permanent, and losing a
 * real pending question to a transient lookup failure is the exact harm this
 * whole path exists to undo. Such a row is left in the database, undecided, for
 * the next boot to judge.
 *
 * Idempotent: a question already in memory is left alone, so calling this twice
 * cannot double it.
 */
export function rehydratePendingQuestions(
    canDeliverTo: (terminalId: string) => boolean,
): { restored: number; dropped: number } {
    let restored = 0;
    let dropped = 0;
    for (const row of questionStore.load()) {
        if (queue.some((q) => q.id === row.id) || deferred.some((d) => d.id === row.id)) continue;
        let deliverable: boolean;
        try {
            deliverable = canDeliverTo(row.terminalId);
        } catch {
            continue; // cannot tell — leave the row for the next boot to decide
        }
        if (!deliverable) {
            forget(row.id);
            dropped += 1;
            continue;
        }
        deferred.push({
            id: row.id,
            askKey: row.askKey,
            questions: row.questions,
            workspaceLabel: row.workspaceLabel,
            workspaceId: row.workspaceId,
            workspacePath: row.workspacePath,
            priority: row.priority,
            createdAt: row.createdAt,
            askerTerminalId: row.terminalId,
            // Not the reason it was originally parked (it may never have been
            // parked at all — it could have been a live modal). This is why the
            // answer is arriving LATE now, which is the part the agent needs to
            // be told truthfully (genie#315).
            deferralReason: 'restart',
        });
        // Re-save so the stored row matches what is now in memory: a question
        // that was a live modal before the restart is an inbox row after it.
        persist({
            id: row.id,
            askKey: row.askKey,
            askerTerminalId: row.terminalId,
            questions: row.questions,
            workspaceId: row.workspaceId,
            workspaceLabel: row.workspaceLabel,
            workspacePath: row.workspacePath,
            priority: row.priority,
            deferred: true,
            deferralReason: 'restart',
            createdAt: row.createdAt,
        });
        restored += 1;
    }
    if (restored) notifyQuestionsChanged();
    return { restored, dropped };
}

/** Subscribe to pending-question changes (mobile push). Returns an unsubscribe. */
export function onQuestionsChanged(cb: () => void): () => void {
    questionChangeListeners.add(cb);
    return () => questionChangeListeners.delete(cb);
}

/**
 * Seed a pending question WITHOUT opening the desktop modal (test-only). Enqueues
 * an item exactly as `forceQuestion` would (same id format, fires
 * notifyQuestionsChanged), so it appears in `listPendingQuestions()` and unblocks
 * through the normal `answerPendingQuestion` → `finish` path — but never creates a
 * BrowserWindow, so the mobile E2E harness can exercise the Questions flow with no
 * stray window. Returns the new question id. Used only by main/e2e/mock.ts (gated
 * on GENIE_E2E).
 */
export function _seedPendingQuestionForTest(
    questions: ForceQuestion[],
    workspaceLabel?: string,
): string {
    const id = crypto.randomBytes(9).toString('hex');
    queue.push({ id, resolve: () => {}, questions, workspaceLabel, createdAt: questionClock() });
    notifyQuestionsChanged();
    return id;
}

/** Build the payload the renderer renders, including how many requests follow. */
function payloadFor(item: QueueItem): {
    id: string;
    questions: ForceQuestion[];
    workspaceLabel?: string;
    workspacePath?: string;
    queued: number;
} {
    return {
        id: item.id,
        questions: item.questions,
        workspaceLabel: item.workspaceLabel,
        workspacePath: item.workspacePath,
        // How many OTHER requests are still waiting behind the current one.
        queued: Math.max(0, queue.length - 1),
    };
}

/**
 * Push the WHOLE pending queue to the ask window (PendingQuestions v2 — the
 * user-controlled queue view). Sent alongside `ask:show` so the renderer can list
 * every pending request (priority-badged, with its workspace label) and let the
 * user pick which to answer next / defer / dismiss. No-op when the window is down.
 */
function pushQueue(): void {
    // The queue is the list of questions that still exist, so this is where the
    // draft store learns what to forget. Questions also leave by routes that
    // never touch this process -- retracted by their agent, answered on the
    // phone, resolved by the host first -- and without a prune the store grows
    // without bound and a recycled id hands someone a stranger's half-answer.
    const pending = listPendingQuestions();
    try {
        const drafts = readDrafts();
        const pruned = pruneDrafts(drafts, pending.map((q) => q.id));
        if (Object.keys(pruned).length !== Object.keys(drafts).length) writeDrafts(pruned);
    } catch {
        /* Housekeeping must never take the queue push down with it. This runs on
           the path that SHOWS a question, and the store is reachable only through
           settings -- which is not initialised in every context that raises one.
           Losing a draft is bad; losing the question is worse. */
    }
    if (win && !win.isDestroyed()) {
        win.webContents.send('ask:queue', { pending });
    }
}

/** Push the current head's payload + the full queue to the renderer (no-op if
 *  nothing pending). */
function showHead(): void {
    const head = queue[0];
    if (head && win && !win.isDestroyed()) {
        win.webContents.send('ask:show', payloadFor(head));
        pushQueue();
    }
}

/**
 * Resolve the request with the given id and advance the queue. If it was the
 * head (the shown one), reveal the next request in the same window, or close
 * the window when the queue drains. Resolving a NON-head id (rare) just removes
 * it without disturbing what's shown.
 */
function finish(id: string, result: ForceQuestionResult): void {
    const idx = queue.findIndex((q) => q.id === id);
    if (idx === -1) return;
    const [item] = queue.splice(idx, 1);
    // Answered or cancelled, the draft has done its job. Dropping it here
    // covers every route out -- the modal, the flyout, the phone, and a host
    // question resolved first -- because they all land in finish().
    forgetDraft(item.id);
    // `resolve` is what hands the answer to the asking agent (see the closure in
    // raiseDesktopModal), so it runs BEFORE the durable row is dropped — same
    // ordering rule as the deferred path, and for the same reason: destroying
    // the record first is what left a failed delivery with nothing to act on.
    item.resolve(result);
    // Resolved, so the next boot must not raise it again.
    forget(item.id);
    // A pending question was removed — tell the mobile push channel so it can
    // emit question:resolved. Fires for BOTH head and queued removals.
    notifyQuestionsChanged();

    // Only the head drives the window. If a queued (not-yet-shown) item was
    // resolved, the shown question is unchanged — but the queue LIST shrank, so
    // refresh it (v2) and leave the current view alone.
    if (idx !== 0) {
        pushQueue();
        return;
    }

    if (queue.length === 0) {
        // Nothing left — close the shared window. The `closed` handler is a
        // no-op now that the queue is empty.
        if (win && !win.isDestroyed()) win.close();
        win = null;
        return;
    }
    showHead();
}

/** Find the queued request whose window owns the given webContents id. */
function itemBySender(senderId: number): QueueItem | undefined {
    if (!win || win.isDestroyed() || win.webContents.id !== senderId) return undefined;
    return queue[0];
}

/** Register the ask IPC handlers + capture window config. Idempotent. */
/**
 * The part-typed answers, in settings so they survive a window being destroyed
 * AND an app restart. Someone who steps away mid-answer to check something is
 * exactly as likely to close Genie as to close the modal.
 */
const DRAFTS_SETTING = 'ask_drafts';

function readDrafts(): AskDraftStore {
    try {
        return parseDraftStore(
            (getAllSettings() as Record<string, string | undefined>)[DRAFTS_SETTING],
        );
    } catch {
        return {};
    }
}

function writeDrafts(store: AskDraftStore): void {
    try {
        setSettings({ [DRAFTS_SETTING]: serializeDraftStore(store) } as never);
    } catch {
        /* a lost draft must never take the question down with it */
    }
}

/** Forget one question's draft — it has been answered or cancelled. */
function forgetDraft(id: string): void {
    const store = readDrafts();
    if (!(id in store)) return;
    writeDrafts(dropDraft(store, id));
}

export function registerForceQuestionIpc(cfg: Config): void {
    config = cfg;
    if (registered) return;
    registered = true;

    // A part-typed answer, so closing the modal or the flyout does not discard
    // it. Both surfaces read and write the SAME entry, keyed by question id, so
    // an answer begun in one is finished in the other.
    ipcMain.handle('ask:draft:get', (_e, id: string) => readDrafts()[id] ?? null);
    ipcMain.handle('ask:draft:set', (_e, id: string, entry: AskDraftEntry) => {
        writeDrafts(putDraft(readDrafts(), id, entry));
    });

    ipcMain.handle('ask:answer', (_e, id: string, answers: ForceAnswer[]) => {
        finish(id, { cancelled: false, answers: answers ?? [] });
    });
    ipcMain.handle('ask:cancel', (_e, id: string) => {
        finish(id, { cancelled: true, answers: [] });
    });
    // The renderer signals it has attached its `ask:show` listener. Deliver the
    // current head NOW (race-free) — pushing on did-finish-load could fire
    // before the React effect registers the listener, leaving the modal stuck
    // "Waiting…".
    ipcMain.handle('ask:ready', (e) => {
        if (win && !win.isDestroyed() && win.webContents.id === e.sender.id) showHead();
    });
    // Dismiss the current question regardless of state (works even before the
    // payload loads — the loading view's only escape). Resolves the SHOWN
    // request as cancelled and advances to the next queued one.
    ipcMain.handle('ask:dismiss', (e) => {
        const item = itemBySender(e.sender.id);
        if (item) finish(item.id, { cancelled: true, answers: [] });
    });
    // The file drawer opened or closed (Tynn #272). It sits BESIDE the question,
    // never over it, so the window has to grow — and shrink back — rather than
    // the question giving up half its width to a file it is only referring to.
    ipcMain.handle('ask:drawer', (e, open: boolean) => {
        setAskDrawerOpen(e.sender.id, !!open);
    });
}

/**
 * Widen (or narrow) the ask window for the file drawer, keeping the whole thing
 * on the display it is on. Only the window that ASKED is resized — a stale
 * renderer from a closed modal must not move the live one.
 */
function setAskDrawerOpen(senderId: number, open: boolean): void {
    if (!win || win.isDestroyed() || win.webContents.id !== senderId) return;
    try {
        const current = win.getBounds();
        const workArea = screen.getDisplayMatching(current).workArea;
        // The modal is deliberately NOT user-resizable (nothing about a question
        // wants a drag handle), and a non-resizable window can refuse a
        // programmatic resize. Lift it for the one call, then put it back — the
        // user never gets a grab edge either way.
        const resizable = win.isResizable();
        if (!resizable) win.setResizable(true);
        win.setBounds(askWindowBounds({ current, workArea, drawerOpen: open }));
        if (!resizable) win.setResizable(false);
    } catch {
        /* No display / a screen module that throws under test: the drawer still
           renders, just in the width the window already has. Never take the
           question down over a resize. */
    }
}

function createAskWindow(): BrowserWindow {
    if (!config) throw new Error('ForceTheQuestion IPC not registered');
    const w = new BrowserWindow({
        width: ASK_MODAL_WIDTH,
        height: 560,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        center: true,
        backgroundColor: '#0a0a0c',
        title: 'Genie — a question for you',
        webPreferences: {
            preload: config.preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    // Float above full-screen apps and other always-on-top windows, then grab
    // focus so the user lands on the modal immediately.
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // A link in the question markdown must NEVER navigate this frameless modal
    // (that turned it into a browser tab and stranded the question). Route it: a
    // `.gen` link opens in the Genie Browser (unless it's turned off), everything
    // else in the machine browser.
    wireAskLinkRouting(w.webContents, {
        genieBrowserEnabled: () => {
            try {
                return getAllSettings().genie_browser_enabled !== 'off';
            } catch {
                return true;
            }
        },
        openExternal: (url) => void shell.openExternal(url).catch(() => {}),
        openGenieBrowser: (url) =>
            void openTestingBrowser(LOCAL_CONN_KEY, 'This machine', url).catch(() => {}),
    });

    if (config.isDev) {
        w.loadURL('http://localhost:8888/ask');
    } else {
        w.loadFile(path.join(__dirname, 'ask.html'));
    }
    w.once('ready-to-show', () => {
        w.show();
        w.focus();
    });
    // A close without an answer (window control, OS, or our own teardown when
    // the queue drains) cancels EVERY still-queued request so no caller hangs.
    w.on('closed', () => {
        if (win === w) win = null;
        const dropped = queue.splice(0, queue.length);
        for (const item of dropped) {
            // Cancelled deliberately (the user shut the window on them), so the
            // durable copies go too — resurrecting these would re-ask questions
            // they have already declined to answer.
            forget(item.id);
            item.resolve({ cancelled: true, answers: [] });
        }
        // The whole queue was cancelled — push the cleared state to the mobile
        // channel too (one notify covers the batch).
        if (dropped.length) notifyQuestionsChanged();
    });
    return w;
}

/**
 * Raise the modal and resolve with the user's answers. Concurrent calls queue:
 * each resolves with ITS OWN result when its turn is answered or dismissed.
 * Resolves cancelled if the window is closed before this request is answered.
 */
/**
 * Enqueue a question item and raise (or refresh) the shared modal. The single
 * choke point both the LOCAL `forceQuestion` and the FORWARDED (remote-driver)
 * path funnel through, so the FIFO queue + single-window invariant hold across
 * both. On a window-open failure the item is dropped and resolved cancelled.
 */
/**
 * Which workspace row shows the yellow `?` for a raised question — or null.
 *
 * PURE, and exported, because `enqueue` cannot run without a real BrowserWindow
 * and the rule has a branch worth proving. Same pattern as `tailscale-panel.ts`:
 * the decision lives where it can be tested, the caller applies it.
 *
 * A FORWARDED question is refused deliberately. It was raised by an agent on the
 * HOST, whose own `agent-pulse` already reaches this window through
 * PASSTHROUGH_EVENTS — so marking it here as well would draw the same question
 * twice, once from the host and once from a local re-derivation of it. Host
 * events belong to the host (genie#473 is the same lesson from the other side).
 */
export function questionMarkWorkspace(item: {
    workspaceId?: string;
    forward?: unknown;
}): string | null {
    if (item.forward) return null;
    const ws = (item.workspaceId ?? '').trim();
    return ws ? ws : null;
}

/** Sink for the raised-question marker. Installed at boot; absent in tests and
 *  on a headless host, where there is no row to draw on. */
let questionMarkSink: ((workspaceId: string) => void) | null = null;
export function setQuestionMarkSink(fn: ((workspaceId: string) => void) | null): void {
    questionMarkSink = fn;
}

function enqueue(item: QueueItem): ForceQuestionResult | undefined {
    // Stamp the ARRIVAL here — the single choke point every question funnels
    // through — so the inbox reports when it came in, not when it was read. A
    // forwarded question arrives with the HOST's stamp; keep it.
    item.createdAt ??= questionClock();
    // First in line opens the shared window; later ones enqueue BY PRIORITY (v2)
    // and wait their turn — a higher-priority arrival jumps ahead of lower-priority
    // waiters but never preempts the shown head (the window reuses each in turn).
    const startsQueue = queue.length === 0;
    insertByPriority(queue, item);
    // The workspace row says an agent here is waiting on a person. Raised at the
    // single choke point every question funnels through, so the DND path, the
    // unshowable path and the ordinary modal all mark once and identically.
    const markWs = questionMarkWorkspace(item);
    if (markWs) {
        try {
            questionMarkSink?.(markWs);
        } catch {
            /* best-effort — a marker must never take a question down with it */
        }
    }
    // A new pending question — tell the mobile/remote push channel (question:changed).
    notifyQuestionsChanged();

    if (!startsQueue) {
        // A modal is already up, and the HEAD is untouched (insertByPriority never
        // displaces it) — so push the QUEUE only. Re-sending `ask:show` here would
        // tell the renderer the shown question changed when it hasn't; that yanked
        // a user who was part-way through answering a queued request back to the
        // head and discarded what they had typed (genie#156). This item shows when
        // its turn comes; until then the new arrival is visible in the queue strip.
        pushQueue();
        return undefined;
    }

    try {
        win = createAskWindow();
    } catch {
        // The modal could NOT be displayed (window creation failed / no display).
        // The user never saw it — so do NOT report a false "dismissed" (which reads
        // to the agent as a deliberate refusal). Move the question to the inbox
        // (deferred) so it stays answerable, and hand the agent a clear notice.
        const idx = queue.indexOf(item);
        if (idx !== -1) queue.splice(idx, 1);
        deferred.push({
            id: item.id,
            askKey: item.askKey,
            questions: item.questions,
            workspaceLabel: item.workspaceLabel,
            workspaceId: item.workspaceId,
            workspacePath: item.workspacePath,
            priority: item.priority,
            createdAt: item.createdAt,
            askerTerminalId: item.askerTerminalId,
            deferralReason: 'unshowable',
        });
        // It moved from the modal queue to the inbox; the stored row follows, so
        // a restart rebuilds it as what it actually is now.
        persist({
            id: item.id,
            askKey: item.askKey,
            askerTerminalId: item.askerTerminalId,
            questions: item.questions,
            workspaceId: item.workspaceId,
            workspaceLabel: item.workspaceLabel,
            workspacePath: item.workspacePath,
            priority: item.priority,
            deferred: true,
            deferralReason: 'unshowable',
            createdAt: item.createdAt ?? questionClock(),
        });
        notifyQuestionsChanged();
        const failure: ForceQuestionResult = {
            cancelled: true,
            answers: [],
            deferred: true,
            questionId: item.id,
            dndMessage:
                'the question could not be shown right now — it is waiting in the user’s inbox; the answer will be delivered to your AgentInbox',
        };
        item.resolve(failure);
        return failure;
    }
    // Distinct chime so the user can tell ForceTheQuestion from imDone by ear.
    notifyForceQuestion();

    // Primary delivery is the renderer's `ask:ready` handshake (race-free). Also
    // push on load as a best-effort fallback; the renderer dedupes.
    const w = win;
    if (w.webContents.isLoading()) {
        w.webContents.once('did-finish-load', () => showHead());
    } else {
        showHead();
    }
    return undefined;
}

/** The DESKTOP question transport: raise the BrowserWindow modal (the FIFO
 *  queue + `createAskWindow`). This is the GUI-coupled path the headless build
 *  must NOT run — it's behind the injected QuestionTransport port. */
function raiseDesktopModal(
    questions: ForceQuestion[],
    workspaceLabel?: string,
    priority?: QuestionPriority,
    scope?: QuestionScope,
    askerTerminalId?: string,
): Promise<ForceQuestionResult> {
    return new Promise((resolve) => {
        const id = crypto.randomBytes(9).toString('hex');
        // The RE-ATTACH key, derived from the asking terminal plus the question
        // content — never taken from the caller (see `ask-key.ts` for why that
        // is a safety property and not a preference). An internal gate has no
        // terminal, so it has no key and never rejoins: two identical approval
        // prompts really are two decisions, each with its own caller waiting.
        const askKey = askerTerminalId ? deriveAskKey(askerTerminalId, questions) : undefined;
        if (askKey) {
            // This agent already has this exact question pending. Hand back the
            // SAME question rather than raising a second one: an ask that was
            // cut off — a dropped MCP session, a restart — used to leave the
            // agent no choice but to re-ask, and the user saw the re-ask as a
            // separate question they had to answer twice.
            const existingId = findByAskKey(askKey);
            if (existingId) {
                resolve({
                    cancelled: true,
                    answers: [],
                    deferred: true,
                    questionId: existingId,
                    dndMessage:
                        'you had already asked this — you have re-joined the question you raised earlier ' +
                        'rather than raising a second one, and it is still waiting for the user',
                });
                return;
            }
        }
        const decision = availabilityReader(scope ?? {});
        // The workspace this question came from, so the modal's file drawer can
        // open a path the question NAMES (Tynn #272). Resolved once, here, where
        // the scope is in hand.
        const workspacePath = scope?.workspaceId
            ? workspacePathReader(scope.workspaceId)
            : undefined;
        if (decision.availability === 'dnd') {
            // DND for this scope: NEVER pop the modal or steal focus. Park the question
            // in the top-bar inbox (deferred) to answer at leisure. Record the asking
            // terminal so the eventual flyout answer is delivered back to that agent's
            // AgentInbox (ping/poll/pull) — a deferred ForceTheQuestion is NOT a dead
            // end. Resolve NOW (never block) with the notice + questionId so the agent
            // knows to pull the answer later. `cancelled: true` marks "not inline".
            const createdAt = questionClock();
            deferred.push({
                id,
                askKey,
                questions,
                workspaceLabel,
                workspaceId: scope?.workspaceId,
                workspacePath,
                priority,
                createdAt,
                askerTerminalId,
                deferralReason: 'dnd',
            });
            // Written down while it is raised, not when it is answered — a
            // question the user has not got to yet is exactly the one a restart
            // used to erase.
            persist({
                id,
                askKey,
                askerTerminalId,
                questions,
                workspaceId: scope?.workspaceId,
                workspaceLabel,
                workspacePath,
                priority,
                deferred: true,
                deferralReason: 'dnd',
                createdAt,
            });
            // Opt-in AUDIBLE cue: a chime (no modal, no focus steal) so the owner
            // knows a question landed while heads-down — the whole point of DND is to
            // stop focus theft, not to go silent.
            if (decision.availability === 'dnd' ? dndSoundEnabled() : true) {
                playForceQuestionChime();
            }
            notifyQuestionsChanged();
            resolve({
                cancelled: true,
                answers: [],
                deferred: true,
                questionId: id,
                dndMessage: askerTerminalId
                    ? deferredAgentMessage(decision)
                    : decision.dndMessage,
            });
            return;
        }
        if (askerTerminalId) {
            // Available agents use the same asynchronous answer transport as DND,
            // but availability still controls ATTENTION: show the always-on-top
            // modal now. The tool call returns immediately and the eventual answer
            // is force-pushed through AgentInbox to the asking terminal.
            //
            // Written down BEFORE the window goes up: the gap this closes is a
            // question raised and then lost to an upgrade, so the durable copy
            // has to exist before anything can go wrong. `enqueue` re-saves it as
            // deferred if the modal turns out to be unshowable.
            const createdAt = questionClock();
            persist({
                id,
                askKey,
                askerTerminalId,
                questions,
                workspaceId: scope?.workspaceId,
                workspaceLabel,
                workspacePath,
                priority,
                deferred: false,
                createdAt,
            });
            const failure = enqueue({
                id,
                askKey,
                questions,
                workspaceLabel,
                workspaceId: scope?.workspaceId,
                workspacePath,
                priority,
                createdAt,
                askerTerminalId,
                resolve: (lateResult) => {
                    // enqueue already moved an unshowable question into `deferred`;
                    // its eventual inbox answer owns delivery in that case.
                    if (lateResult.deferred) return;
                    // The ORDINARY modal answer — the common path, and it had the
                    // same swallow as the DND one (genie#482). It went through a
                    // bare try/catch that was right about never breaking the modal
                    // queue and wrong about never reporting: an answer the agent
                    // never received looked exactly like one it did.
                    deliverAnswer({
                        terminalId: askerTerminalId,
                        questionId: id,
                        questions,
                        answers: lateResult.answers ?? [],
                    });
                },
            });
            if (failure) {
                resolve(failure);
                return;
            }
            resolve({
                cancelled: true,
                answers: [],
                deferred: true,
                questionId: id,
                dndMessage: deferredAgentMessage(decision),
            });
            return;
        }
        // No asking terminal: an internal approval gate. Its promise is the only
        // thing waiting on the answer and it dies with this process, so there is
        // nothing durable to write down — see `persist`.
        enqueue({
            id,
            resolve,
            questions,
            workspaceLabel,
            workspaceId: scope?.workspaceId,
            workspacePath,
            priority,
            askerTerminalId,
        });
    });
}

/** The desktop QuestionTransport (the BrowserWindow modal). Exported so the
 *  desktop shell can inject it explicitly; it's also the default when no
 *  transport is installed. */
export const desktopQuestionTransport: QuestionTransport = { ask: raiseDesktopModal };

/** The active transport every gate funnels through. Null ⇒ the desktop modal
 *  (so desktop works with no wiring). genie-cloud installs a fail-closed /
 *  forward-to-member transport — replacing the BrowserWindow path entirely. */
let questionTransport: QuestionTransport | null = null;

/** Install the QuestionTransport (the composition root, once at boot). Pass null
 *  to restore the desktop modal default. */
export function setQuestionTransport(t: QuestionTransport | null): void {
    questionTransport = t;
}

/**
 * Ask the user one or more questions and resolve with their answer — the single
 * chokepoint every approval gate (process run, ops-provision, terminal action,
 * mobile pairing, the MCP ForceTheQuestion tool) funnels through. Routed via the
 * injected {@link QuestionTransport}: desktop raises the modal; headless installs
 * a fail-closed / forward-to-member transport (no BrowserWindow).
 */
export function forceQuestion(
    questions: ForceQuestion[],
    workspaceLabel?: string,
    priority?: QuestionPriority,
    /** The question's scope (workspace/workstation ids) — drives the DND
     *  availability resolution on the desktop transport. Absent ⇒ global only. */
    scope?: QuestionScope,
    /** The asking agent's terminal id (the MCP ForceTheQuestion tool passes it) —
     *  routes a DND-deferred answer back to that agent's AgentInbox. Absent for an
     *  internal approval gate, which has no agent to deliver a late answer to. */
    askerTerminalId?: string,
): Promise<ForceQuestionResult> {
    return (questionTransport ?? desktopQuestionTransport).ask(
        questions,
        workspaceLabel,
        priority,
        scope,
        askerTerminalId,
    );
}

/**
 * Raise a modal in THIS Genie for a question FORWARDED from a host being driven
 * over the multi-host bridge (the remote driver answers on the host's behalf).
 * Resolves with the driver's answer (→ POST back to the host) or `cancelled`
 * (the driver dismissed it, OR the host resolved it first and we dismissed it
 * locally — see `dismissForwardedQuestion`). Mirrors `forceQuestion` but tags
 * the item so the host id is recoverable.
 */
export function raiseForwardedQuestion(opts: {
    connKey: string;
    hostId: string;
    questions: ForceQuestion[];
    workspaceLabel?: string;
    priority?: QuestionPriority;
    /** The remote host's display name (§8 attribution) — so the queue view shows
     *  the user this question is a REMOTE host's, never a local one. */
    remoteHost?: string;
    /** The remote host's WORKSTATION identity (its `connKey`) — resolves the
     *  DRIVER's per-workstation DND for this host. Absent ⇒ global default only. */
    workstationId?: string;
    /** The remote workspace id, when known — for a per-workspace override. */
    workspaceId?: string;
    /** The HOST's arrival stamp for this question, when it sent one. Preserved so
     *  the driver's inbox shows when the agent ASKED, not when we forwarded it.
     *  Absent from a host on an older build ⇒ we stamp the forward time. */
    createdAt?: number;
}): Promise<ForceQuestionResult> {
    return new Promise((resolve) => {
        const id = crypto.randomBytes(9).toString('hex');
        // Per-remote-host DND is a CLIENT-side setting: the driver decides whether
        // THIS host's questions interrupt. In DND, never pop the driver's modal —
        // park the forwarded question in the inbox, still answerable (answering
        // resolves this promise → the bridge POSTs it back; a host-first resolution
        // cancels it via dismissForwardedQuestion).
        const decision = availabilityReader({
            workstationId: opts.workstationId,
            workspaceId: opts.workspaceId,
        });
        if (decision.availability === 'dnd') {
            deferred.push({
                id,
                questions: opts.questions,
                workspaceLabel: opts.workspaceLabel,
                priority: opts.priority,
                remoteHost: opts.remoteHost,
                createdAt: opts.createdAt ?? questionClock(),
                resolve,
                forward: { connKey: opts.connKey, hostId: opts.hostId },
                deferralReason: 'dnd',
            });
            // Opt-in audible cue for a forwarded (remote-host) question too — chime,
            // no modal/focus steal (ftq_dnd_sound).
            if (dndSoundEnabled()) playForceQuestionChime();
            notifyQuestionsChanged();
            return;
        }
        enqueue({
            id,
            resolve,
            questions: opts.questions,
            workspaceLabel: opts.workspaceLabel,
            priority: opts.priority,
            createdAt: opts.createdAt,
            forward: { connKey: opts.connKey, hostId: opts.hostId, hostLabel: opts.remoteHost },
        });
    });
}

/**
 * Dismiss a forwarded question because the HOST resolved it first (first-answer-
 * wins — the host owner answered locally, or our own POSTed answer round-tripped
 * back as a `question:changed`). Resolves its promise CANCELLED so the caller
 * does NOT post an answer. No-op when it's already gone.
 */
export function dismissForwardedQuestion(connKey: string, hostId: string): void {
    const item = queue.find(
        (q) => q.forward?.connKey === connKey && q.forward?.hostId === hostId,
    );
    if (item) {
        finish(item.id, { cancelled: true, answers: [] });
        return;
    }
    // Also a forwarded DND deferral (the host was in DND on the driver, then the
    // host answered first) — resolve it cancelled (POST nothing) + drop the row.
    const di = deferred.findIndex(
        (d) => d.forward?.connKey === connKey && d.forward?.hostId === hostId,
    );
    if (di !== -1) {
        const [d] = deferred.splice(di, 1);
        d.resolve?.({ cancelled: true, answers: [] });
        notifyQuestionsChanged();
    }
}

/** Dismiss EVERY forwarded question for a connection (the bridge dropped). */
export function dismissForwardedQuestionsForConn(connKey: string): void {
    const ids = queue.filter((q) => q.forward?.connKey === connKey).map((q) => q.id);
    for (const id of ids) finish(id, { cancelled: true, answers: [] });
    // Forwarded DND deferrals for this connection too — resolve cancelled + drop.
    const droppedDeferred = deferred.filter((d) => d.forward?.connKey === connKey);
    if (droppedDeferred.length) {
        for (const d of droppedDeferred) {
            const di = deferred.indexOf(d);
            if (di !== -1) deferred.splice(di, 1);
            d.resolve?.({ cancelled: true, answers: [] });
        }
        notifyQuestionsChanged();
    }
}

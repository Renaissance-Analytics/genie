import type { AgentId, AgentRecord } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import type { PromptContext } from '../core/session.js';
import type { NoticeMail } from '../core/stream-event.js';
import { inboxAgentPaused } from '../core/inbox.js';
import { AppTurnBudget, appDelivery, isAppSender, type AppDelivery } from '../core/app-inbox.js';

/**
 * §6.4 THE INBOX PUSH — GENIE'S, FOR EVERY PROVIDER. When mail lands for an agent, Genie puts the notice into that
 * agent's own session (`by: genie`, never the person's words) the way the person's typed message goes
 * (`AgentSession.deliver`): at once when the session can take it, MID-TURN INCLUDED; while it is still starting, held
 * on a limit or not running, the moment it can (its driver ready, the limit reset, it being started at all). Exactly
 * once per arrival batch (core/inbox-reminders.ts).
 *
 * MID-TURN, LIKE TYPED INPUT (genie#1411; the owner, 2026-11-01: "inbox nudges should queue up and post to the agent as
 * soon as possible just like user input"). The push used to wait for a session that could take a NEW turn, so a long
 * turn — or a background subagent keeping one open — held four messages for 22 minutes. Now Claude takes the notice at
 * its next step and folds it into the running turn; Codex refuses a prompt mid-turn, so `deliver` holds it and sends it
 * as its own turn the moment the running one ends.
 *
 * Nothing here asks a provider for anything but a prompt: no hook, no MCP notification, no provider interrupt. Both
 * events are Genie's own — a message landing (`inbox.onSend`) and the session changing (`host.subscribe`: a turn
 * ending, ready, started, stopped) — so nothing polls.
 *
 * TOLD MEANS DELIVERED: a notice is settled as told only when the turn that took it ends cleanly — the running turn it
 * was folded into, the new turn it opened, or, when it was held (Codex), its OWN turn after it left the queue. A prompt
 * that throws, a turn that crashes, a held notice dropped with the turn before it, a session stopped under it — each
 * leaves the batch untold, and the next moment the agent can take it tells it. While a notice is out the book holds it as
 * sending, so two events in one tick never both prompt. One exception, on an ARRIVAL only and only where each notice
 * counts everything unread (`cumulative`, the mail push): a notice the provider already has is settled told when a newer
 * one goes out, because the newer one covers it.
 *
 * NOBODY HAS TO TYPE (genie#1379; the owner on beta.53: "Users should not have to drive chat for agents to get
 * notifications they need"). Every agent with a session is told — app mail, agent mail, replies alike — after a short
 * COALESCING window (`coalesceMs`), so a burst is one notice naming them all. #1350 gave a manual agent no turn of its
 * own for an app's message, so it heard only after the person's next turn. What stays mode-shaped is only whether a
 * STOPPED agent is started (`appMail`), and THE APP WAKE CAP (`appBudget`): a notice for mail that is all from apps is
 * spent from it only when it OPENS a turn (an idle agent's, or one Codex holds for its own turn) — one folded into a turn
 * already running causes none. Past the cap the mail waits for the window, then one notice.
 *
 * It was inline in main.ts and keyed on `turnState === 'idle'`. A session just started read `working` until a turn
 * ended, with no turn running, so an agent started and mailed at once (a sidecar, the moment `runAgent` answered) was
 * told only after somebody else had prompted it and that turn had ended (B26, a Codex sidecar in beta.27). A started
 * session reads idle now (2026-11-01), and this still keys on `promptable`: a session still starting is idle too.
 */
export interface InboxPushPorts {
    readonly inbox: { onSend(listener: (to: string, message?: { readonly from: string }) => void): () => void };
    readonly host: {
        subscribe(listener: (agentId: AgentId) => void): () => void;
        /**
         * The agent's run when a message handed over now reaches it at its next step, mid-turn included, else `null`
         * (SessionHost.deliverable: not running, starting, held on a limit, broken, stopped, or paused by the person's Stop
         * until they act, genie#1565).
         */
        deliverable(agentId: AgentId): number | null;
        /** The agent's current run while it has a session at all, else `null`. */
        runOf(agentId: AgentId): number | null;
        /** Turns ended in the agent's current run. */
        turnsEndedThisRun(agentId: AgentId): number;
        /** A turn is in flight, by Genie's own record (SessionHost.inTurn). */
        inTurn(agentId: AgentId): boolean;
        /** The prompt held under `id` is still waiting in the agent's current run (SessionHost.hasQueuedPrompt). */
        hasQueuedPrompt(agentId: AgentId, id: string): boolean;
        probe(agentId: AgentId): LiveSession | null;
        /** How the agent's last turn ended (SessionHost.lastTurnEnd): a notice whose turn was STOPPED was not told. */
        lastTurnEnd?(agentId: AgentId): 'replied' | 'stopped' | 'failed' | 'held' | 'signed-out' | null;
        /**
         * The typed-input path (SessionHost.handOff → AgentSession.deliver): `{ queued: null }` = the provider has it now;
         * `{ queued: id }` = held for the turn's end; `null` = no session. Throws when the provider refuses it outright.
         */
        handOff(agentId: AgentId, text: string, by?: string | null, context?: PromptContext): { queued: string | null } | null;
    };
    /**
     * The notices due (compose's `inboxReminders`): decides and marks them sending; never sends. `mail`: the messages a
     * notice tells about, carried on its ledger row so the chat shows who wrote and what (beta.33 item 18).
     */
    readonly reminders: (input: { run: (agentId: string) => number | null }) => Array<{ agentId: string; text: string; mail?: readonly NoticeMail[] }>;
    /** A notice settled (compose's `inboxNoticeSettled`): delivered, or its batch untold. */
    readonly settled: (agentId: string, delivered: boolean) => void;
    /**
     * MAIL WAKES THE AGENT (the owner, 2026-10-17: "agents don't wake up from inbox pushes unless I go to their screen").
     * Start the session of an agent that has none — main's `wakeAgent` (opening an agent no longer starts it, q_04ce323c), refusing by name for an asleep workspace or
     * the agent cap. Answers whether it started; its start event then delivers the notice. Absent = mail waits.
     */
    readonly wake?: ((agentId: AgentId) => boolean) | undefined;
    /**
     * APP MAIL (genie#1345; genie#1379): whether a STOPPED agent is started for a message an APP sent — `push` (started,
     * as mail does) or `push-no-wake` (not: a manual agent, or the app wake cap is spent; its mail waits). Either way an
     * agent with a session is told exactly as for any mail. `null` = not an app's message. Absent = every message as mail.
     */
    readonly appMail?: ((to: AgentId, message: { readonly from: string }) => AppDelivery | null) | undefined;
    /**
     * THE APP WAKE CAP (core/app-inbox.ts AppTurnBudget): a notice whose mail is ALL from apps is sent only while
     * `waitMs` is 0; otherwise it waits `waitMs` (needs `schedule`) and is told then. It is `spend`t only when it OPENS a
     * turn — an idle agent's, or one held for its own turn (Codex); folded into a turn already running, it causes none
     * (genie#1411). A notice with any person's or agent's mail in it is never held. Absent = no cap.
     */
    readonly appBudget?: { waitMs(agentId: AgentId): number; spend(agentId: AgentId): void } | undefined;
    /** Genie's timer (main: setTimeout), answering a cancel. Absent = no coalescing and no deferred app turns. */
    readonly schedule?: ((fn: () => void, ms: number) => () => void) | undefined;
    /**
     * THE COALESCING WINDOW: mail arriving for an agent with a session is told this long after the FIRST arrival, so a
     * burst is one turn naming them all, not one per message. 0 or absent = at once.
     */
    readonly coalesceMs?: number | undefined;
    /**
     * EACH NOTICE COUNTS EVERYTHING STILL UNREAD (the mail push: "You have N unread"), so a newer notice covers the one
     * before it. Then new mail arriving while a notice the provider already has is in flight is told at once, and the one
     * before is settled told. Absent (IssueWatch, whose notice names only what is new) = new mail waits for that turn's end.
     */
    readonly cumulative?: boolean | undefined;
}

export function wireInboxPush(ports: InboxPushPorts): () => void {
    const { inbox, host, reminders, settled } = ports;
    /**
     * The notice out per agent: the run it went to, how many of that run's turns had ended when the provider got it, and,
     * while it is HELD for the turn's end (Codex), the id it is held under.
     */
    const out = new Map<string, { run: number; endedBefore: number; queued: string | null }>();
    /** An arrival's coalescing window, per agent: while one is open the agent is told when it closes, not before. */
    const coalescing = new Map<string, () => void>();
    /** An app-only notice held by the app wake cap, per agent: told when the window allows. */
    const deferred = new Map<string, () => void>();
    const { schedule } = ports;
    const coalesceMs = ports.coalesceMs ?? 0;

    /** Settle the agent's notice if its fate is known now. Answers whether one is still out. */
    const settle = (id: AgentId): boolean => {
        const sent = out.get(id);
        if (!sent) return false;
        if (host.runOf(id) !== sent.run) {
            // Stopped (or restarted) under it: the run it went to never finished its turn.
            out.delete(id);
            settled(id, false);
            return false;
        }
        if (sent.queued !== null) {
            // HELD for the turn's end (Codex refuses a prompt mid-turn): still waiting, nothing to settle yet.
            if (host.hasQueuedPrompt(id, sent.queued)) return true;
            // Gone from the queue. Sent, it opened its own turn, in flight now — the turn it is told by. Not in a turn: it
            // was dropped with a turn that broke, or refused when it went, and was never delivered.
            if (!host.inTurn(id)) {
                out.delete(id);
                settled(id, false);
                return false;
            }
            sent.queued = null;
            sent.endedBefore = host.turnsEndedThisRun(id);
            return true;
        }
        // The provider has it: the next turn to end in that run took it — the running turn it was folded into, or the one
        // it opened. That turn ending cleanly is the notice told, so the turn's end never sends the same batch again.
        if (host.turnsEndedThisRun(id) <= sent.endedBefore) return true;
        out.delete(id);
        // Not a turn that was STOPPED either: since prism-acp 0.37.0 a notice Claude took mid-turn is dropped by the Stop
        // (genie#1565), so it is told again once the person acts.
        settled(id, host.probe(id)?.turnState !== 'failed' && host.lastTurnEnd?.(id) !== 'stopped');
        return false;
    };

    // Only the agent the event is about is considered: another agent's batch is told on ITS events, not on this one's.
    // `arrival`: new mail, not a session event — a notice the provider already has may be overtaken (below).
    const push = (only: string, arrival = false): void => {
        // Held mail remains due. The host's resume/start event retries it; no notice bypasses a provider pause.
        if (inboxAgentPaused(host.probe(only as AgentId))) return;
        const prior = out.get(only);
        if (settle(only as AgentId)) {
            // NEW MAIL ON TOP OF A NOTICE THE PROVIDER HAS (Claude folded it, or its turn is running): told now, as typed
            // input would be, not at that turn's end. The newer notice counts everything still unread, so the one before
            // it is settled told — if the newer one is not delivered, its batch is untold and covers both. A notice still
            // HELD (Codex) is not overtaken: a second held notice would be a second turn.
            if (!ports.cumulative || !arrival || prior === undefined || prior.queued !== null || host.deliverable(only as AgentId) === null) return;
            out.delete(only);
            settled(only, true);
        }
        // An arrival's window is open: its close tells everything that came in it, once.
        if (coalescing.has(only)) return;
        for (const r of reminders({ run: (id) => (id === only ? host.deliverable(id as AgentId) : null) })) {
            const id = r.agentId as AgentId;
            const run = host.runOf(id);
            if (run === null) { settled(id, false); continue; }
            // Only apps' mail: spent from the app wake cap if it opens a turn; past the cap, told when the window allows.
            // Held then even mid-turn: whether the provider folds it (no turn) or holds it (its own turn) is known only
            // once it is handed over.
            const appCaused = ports.appBudget !== undefined && r.mail !== undefined && r.mail.length > 0 && r.mail.every((m) => isAppSender(m.from));
            if (appCaused) {
                const wait = ports.appBudget!.waitMs(id);
                if (wait > 0) {
                    settled(id, false);
                    if (schedule && !deferred.has(id)) deferred.set(id, schedule(() => { deferred.delete(id); push(id); }, wait));
                    continue;
                }
            }
            const midTurn = host.inTurn(id);
            // Out BEFORE the prompt: the prompt itself announces a change, and that re-entry must see it in flight.
            const sent = { run, endedBefore: host.turnsEndedThisRun(id), queued: null as string | null };
            out.set(id, sent);
            let handed: { queued: string | null } | null = null;
            try {
                // `retold`: held and then dropped, it is not kept as a draft a Restart owes — this book tells it again.
                handed = host.handOff(id, r.text, 'genie', { ...(r.mail ? { mail: r.mail } : {}), retold: true });
            } catch {
                handed = null;
            }
            if (handed === null) {
                if (out.get(id) === sent) out.delete(id);
                settled(id, false);
                continue;
            }
            sent.queued = handed.queued;
            // It opens a turn when the agent was idle, or when it is held for a turn of its own.
            if (appCaused && (!midTurn || handed.queued !== null)) ports.appBudget!.spend(id);
        }
    };
    /** Mail arrived for an agent with a session: told when the coalescing window closes (at once without one). */
    const arrived = (to: string): void => {
        if (!schedule || coalesceMs <= 0 || host.runOf(to as AgentId) === null) { push(to, true); return; }
        if (coalescing.has(to)) return;
        coalescing.set(to, schedule(() => { coalescing.delete(to); push(to, true); }, coalesceMs));
    };
    // Only an ARRIVAL wakes an agent with no session: on the host's own events (its stop among them) it is not restarted.
    const offSend = inbox.onSend((to, message) => {
        if (to === 'human') return;
        if (inboxAgentPaused(host.probe(to as AgentId))) return;
        const app = message ? ports.appMail?.(to as AgentId, message) ?? null : null;
        // Only WHETHER a stopped agent is started differs for an app's message; one with a session is told as for any.
        if (host.runOf(to as AgentId) === null && ports.wake && app !== 'push-no-wake') {
            let started = false;
            try { started = ports.wake(to as AgentId); } catch { started = false; }
            if (started) return; // its start announces itself, and that event delivers the notice
        }
        arrived(to);
    });
    const offHost = host.subscribe((agentId) => push(agentId));
    return () => {
        offSend();
        offHost();
        for (const cancel of [...coalescing.values(), ...deferred.values()]) cancel();
        coalescing.clear();
        deferred.clear();
    };
}

/** THE COALESCING WINDOW main gives the mail push: a burst arriving inside it is one turn (genie#1379). */
export const INBOX_COALESCE_MS = 1_500;

/**
 * MAIN'S APP POLICY for the mail push (genie#1379), one place so main and the VM harness cannot drift: whether a stopped
 * agent is started for an app's message (automated, while the cap allows), THE APP WAKE CAP (AppTurnBudget), Genie's
 * timer and the coalescing window.
 */
export function appMailPushPorts(input: {
    readonly modeOf: (agentId: AgentId) => AgentRecord['mode'] | undefined;
    readonly now: () => number;
    readonly schedule: (fn: () => void, ms: number) => () => void;
}): { [K in 'appMail' | 'appBudget' | 'schedule' | 'coalesceMs']-?: NonNullable<InboxPushPorts[K]> } {
    const budget = new AppTurnBudget(input.now);
    return {
        appMail: (to, message) => (isAppSender(message.from) ? appDelivery(input.modeOf(to) ?? 'manual', budget.waitMs(to) === 0) : null),
        appBudget: budget,
        schedule: input.schedule,
        coalesceMs: INBOX_COALESCE_MS,
    };
}

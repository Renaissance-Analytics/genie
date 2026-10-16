import type { ApprovalOption } from './approval.js';
import type { Question } from './attention.js';

/**
 * THE DECK — "does anything need me?"
 *
 * The attention queue, and **the only place badges exist in Genie**. If a badge appears
 * anywhere else, the design has failed — which is why the comms column's recency levels
 * deliberately exclude Fancy's amber `unseen`, and why the rail's Deck count is the one number
 * allowed to be a badge.
 *
 * ## Its acceptance test is a sentence
 *
 * > **You can clear the entire band without navigating once.**
 *
 * Everything here serves that. The ranking puts the most-worth-doing thing at the top; the
 * inline/expand split means a question is answered where it is read; and a forwarded question
 * is shown but not answerable, because answering the local copy marks it done while the real
 * one waits forever.
 *
 * ## The Deck has no Agents band
 *
 * The Dashboard absorbed it. Two boards claiming the same subject was the original design
 * error, and the Deck's subject is *decisions*, not agents.
 */

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

/** In rank order. The array IS the ordering — there is no second table to disagree with it. */
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

/**
 * Where an item came from.
 *
 * Four sources normalise into one item, so the band can be ranked as a whole: a blocked agent
 * does not become less urgent because the thing above it came from a different subsystem.
 *
 * Only `agent-question` produces items today. The others are declared because the ranking has
 * to be right before they arrive — not because anything is faking them.
 */
export type DeckSource = 'agent-question' | 'user-list' | 'unread-dm' | 'finished-handoff' | 'genie';
// `genie`: Genie ITSELF asks — no agent behind it (agentId/agentName null). Its ids start `genie:`; today the one is
// trusting Genie's certificate so https://<name>.gen works in the browser (core/gen-ca.ts trustDeckItem).

export type DeckAnswer =
    /** Answering inline is the whole answer. */
    | { kind: 'inline'; options: readonly ApprovalOption[] }
    /**
     * Multi-part, multi-select or free text: expands into a full form IN PLACE — so the item carries the questions.
     * Without them (an item minted before they travelled) the form cannot be drawn and the door opens the agent instead.
     */
    | { kind: 'form'; fields: number; questions?: readonly Question[] | undefined }
    /** Raised on another host, and only answerable there. */
    | { kind: 'elsewhere'; host: string };

export interface DeckItem {
    id: string;
    source: DeckSource;
    agentId: string | null;
    agentName: string | null;
    workspaceId: string | null;
    title: string;
    /** An agent has STOPPED and is waiting. The single most important bit on the item. */
    blocking: boolean;
    priority: Priority;
    /** Epoch ms. Oldest wins a tie — it has been waiting longest. */
    at: number;
    answer: DeckAnswer;
    /** The host that raised it, when it was forwarded. `null` for a local question. */
    forwardedFrom: string | null;
    /**
     * The workspace's NAME as the rail says it (project.json `name`, else the folder — core/workspace-name.ts), never its
     * id. Absent when the workspace is not known here; the surfaces then say no workspace rather than print a ULID.
     */
    workspaceName?: string | undefined;
    /**
     * How many times the asking agent has UPDATED this question (ForceTheQuestion `action: 'update'`). A form keyed by it
     * starts a clean draft when the content changes under it; absent = never updated.
     */
    revision?: number | undefined;
    /**
     * How many times its agent asked it AGAIN (a rejoined repeat — attention-store.ts). The question window reads a new
     * count as a new ask: a question put off with Later comes back. Absent = never asked again.
     */
    asks?: number | undefined;
    /**
     * Its agent NO LONGER WAITS for it (deck-sources.ts `questionStale`): the agent is gone from the roster, its session
     * ended, or the session running now started after it was asked (an earlier run asked it). Absent = live, or not
     * judged (no liveness was given). The owner, 2026-10-15, on old items: "Keep, but mark stale" — it stays on the
     * Deck, greyed and said, with one-click Dismiss and "Dismiss all stale".
     */
    stale?: StaleReason | undefined;
}

/** Why a question's agent no longer waits for it. */
export type StaleReason = 'agent-gone' | 'session-ended' | 'earlier-run';

/** The words a person reads for each reason. */
export function staleLabel(reason: StaleReason): string {
    switch (reason) {
        case 'agent-gone': return 'agent gone';
        case 'session-ended': return 'session ended';
        case 'earlier-run': return 'asked by an earlier run';
    }
}

export function isStale(item: DeckItem): boolean {
    return item.stale !== undefined;
}

/** What "Dismiss all stale" removes: the dismissable questions nobody waits for any more. */
export function dismissableStale(items: readonly DeckItem[]): readonly DeckItem[] {
    return items.filter((i) => isDismissable(i) && isStale(i));
}

/** A day, in ms — "Dismiss all older than 1 day" on the Deck's questions band. */
export const DAY_MS = 86_400_000;

/**
 * An item the person may DISMISS without answering: an agent's ForceTheQuestion (a form). A tool approval (inline, its
 * id `approval:<agent>`) is answered by Allow/Deny; a forwarded question belongs to the host that raised it.
 */
export function isDismissable(item: DeckItem): boolean {
    return item.source === 'agent-question' && item.answer.kind === 'form' && item.forwardedFrom === null;
}

/** The dismissable questions asked more than `ms` before `now` — what "Dismiss all older than 1 day" would remove. */
export function dismissableOlderThan(items: readonly DeckItem[], now: number, ms: number): readonly DeckItem[] {
    return items.filter((i) => isDismissable(i) && now - i.at > ms);
}

/** `just now` / `5 min ago` / `2 h ago` / `3 d ago` — how long a question has waited, said the way a person reads it. */
export function ageLabel(at: number, now: number): string {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.floor(h / 24)} d ago`;
}

/**
 * A short label as PLAIN TEXT: an agent may put Markdown in a question's header (`**Engine**`, `` `db` ``), and a title
 * is not rendered — so the marks are taken out rather than shown raw. Links keep their text.
 */
export function plainLabel(text: string): string {
    return text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/^\s*(?:#+|>|[-+]\s)\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The **Needs you** band, ranked.
 *
 * **Blocking first**, and that beats priority: a high-priority note that blocks nothing can be
 * read in a minute, while a blocked agent is doing nothing at all until somebody answers, and
 * every minute of that is wasted work. Then priority, then **oldest**.
 */
export function deckBand(items: readonly DeckItem[]): readonly DeckItem[] {
    const rank = (p: Priority): number => PRIORITIES.indexOf(p);

    return items
        // A finished agent is not waiting on anybody: its handoff belongs to the SECOND band (§4.5 "Since you looked").
        .filter((item) => item.source !== 'finished-handoff')
        .map((item) =>
            // A forwarded question must be answered on the host that raised it. Answering the
            // local copy marks it done while the real one waits forever — an agent blocked on
            // a decision somebody believes they already made.
            //
            // It stays VISIBLE. Hiding it would leave the agent blocked with the only clue
            // removed from the one surface whose job is to show what needs a human.
            item.forwardedFrom === null
                ? item
                : { ...item, answer: { kind: 'elsewhere' as const, host: item.forwardedFrom } },
        )
        .slice()
        .sort((a, b) => {
            if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
            const byPriority = rank(a.priority) - rank(b.priority);
            if (byPriority !== 0) return byPriority;
            return a.at - b.at;
        });
}

/**
 * **Since you looked** (§4.5): finished agents with their handoff notes, newest first — `Open`, `Restart with this`,
 * `mark read`. Read, not resolved: nothing here blocks anybody, which is why it is not in the band or its count.
 */
export function sinceYouLooked(items: readonly DeckItem[]): readonly DeckItem[] {
    return items.filter((item) => item.source === 'finished-handoff').slice().sort((a, b) => b.at - a.at);
}

/**
 * The rail's badge and the header's count: what is WAITING on you — never a finished agent, and never a STALE question:
 * its agent is not waiting, so it is not a number that asks for the person. Stale ones are said beside it, by name.
 */
export function needsYouCount(items: readonly DeckItem[]): number {
    return deckBand(items).filter((i) => !isStale(i)).length;
}

/**
 * ONE WORKSPACE'S PART OF THE DECK (the owner, 2026-10-15: "Grouped by workspace" — sections per workspace, then rows).
 * `workspaceId` null is Genie's own section: its items (a main-process error, trusting the certificate) belong to no
 * workspace. `label` is the workspace's NAME as the rail says it — never its id; one not known here is said as such.
 */
export interface DeckSection {
    readonly key: string;
    readonly workspaceId: string | null;
    readonly label: string;
    readonly items: readonly DeckItem[];
    /** How many of its items are waiting on the person (not stale). */
    readonly live: number;
    readonly stale: number;
}

/** Genie's own section's label, and the one for a workspace this machine has no name for. */
export const GENIE_SECTION = 'Genie';
export const UNNAMED_WORKSPACE = 'A workspace not known here';

/**
 * The Needs-you band, IN SECTIONS. The ranking is the band's (`deckBand`: blocking, priority, oldest) and it decides
 * both orders, so the most-worth-doing thing is still at the top of the screen:
 *
 * - within a section, live items in rank order, then its stale ones in rank order (a stale question waits for nobody);
 * - sections in the order of their best LIVE item; a section holding only stale items comes after every live one.
 */
export function deckSections(items: readonly DeckItem[]): readonly DeckSection[] {
    const band = deckBand(items);
    const ordered = [...band.filter((i) => !isStale(i)), ...band.filter(isStale)];
    const sections = new Map<string, { workspaceId: string | null; label: string | null; items: DeckItem[] }>();
    for (const item of ordered) {
        const key = item.workspaceId ?? 'genie:';
        let section = sections.get(key);
        if (!section) {
            section = { workspaceId: item.workspaceId, label: null, items: [] };
            sections.set(key, section);
        }
        if (section.label === null && item.workspaceName !== undefined) section.label = item.workspaceName;
        section.items.push(item);
    }
    return [...sections.entries()].map(([key, s]) => ({
        key,
        workspaceId: s.workspaceId,
        label: s.workspaceId === null ? GENIE_SECTION : (s.label ?? UNNAMED_WORKSPACE),
        items: s.items,
        live: s.items.filter((i) => !isStale(i)).length,
        stale: s.items.filter(isStale).length,
    }));
}

/**
 * THE DECK ITEM A WAITING ROW IS A DOOR TO (§4.1: "a waiting row links to its Deck item and is answered there").
 * The blocking question this agent is waiting on — the oldest when there are two, because it has waited longest —
 * and `null` when there is none: a finished handoff is not a question, and another agent's question is not this
 * row's. The Dashboard never resolves; it only knows where the decision is.
 */
export function deckItemFor(agentId: string, items: readonly DeckItem[]): string | null {
    const waiting = items
        .filter((i) => i.agentId === agentId && i.source === 'agent-question' && i.blocking)
        .sort((a, b) => a.at - b.at);
    return waiting[0]?.id ?? null;
}

export type SignalKind = 'flows' | 'mail' | 'github' | 'os-agent' | 'update';

/** The one kind of door that is an action rather than a place: the update's next step. */
export type SignalAction = 'update-download' | 'update-install';

export interface Signal {
    kind: SignalKind;
    label: string;
    /** **Every signal is also a door.** A route to the feature it is about. */
    route: string;
    /**
     * For the update signal only: what clicking it DOES. An update has no surface to go to —
     * its door is the next step (download, then install), and a click with no action (while
     * downloading, while installing) just goes to the Deck, which is where it already is.
     */
    action?: SignalAction;
}

/** What the strip needs to know about an update — `UpdateState`'s shape, the three fields it reads. */

export interface UpdateSignalInput {
    phase: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
    version: string | null;
    percent: number | null;
}

export interface SignalState {
    flowsRunning: number;
    /** Mail agents have not collected. */
    uncollectedMail: number;
    /** GitHub permissions are blocking features. */
    githubBlocked: boolean;
    osAgentWorking: boolean;
    /**
     * The updater's state, overlaid by the renderer (it is not part of the estate snapshot).
     * Absent or `null` means no updater — a dev run, a render test — and says nothing.
     */
    update?: UpdateSignalInput | null;
}

/**
 * The signal strip — **silent unless something is true.**
 *
 * *"A strip reading '0 waiting · no flows · GitHub fine' is furniture that trains people to
 * stop reading it."* A signal appears only when it is true, and **every one is a door** to the
 * feature it concerns: announcing a problem without a route to it makes somebody go looking,
 * which is the opposite of what an attention surface is for.
 */
export function signalStrip(state: SignalState): readonly Signal[] {
    const signals: Signal[] = [];

    if (state.flowsRunning > 0) {
        signals.push({
            kind: 'flows',
            label: `${state.flowsRunning} flow${state.flowsRunning === 1 ? '' : 's'} running`,
            route: 'genie://flows',
        });
    }

    if (state.uncollectedMail > 0) {
        signals.push({
            kind: 'mail',
            label: `${state.uncollectedMail} message${state.uncollectedMail === 1 ? '' : 's'} not collected`,
            route: 'genie://inbox',
        });
    }

    if (state.githubBlocked) {
        signals.push({
            kind: 'github',
            label: 'GitHub permissions are blocking features',
            route: 'genie://settings/github',
        });
    }

    if (state.osAgentWorking) {
        signals.push({ kind: 'os-agent', label: 'genie is working', route: 'genie://agent/genie' });
    }

    // THE UPDATE is not a Deck signal any more: it is in the header, on every surface (core/update-chip.ts).

    return signals;
}

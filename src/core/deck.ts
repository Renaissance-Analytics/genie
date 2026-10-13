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
export type DeckSource = 'agent-question' | 'user-list' | 'unread-dm' | 'finished-handoff';

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

/** The rail's badge and the header's count: what is WAITING on you — never a finished agent. */
export function needsYouCount(items: readonly DeckItem[]): number {
    return deckBand(items).length;
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

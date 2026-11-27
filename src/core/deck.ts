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
// No `finished-handoff`: a finished agent's handoff is for agents, never an item for the person (Tynn #658).
export type DeckSource = 'agent-question' | 'user-list' | 'unread-dm' | 'genie';
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
    /** The workspace's COLOUR (genie#1300, `#rrggbb`), drawn beside its name. Absent = none known. */
    workspaceColor?: string | undefined;
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
     * Its agent NO LONGER WAITS for it (deck-sources.ts `questionStale`): the agent is gone from the roster. A session that
     * ended or restarted still gets its answer by mail, so that is never stale (Tynn #1085). Absent = live, or not judged
     * (no liveness was given). The owner, 2026-10-15, on old items: "Keep, but mark stale" — it stays on the
     * Deck, greyed and said, with one-click Dismiss and "Dismiss all stale".
     */
    stale?: StaleReason | undefined;
    /** Why this was asked although its agent is Autonomous (Tynn #439), in words. Absent = nothing to explain. */
    why?: string | undefined;
    /** The technical detail (an error, its paths): drawn once, folded with the rest of the item, never in its title (Tynn #693). */
    detail?: string | undefined;
}

/**
 * COPY THE DETAIL (Tynn #753): an inline option with this id copies the item's `detail` in the window that shows it.
 * Nothing goes to main and nothing is answered: the item stays until it is answered some other way.
 */
export const COPY_DETAIL_OPTION = 'copy-detail';

/** The text `optionId` copies from `item`, or `null` when the option is an answer, not a copy. */
export function deckCopyText(item: DeckItem, optionId: string): string | null {
    return optionId === COPY_DETAIL_OPTION && typeof item.detail === 'string' && item.detail !== '' ? item.detail : null;
}

/**
 * Why a question's agent no longer waits for it: only its removal from the roster (Tynn #1085). "session ended" and
 * "asked by an earlier run" were reasons until beta.66.1, and closed the owner's open windows at every restart.
 */
export type StaleReason = 'agent-gone';

/** The words a person reads for each reason. */
export function staleLabel(reason: StaleReason): string {
    switch (reason) {
        case 'agent-gone': return 'agent gone';
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

/** How much of an item's first line the closed row shows (the owner, 2026-10-18: "open up on click to read full context"). */
export const PREVIEW_CHARS = 140;

/**
 * A Deck item's closed line: its first line, cut at a word near PREVIEW_CHARS with an ellipsis; `more` when there is
 * anything the line does not show — then the row opens on click. A short, one-line item is whole, with nothing to open.
 */
export function deckPreview(text: string): { preview: string; more: boolean } {
    const body = deckBody(text);
    const first = body.title;
    const rest = body.steps.length > 0 || body.text.length > 0;
    if (first.length <= PREVIEW_CHARS) return { preview: first, more: rest };
    const cut = first.slice(0, PREVIEW_CHARS);
    const space = cut.lastIndexOf(' ');
    return { preview: `${(space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`, more: true };
}

/**
 * A PERSON'S ITEM, READ (Tynn #602; the owner, 2026-11-10: "the deck is not easy to read at all"). Its title is its first
 * line; written as one paragraph, it is what comes before step 1. Its steps are the lines numbered 1, 2, 3 in order (`1.`
 * or `1)`), and in a run-on paragraph the same markers inside it, in order. Any other line is text. A number that is not
 * the next step (a version, a port, "3)" out of order) stays where it is.
 */
export interface DeckBody {
    readonly title: string;
    readonly steps: readonly string[];
    readonly text: readonly string[];
}

const LINE_STEP = /^(\d{1,2})[.)]\s+(.*)$/;

/** Where step `n`'s marker starts in `s`, at or after `from` (after a space, or at the start), and where its words begin. */
function stepMarker(s: string, n: number, from: number): { at: number; words: number } | null {
    const marker = new RegExp(`(^|\\s)${n}[.)]\\s+`, 'g');
    marker.lastIndex = from;
    const m = marker.exec(s);
    return m ? { at: m.index + m[1]!.length, words: m.index + m[0].length } : null;
}

/** A step's words, and any later steps written inside them: `Open the page 2) Click Add` is two steps. */
function splitSteps(words: string, next: number): string[] {
    const out: string[] = [];
    let rest = words;
    for (let n = next; ; n++) {
        const marker = stepMarker(rest, n, 0);
        if (!marker || marker.at === 0) break;
        out.push(rest.slice(0, marker.at).trim());
        rest = rest.slice(marker.words);
    }
    out.push(rest.trim());
    return out;
}

export function deckBody(raw: string): DeckBody {
    const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l !== '');
    let title = lines[0] ?? '';
    let rest = lines.slice(1);
    if (rest.length === 0) {
        // One paragraph: a title, then its steps run on. Only when step 1 AND step 2 are there, so "version 1. here" is not one.
        const one = stepMarker(title, 1, 0);
        if (!one || one.at === 0 || !stepMarker(title, 2, one.words)) return { title, steps: [], text: [] };
        rest = [title.slice(one.at)];
        title = title.slice(0, one.at).trim();
    }
    const steps: string[] = [];
    const text: string[] = [];
    for (const line of rest) {
        const m = LINE_STEP.exec(line);
        if (m && Number(m[1]) === steps.length + 1) steps.push(...splitSteps(m[2]!, steps.length + 2));
        else text.push(line);
    }
    return { title, steps, text };
}

/** Text with its web addresses taken out as links (http and https only); the punctuation after an address is not part of it. */
export function linkParts(text: string): Array<string | { url: string }> {
    const out: Array<string | { url: string }> = [];
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
        let url = m[0];
        for (;;) {
            const end = url.at(-1)!;
            const unbalanced = end === ')' && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length;
            if ('.,;:!?\'"]}'.includes(end) || unbalanced) url = url.slice(0, -1);
            else break;
        }
        if (m.index > last) out.push(text.slice(last, m.index));
        out.push({ url });
        last = m.index + url.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

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
 * The rail's badge and the header's count: what is WAITING on you — never a STALE question:
 * its agent is not waiting, so it is not a number that asks for the person. Stale ones are said beside it, by name.
 */
export function needsYouCount(items: readonly DeckItem[]): number {
    return deckBand(items).filter((i) => !isStale(i)).length;
}

/** The questions whose agent is gone, still unanswered: their own band, in rank order (named for the earlier runs it once held too). */
export function earlierRuns(items: readonly DeckItem[]): DeckItem[] {
    return deckBand(items).filter(isStale);
}

export type SignalKind = 'flows' | 'mail' | 'github' | 'os-agent' | 'update';

/** The one kind of door that is an action rather than a place: the update's next step. */
export type SignalAction = 'update-check' | 'update-download' | 'update-install' | 'launcher-updates';

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
    /** A failed check/download remains actionable, even before a version is known. */
    error?: string | null;
    /** Explicit user request or an open update window; routine background checks leave this unset. */
    userInitiated?: boolean;
    /** What is in the update (core/update-notes.ts): `null` = fetching, `'unavailable'` = offline. */
    changelog?: import('./update-notes.js').UpdateChangelog | 'unavailable' | null;
    /** Under the launcher (Tynn #1058 L6): how many updates it has ready. Absent = no launcher (the old pill and screen). */
    launcher?: { ready: number };
}

export interface SignalState {
    flowsRunning: number;
    /** The flows running now, for the header's pills (Tynn #707). Absent = not reported (a guest, an older host). */
    flowsLive?: readonly import('./flow-pills.js').LiveFlow[];
    /** Flows whose latest run just ended failed or held; the header shows each briefly. */
    flowsEnded?: readonly import('./flow-pills.js').EndedFlow[];
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
            // The AgentInbox flyout over the Deck (beta.33 item 19: not a page); the old page's link would leave the Deck.
            route: 'genie://dashboard?inbox=',
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

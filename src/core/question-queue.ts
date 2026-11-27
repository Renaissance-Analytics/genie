import { PRIORITIES, type DeckItem } from './deck.js';

/**
 * WHICH QUESTIONS THE FORCETHEQUESTION WINDOW HOLDS (the owner, 2026-10-14: "the FTQ window is a window that opens on top
 * of all other windows … It is not some tucked away ux, that is PendingQuestions (fed by the same workflow and in
 * sync)"). The window and the Pending Questions list read the SAME items; this decides what the window holds:
 *
 * - only questions this machine can answer (a form that carries its questions);
 * - only LIVE ones: a STALE question (its agent gone from the roster — core/deck.ts) stays in the Deck, marked, with
 *   Dismiss, and never takes the window — nobody can read its answer. A session that ended or restarted does not make it
 *   stale: the answer is mailed (Tynn #1085). One that goes stale while ON SCREEN is held there, marked, never closed
 *   under the person (main/question-window.ts);
 * - ITS OWN QUEUE (the owner, 2026-10-15: "The FTQ window should have its own queue so I can answer any and all
 *   questions of all agents just like genie 1 had"): every live question from every agent, oldest first, each one
 *   reachable from the window in any order (`windowQueue`). Genie 1's PendingQuestions v2 strip (genie
 *   renderer/pages/ask.tsx), carried over;
 * - the one SELECTED stays while it is still asked, even if an older one arrives — the window never changes under a
 *   person who is answering it; with nothing selected, the oldest not put off is;
 * - with nothing selected, the HIGHEST PRIORITY not put off is next, the oldest of those first (Tynn #721: Do Not Disturb
 *   turned off opens what waited in that order);
 * - one put off with Later (or a closed window) does not bring the window back on its own; it stays in the queue and in
 *   Pending Questions, answerable from either.
 */
export function isWindowQuestion(item: DeckItem): boolean {
    return item.source === 'agent-question' && item.answer.kind === 'form' && (item.answer.questions?.length ?? 0) > 0 && item.stale === undefined;
}

/** A question the window would hold if it were live: an agent's form, gone stale. The window keeps one only while it is on screen. */
export function isWindowStale(item: DeckItem): boolean {
    return item.source === 'agent-question' && item.answer.kind === 'form' && (item.answer.questions?.length ?? 0) > 0 && item.stale !== undefined;
}

/** Every question the window holds, oldest first — what its queue lists, parked ones included. */
export function windowQueue(items: readonly DeckItem[]): DeckItem[] {
    return items.filter(isWindowQuestion).sort((a, b) => a.at - b.at);
}

export function nextQuestion(items: readonly DeckItem[], dismissed: ReadonlySet<string>, current: string | null): DeckItem | null {
    const askable = windowQueue(items);
    if (current !== null) {
        const still = askable.find((i) => i.id === current);
        if (still) return still;
    }
    // The sort is stable, so equal priorities stay oldest first.
    const rank = (i: DeckItem): number => PRIORITIES.indexOf(i.priority);
    return askable.filter((i) => !dismissed.has(i.id)).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** How many more wait behind the one shown (not counting ones put off this session). */
export function waitingBehind(items: readonly DeckItem[], dismissed: ReadonlySet<string>, shown: string | null): number {
    return items.filter((i) => isWindowQuestion(i) && !dismissed.has(i.id) && i.id !== shown).length;
}

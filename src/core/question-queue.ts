import type { DeckItem } from './deck.js';

/**
 * WHICH QUESTIONS THE FORCETHEQUESTION WINDOW HOLDS (the owner, 2026-10-14: "the FTQ window is a window that opens on top
 * of all other windows … It is not some tucked away ux, that is PendingQuestions (fed by the same workflow and in
 * sync)"). The window and the Pending Questions list read the SAME items; this decides what the window holds:
 *
 * - only questions this machine can answer (a form that carries its questions);
 * - only LIVE ones: a STALE question (its agent gone, its session ended, or asked by an earlier run — core/deck.ts) stays
 *   in the Deck, marked, with Dismiss, and never takes the window — nobody is waiting for its answer. A question from a
 *   previous run is stale by definition; an agent that is resumed and still needs it asks again, as a new question.
 *   One that goes stale while on screen leaves the window the same way an answered one does;
 * - ITS OWN QUEUE (the owner, 2026-10-15: "The FTQ window should have its own queue so I can answer any and all
 *   questions of all agents just like genie 1 had"): every live question from every agent, oldest first, each one
 *   reachable from the window in any order (`windowQueue`). Genie 1's PendingQuestions v2 strip (genie
 *   renderer/pages/ask.tsx), carried over;
 * - the one SELECTED stays while it is still asked, even if an older one arrives — the window never changes under a
 *   person who is answering it; with nothing selected, the oldest not put off is;
 * - one put off with Later (or a closed window) does not bring the window back on its own; it stays in the queue and in
 *   Pending Questions, answerable from either.
 */
export function isWindowQuestion(item: DeckItem): boolean {
    return item.source === 'agent-question' && item.answer.kind === 'form' && (item.answer.questions?.length ?? 0) > 0 && item.stale === undefined;
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
    return askable.find((i) => !dismissed.has(i.id)) ?? null;
}

/** How many more wait behind the one shown (not counting ones put off this session). */
export function waitingBehind(items: readonly DeckItem[], dismissed: ReadonlySet<string>, shown: string | null): number {
    return items.filter((i) => isWindowQuestion(i) && !dismissed.has(i.id) && i.id !== shown).length;
}

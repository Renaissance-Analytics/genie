import type { DeckItem } from './deck.js';

/**
 * WHICH QUESTION THE FORCETHEQUESTION WINDOW SHOWS (the owner, 2026-10-14: "the FTQ window is a window that opens on top
 * of all other windows … It is not some tucked away ux, that is PendingQuestions (fed by the same workflow and in
 * sync)"). The window and the Pending Questions list read the SAME items; this picks the one the window shows:
 *
 * - only questions this machine can answer (a form that carries its questions);
 * - one at a time, the OLDEST first (a person works down the queue in the order agents waited);
 * - the one on screen STAYS while it is still asked, even if an older one arrives — the window never changes under a
 *   person who is answering it;
 * - one put off with Later (or a closed window) is not shown again this session; it stays in Pending Questions.
 */
export function isWindowQuestion(item: DeckItem): boolean {
    return item.source === 'agent-question' && item.answer.kind === 'form' && (item.answer.questions?.length ?? 0) > 0;
}

export function nextQuestion(items: readonly DeckItem[], dismissed: ReadonlySet<string>, current: string | null): DeckItem | null {
    const askable = items.filter(isWindowQuestion);
    if (current !== null) {
        const still = askable.find((i) => i.id === current);
        if (still) return still;
    }
    return [...askable].filter((i) => !dismissed.has(i.id)).sort((a, b) => a.at - b.at)[0] ?? null;
}

/** How many more wait behind the one shown (not counting ones put off this session). */
export function waitingBehind(items: readonly DeckItem[], dismissed: ReadonlySet<string>, shown: string | null): number {
    return items.filter((i) => isWindowQuestion(i) && !dismissed.has(i.id) && i.id !== shown).length;
}

/**
 * THE NEXT QUESTION SHOWS FROM ITS TOP (genie#1298). After an answer, the question window shows the next queued question
 * in the same content scroller — which kept the offset of the one answered, so the person landed at the bottom of a
 * question they had not read. When the question shown changes (another id), the scroller goes back to the top.
 *
 * Only the scroller's own `scrollTop` is set: never a `focus()` (Genie never takes focus on its own, genie#1235) and
 * never a `scrollIntoView`, which scrolls every ancestor up to the document (genie#1290: the root never scrolls). The
 * same question pushed again (another agent asked meanwhile) leaves the reader where they are.
 *
 * Returns whether it reset.
 */
export function resetScrollOnQuestionChange(scroller: { scrollTop: number } | null, previous: string | null, shown: string): boolean {
    if (scroller === null || previous === shown) return false;
    scroller.scrollTop = 0;
    return true;
}

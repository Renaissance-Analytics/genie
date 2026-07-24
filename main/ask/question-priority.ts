/**
 * PendingQuestions v2 — priority ordering for the ForceTheQuestion queue.
 *
 * PURE + electron-free (so it's unit-testable without the BrowserWindow mock).
 * `force-question.ts` uses `insertByPriority` in place of `queue.push` so a
 * higher-priority question is answered sooner — WITHOUT ever preempting the head
 * (index 0), the question the user is currently answering.
 */

export type QuestionPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Higher number = answered sooner. */
export const PRIORITY_RANK: Record<QuestionPriority, number> = {
    urgent: 3,
    high: 2,
    normal: 1,
    low: 0,
};

const rankOf = (p?: QuestionPriority): number => PRIORITY_RANK[p ?? 'normal'];

/**
 * Insert `item` into `queue` (mutating it) ordered by priority — higher first,
 * FIFO within equal priority — and return its new index.
 *
 * Invariant: the HEAD (index 0) is never displaced. When the queue is non-empty,
 * index 0 is the question currently shown/being answered, so even an `urgent`
 * arrival lands at index 1 (next up), never yanking the user mid-answer. An empty
 * queue takes the item as its head (it becomes the shown question).
 */
export function insertByPriority<T extends { priority?: QuestionPriority }>(
    queue: T[],
    item: T,
): number {
    if (queue.length === 0) {
        queue.push(item);
        return 0;
    }
    // Skip index 0 (protected head), then walk past every WAITING item whose
    // priority is >= the arrival's, so equal priority stays FIFO and higher
    // priority stays ahead. Insert before the first strictly-lower waiter.
    let i = 1;
    while (i < queue.length && rankOf(queue[i].priority) >= rankOf(item.priority)) i++;
    queue.splice(i, 0, item);
    return i;
}

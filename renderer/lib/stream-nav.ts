import type { StreamRow } from './agent-stream';

/**
 * Moving around the stream — `E` (next edit) and `/` (find in stream).
 *
 * The last two keys on the spec board's "New keys" line, and pure for the same reason as
 * everything else in this folder: the renderer's test environment has no DOM, so a rule
 * inside a keyboard handler is a rule nobody checks.
 */

/**
 * The id of the next EDIT after `currentId`, wrapping, or null when there are none.
 *
 * "After here", not "after the last edit": a tool call can be the selected row because the
 * inspector is open on it, and `E` from there should reach the next edit rather than skipping
 * to the one after some edit you are not looking at.
 *
 * It WRAPS. A key that silently stops working at the end of a list reads as broken, and
 * wrapping is what find-next does in every editor, so it is what people expect.
 *
 * A `currentId` that is no longer in the stream starts from the top rather than throwing —
 * the stream is live, and a lanes range can filter away the row that was selected.
 */
export function nextEditId(rows: readonly StreamRow[], currentId: string | null): string | null {
    const isEdit = (r: StreamRow) => r.type === 'event' && r.kind === 'edit';
    if (!rows.some(isEdit)) return null;

    const from = currentId === null ? -1 : rows.findIndex((r) => r.id === currentId);
    const start = from < 0 ? -1 : from;

    for (let i = start + 1; i < rows.length; i += 1) {
        if (isEdit(rows[i]!)) return rows[i]!.id;
    }
    // Wrap. Guaranteed to find one, because the early return above proved at least one exists.
    for (let i = 0; i <= start; i += 1) {
        if (isEdit(rows[i]!)) return rows[i]!.id;
    }
    return null;
}

/**
 * The rows a find query admits.
 *
 * An empty or whitespace-only query is NOT a filter — it is someone who opened the box and
 * has not typed yet, and emptying the stream at that moment would read as the search having
 * destroyed it.
 *
 * DIVIDERS always survive. They are punctuation — "context compacted", "you took over
 * here" — and they explain the rows around them. Filtering them out would present a result
 * that reads as one continuous turn when it was not, which is the exact confusion the
 * divider exists to prevent.
 */
export function rowsMatchingFind(rows: readonly StreamRow[], query: string): StreamRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...rows];
    return rows.filter((r) => {
        if (r.type === 'divider') return true;
        return (
            r.main.toLowerCase().includes(q) || (r.meta !== null && r.meta.toLowerCase().includes(q))
        );
    });
}

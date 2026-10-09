import { describe, expect, it } from 'vitest';
import { nextEditId, rowsMatchingFind } from '../stream-nav';
import type { StreamRow } from '../agent-stream';

/**
 * Moving around the stream — `E` (next edit) and `/` (find), the last two keys on the
 * board's "New keys" line.
 *
 * Pure for the usual reason: the test environment has no DOM, so a rule that lives inside a
 * keyboard handler is a rule nobody checks. `AgentStream.tsx` described the lanes in a
 * comment for a whole release without them existing — the lesson generalises.
 */

const row = (over: Partial<StreamRow> & { id: string }): StreamRow => ({
    type: 'event',
    kind: 'tool',
    main: 'ran something',
    meta: null,
    at: 1_000,
    live: false,
    level: null,
    ...over,
});

const rows: StreamRow[] = [
    row({ id: 'a', kind: 'tool', main: 'npm test' }),
    row({ id: 'b', kind: 'edit', main: 'ipc.ts' }),
    row({ id: 'c', kind: 'think', main: 'considering the pty' }),
    row({ id: 'd', kind: 'edit', main: 'db.ts' }),
];

describe('E — the next edit', () => {
    it('finds the first edit when nothing is selected', () => {
        expect(nextEditId(rows, null)).toBe('b');
    });

    it('moves to the edit AFTER the selected one', () => {
        expect(nextEditId(rows, 'b')).toBe('d');
    });

    it('moves to the next edit when a NON-edit is selected', () => {
        // Selection is not always an edit — a tool call can be selected for the inspector.
        // `E` means "the next edit from here", not "the next edit after the last edit".
        expect(nextEditId(rows, 'a')).toBe('b');
        expect(nextEditId(rows, 'c')).toBe('d');
    });

    it('WRAPS to the first edit at the end, rather than going dead', () => {
        // A key that silently stops working at the bottom of a list reads as broken. Wrapping
        // is the behaviour every editor's find-next has, so it is the one people expect.
        expect(nextEditId(rows, 'd')).toBe('b');
    });

    it('is null when there are no edits at all, so the key does nothing visible', () => {
        // Not the first row, and not a throw: an agent that has edited nothing is a normal
        // state, and jumping somewhere arbitrary would be worse than not moving.
        expect(nextEditId([row({ id: 'x', kind: 'tool' })], null)).toBeNull();
    });

    it('tolerates a selected id that is no longer in the stream', () => {
        // The stream is live and a selected row can be filtered away by a lanes range.
        // Starting from the top is right; throwing would take the whole view down.
        expect(nextEditId(rows, 'gone')).toBe('b');
    });
});

describe('/ — find in the stream', () => {
    it('POSITIVE CONTROL: an empty query is not a filter', () => {
        // Without this, every assertion below would also pass against a function that always
        // returned everything.
        expect(rowsMatchingFind(rows, '')).toHaveLength(4);
        expect(rowsMatchingFind(rows, '   ')).toHaveLength(4);
    });

    it('matches the row text, case-insensitively', () => {
        expect(rowsMatchingFind(rows, 'IPC').map((r) => r.id)).toEqual(['b']);
        expect(rowsMatchingFind(rows, 'npm').map((r) => r.id)).toEqual(['a']);
    });

    it('matches the META too, which is where a tool says how it ended', () => {
        const withMeta = [row({ id: 'z', main: 'Bash', meta: 'exit 1' })];
        expect(rowsMatchingFind(withMeta, 'exit 1').map((r) => r.id)).toEqual(['z']);
    });

    it('KEEPS DIVIDERS, because they are punctuation the stream reads by', () => {
        // "context compacted" and "you took over here" explain the rows around them. Filtering
        // them out would leave a search result that reads as one continuous turn when it was
        // not — which is the specific confusion the divider exists to prevent.
        const withDivider = [...rows, row({ id: 'div', type: 'divider', kind: null, main: 'compacted' })];
        expect(rowsMatchingFind(withDivider, 'ipc').map((r) => r.id)).toEqual(['b', 'div']);
    });

    it('finds nothing rather than everything when nothing matches', () => {
        expect(rowsMatchingFind(rows, 'zzz')).toHaveLength(0);
    });
});

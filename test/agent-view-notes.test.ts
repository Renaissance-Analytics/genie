import { describe, expect, it } from 'vitest';
import { diffHeader, tabNote } from '../src/core/agent-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * TWO SMALL BOARD ROWS. The TAB NOTE, right of the tabs: on Files / Changes it says where they go (`Files and Changes
 * open the workspace file panel, filtered to atlas`); on the Stream it is a measurement — `61 events in the last 80s`
 * while rows arrive, `Last event received 14:31:02` once they stopped — and nothing when no row has a time. The DIFF
 * HEADER of the Inspector: `+42 −8 · 14:08:31 · edit 3 of 3`, each figure from the edit itself and its place among the
 * session's edits; counts only from a real before-and-after.
 */
const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const edit = (id: string, at: number, rawInput: unknown): TimedEvent => t(id, { kind: 'tool', toolCallId: id, name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput }, at);
const NOW = 1_760_000_100_000;

describe('tabNote', () => {
    it('Files and Changes: where they open, naming the agent', () => {
        expect(tabNote([], 'files', 'atlas', NOW)).toEqual({ kind: 'files', text: 'Files and Changes open the workspace file panel, filtered to atlas' });
        expect(tabNote([], 'changes', 'atlas', NOW)).toEqual({ kind: 'files', text: 'Files and Changes open the workspace file panel, filtered to atlas' });
    });

    it('Stream, rows arriving: the count in the last two minutes and the span they cover', () => {
        const rows = [
            t('a', { kind: 'message', speaker: 'you', peerName: null, text: 'go' }, NOW - 80_000),
            t('b', { kind: 'think', text: 'hmm', tokens: null }, NOW - 40_000),
            t('c', { kind: 'message', speaker: 'agent', peerName: null, text: 'ok' }, NOW - 1_000),
            t('old', { kind: 'message', speaker: 'agent', peerName: null, text: 'earlier' }, NOW - 10 * 60_000),
        ];
        expect(tabNote(rows, 'stream', 'atlas', NOW)).toEqual({ kind: 'live', text: '3 events in the last 80s' });
    });

    it('Stream, rows stopped: when the last one was received', () => {
        const rows = [t('a', { kind: 'message', speaker: 'agent', peerName: null, text: 'done' }, Date.UTC(2026, 9, 12, 14, 31, 2))];
        const note = tabNote(rows, 'stream', 'atlas', Date.UTC(2026, 9, 12, 14, 40, 0));
        expect(note?.kind).toBe('last');
        expect(note?.text).toMatch(/^Last event received \d{2}:\d{2}:\d{2}$/);
    });

    it('Stream with no timed row → null; a terminal or activity tab → null', () => {
        expect(tabNote([t('a', { kind: 'message', speaker: 'agent', peerName: null, text: 'x' }, null)], 'stream', 'atlas', NOW)).toBeNull();
        expect(tabNote([], 'stream', 'atlas', NOW)).toBeNull();
        expect(tabNote([], 'terminal', 'atlas', NOW)).toBeNull();
    });
});

describe('diffHeader', () => {
    const rows = [
        edit('e1', NOW - 3_000, { file_path: 'a.ts', old_string: 'a', new_string: 'a\nb' }),
        t('m', { kind: 'message', speaker: 'agent', peerName: null, text: 'x' }, NOW - 2_000),
        edit('e2', NOW - 1_000, { file_path: 'b.ts', old_string: 'p\nq\nr', new_string: 'p' }),
        edit('w', NOW, { file_path: 'c.ts', content: 'new' }),
    ];

    it('counts from the edit itself, its time, its place among the session’s edits', () => {
        expect(diffHeader(rows, 'e2')).toEqual({ plus: 0, minus: 2, at: NOW - 1_000, index: 2, total: 3 });
        expect(diffHeader(rows, 'e1')).toEqual({ plus: 1, minus: 0, at: NOW - 3_000, index: 1, total: 3 });
    });

    it('a Write has no before-and-after: no counts, still its time and place', () => {
        expect(diffHeader(rows, 'w')).toEqual({ plus: null, minus: null, at: NOW, index: 3, total: 3 });
    });

    it('not an edit, or nothing selected → null', () => {
        expect(diffHeader(rows, 'm')).toBeNull();
        expect(diffHeader(rows, null)).toBeNull();
        expect(diffHeader(rows, 'ghost')).toBeNull();
    });
});

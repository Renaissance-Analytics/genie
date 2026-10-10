import { describe, expect, it } from 'vitest';
import { laneSummary, parseLanes, formatLanes } from '../src/core/lanes.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';

const at = 1_760_000_000_000;
const timed = (event: StreamEvent, id: string, time: number | null = at): TimedEvent => ({ id, event, at: time });

const tool = (toolKind: 'execute' | 'edit' = 'execute'): StreamEvent => ({
    kind: 'tool', toolCallId: 't1', name: 'Bash', title: 'x', status: 'completed', toolKind, rawInput: {},
});

/**
 * LANES — four tracks over the current turn, and the sentence that replaces them.
 *
 * The rule worth testing is the refusal: *"With no timestamped rows, Lanes renders a sentence,
 * not four empty tracks."* Empty tracks read as **"nothing happened"**, when the truth is
 * **"Genie has no times for these"** — and those are different claims about an agent's work.
 */

describe('the lane selection lives in the route', () => {
    it('round-trips a multi-lane selection', () => {
        // Several lanes at once, because the design's pulldown is not a radio button. Comma
        // separated so the route stays readable and pasteable.
        expect(parseLanes('messages,edits')).toEqual(['messages', 'edits']);
        expect(formatLanes(['messages', 'edits'])).toBe('messages,edits');
    });

    it('treats an ABSENT parameter as not filtering, which is not the same as filtering to nothing', () => {
        /**
         * `null` means no filter is applied and everything shows. An empty selection means the
         * reader deliberately excluded every lane — and the Stream shows only what cannot be
         * filtered, which is the compaction divider. Collapsing them would make "show me
         * nothing" impossible to express.
         */
        expect(parseLanes(null)).toBeNull();
        expect(parseLanes('')).toEqual([]);
        expect(formatLanes(null)).toBeNull();
        expect(formatLanes([])).toBe('');
    });

    it('DROPS a lane name it does not recognise rather than failing the route', () => {
        // A stale link from an older version must still open. Dropping the unknown part shows
        // the reader a slightly wider stream, which is recoverable; refusing the route leaves
        // them on a blank surface, which is not.
        expect(parseLanes('messages,wat,edits')).toEqual(['messages', 'edits']);
    });

    it('drops duplicates, so a hand-edited route cannot double-count a lane', () => {
        expect(parseLanes('edits,edits,messages')).toEqual(['edits', 'messages']);
    });
});

describe('the summary — and when Lanes refuses to draw tracks', () => {
    const rows: readonly TimedEvent[] = [
        timed({ kind: 'message', speaker: 'you', peerName: null, text: 'go' }, 'm1'),
        timed({ kind: 'think', text: 'hmm', tokens: null }, 'th1'),
        timed(tool(), 'to1'),
        timed(tool('edit'), 'ed1'),
        timed(tool('edit'), 'ed2'),
    ];

    it('counts what is actually in each lane', () => {
        const summary = laneSummary(rows);

        expect(summary.drawable).toBe(true);
        expect(summary.counts).toEqual({ messages: 1, thoughts: 1, tools: 1, edits: 2 });
    });

    it('REFUSES to draw tracks when no row carries a time', () => {
        /**
         * The rule this module exists for. Four empty tracks read as "nothing happened"; the
         * truth is "Genie has no times for these" — a thread replayed from storage that kept
         * no timestamps.
         */
        const untimed = rows.map((r) => ({ ...r, at: null }));
        const summary = laneSummary(untimed);

        expect(summary.drawable).toBe(false);
        expect(summary.reason).toContain('no times');
        // The COUNTS are still real. What is missing is when, not whether.
        expect(summary.counts.edits).toBe(2);
    });

    it('draws when SOME rows are timed, because a partial timeline is still a timeline', () => {
        // Refusing because one row lacks a time would hide a usable view over a technicality.
        const mixed = [timed({ kind: 'think', text: 'x', tokens: null }, 'a', null), ...rows];
        expect(laneSummary(mixed).drawable).toBe(true);
    });

    it('refuses on an EMPTY stream, and says so differently', () => {
        // "Nothing has happened yet" and "we have no times for what happened" are different
        // sentences, and a reader needs to know which one they are looking at.
        const summary = laneSummary([]);

        expect(summary.drawable).toBe(false);
        expect(summary.reason).toContain('Nothing');
        expect(summary.reason).not.toContain('no times');
    });

    it('reports a MEASURED zero for an empty lane, which is a fact', () => {
        // A turn with no edits genuinely has none, and the lane should say so rather than
        // vanish — the reader is asking "did it change anything?" and `0` answers them.
        const summary = laneSummary([timed({ kind: 'message', speaker: 'you', peerName: null, text: 'go' }, 'm1')]);
        expect(summary.counts).toEqual({ messages: 1, thoughts: 0, tools: 0, edits: 0 });
    });
});

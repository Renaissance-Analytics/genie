import { describe, expect, it } from 'vitest';
import { pageSpan, type PageFrame } from '../scripts/local-door-span.mjs';

/**
 * LOCAL-DOOR ROW 10's COUNT CHECK, RACE-FREE (Tynn #917). The row compares the frames the native socket SENT on the app's
 * connection in an interval with the frames the page RECEIVED in it. It read the page's running total and the socket's
 * count in two separate calls, so a push landing between the two reads was on one side only. Measured on Linux
 * (queue item 1119-174556-1310a7, 15 runs): 2 failures, both "native 26, page 27", the extra frame a periodic
 * `local-snapshot` the page received after the socket's end count was read. Nothing was lost or reordered: every frame the
 * socket sent arrived, in order, on the same connection.
 *
 * The span is now taken from the socket's own counts, mapped onto the page by each frame's ordinal on its connection
 * (`n`: the n-th frame the page received on that handle, which is the n-th the socket sent on it).
 */

const h = 'app-handle';
/** The page's record: frames n = 1..last on `handle`, page seq = 100 + n, unless given. */
const received = (last: number, handle = h): PageFrame[] => Array.from({ length: last }, (_, i) => ({ seq: 101 + i, handle, n: i + 1 }));

describe('the page span of a native interval (Tynn #917)', () => {
    it("THE GATE'S ORDER: a push sent after the socket's end count was read, and received before the page's end read, is in neither span", () => {
        // The socket had sent 10 frames at the start read and 20 at the end read; frame 21 (a local-snapshot push) was sent
        // right after, and the page had received it by the time its own total was read (121, which said 11 frames).
        const span = pageSpan(received(21), h, 10, 20);
        expect(span).toEqual({ from: 110, to: 120 });
        expect(span!.to - span!.from).toBe(20 - 10);
    });

    it('THE OTHER ORDER: a frame sent before the start count was read, and received after it, is in neither span', () => {
        // The page's own start read would have said 109 (frame 10 still in flight); the span starts at frame 10 wherever it landed.
        const frames = received(20);
        expect(pageSpan(frames, h, 10, 20)).toEqual({ from: 110, to: 120 });
    });

    it('not there yet: no span until the page has received the frame the socket counted last', () => {
        expect(pageSpan(received(19), h, 10, 20)).toBeNull();
    });

    it('a frame on another connection inside the span is still counted, so a frame the socket never sent still fails the check', () => {
        const frames = received(20).map((f) => (f.n > 15 ? { ...f, seq: f.seq + 1 } : f));
        frames.push({ seq: 116, handle: 'other-handle', n: 1 });
        const span = pageSpan(frames, h, 10, 20)!;
        expect(span.to - span.from).toBe(11);
    });

    it('an empty interval spans nothing', () => {
        expect(pageSpan(received(12), h, 12, 12)).toEqual({ from: 112, to: 112 });
    });

    it('a span from the first frame on the connection starts just before it', () => {
        expect(pageSpan(received(5), h, 0, 5)).toEqual({ from: 100, to: 105 });
    });

    it('a start frame the page no longer holds is said, never guessed', () => {
        const frames = received(30).filter((f) => f.n > 12);
        expect(() => pageSpan(frames, h, 10, 20)).toThrow(/frame 10 .* no longer/);
    });
});

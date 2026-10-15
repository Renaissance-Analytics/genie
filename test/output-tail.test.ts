import { describe, expect, it } from 'vitest';
import { LOG_MAX_CHARS, LOG_MAX_LINES, OutputTail } from '../src/core/output-tail.js';

/**
 * A PROCESS'S OUTPUT, BOUNDED (hosting ship line P1). The tail the supervisor keeps for every background process: what a
 * person opens under the row and an agent reads with `processes logs`, after the pty — and its scrollback — are gone.
 * Bounded twice (lines and characters) and every cut COUNTED, so a log that is a tail says so.
 */

const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);

describe('the output tail', () => {
    it('keeps lines as they arrive, across chunk boundaries, with the line still being written', () => {
        const t = new OutputTail();
        t.append('Processing jo');
        t.append('b 1\r\nProcessed job 1\nwaiting');
        const log = t.read();
        expect(log.text.split('\n')).toEqual(['Processing job 1', 'Processed job 1', 'waiting']);
        expect(log).toMatchObject({ lines: 3, dropped: 0 });
    });

    it('is bounded by LINES — counted: 2 500 in, the last 2 000 kept, 500 dropped and said so', () => {
        const t = new OutputTail();
        t.append(`${numbered(1, 2_500).join('\n')}\n`);
        const log = t.read();
        expect(LOG_MAX_LINES).toBe(2_000);
        expect(log.lines).toBe(2_000);
        expect(log.text.split('\n')).toHaveLength(2_000);
        expect(log.text.split('\n')[0]).toBe('line 501');
        expect(log.text.split('\n').at(-1)).toBe('line 2500');
        expect(log.dropped).toBe(500);
    });

    it('is bounded by CHARACTERS — a few huge lines cannot grow it past the cap (control: under the cap nothing is cut)', () => {
        const small = new OutputTail(2_000, 1_000);
        small.append(`${'a'.repeat(400)}\n`);
        expect(small.read()).toMatchObject({ lines: 1, dropped: 0 });

        const t = new OutputTail(2_000, 1_000);
        for (let i = 0; i < 10; i++) t.append(`${String(i).repeat(400)}\n`);
        const log = t.read();
        expect(log.text.length).toBeLessThanOrEqual(1_000);
        expect(log.lines).toBe(2);
        expect(log.dropped).toBe(8);
        expect(log.text.split('\n')[1]).toBe('9'.repeat(400));
        expect(LOG_MAX_CHARS).toBe(256_000);
    });

    it('a line that never ends is cut from its start, and the cut is counted', () => {
        const t = new OutputTail(10, 100);
        t.append('x'.repeat(250));
        const log = t.read();
        expect(log.text).toBe('x'.repeat(100));
        expect(log.dropped).toBe(1);
    });

    it('reads the last N lines on request', () => {
        const t = new OutputTail();
        t.append(`${numbered(1, 10).join('\n')}\n`);
        expect(t.read(3).text.split('\n')).toEqual(['line 8', 'line 9', 'line 10']);
        expect(t.read(3).lines).toBe(3);
        expect(t.read(0)).toMatchObject({ text: '', lines: 0 });
    });

    it('strips colour and cursor sequences when READ (one split across chunks too), and shows a redrawn progress line as last drawn', () => {
        const t = new OutputTail();
        t.append('\x1b[32mINFO\x1b');
        t.append('[0m ready\n');
        t.append('\x1b]0;title\x07compiling 10%\rcompiling 55%\rcompiling 100%\n');
        expect(t.read().text.split('\n')).toEqual(['INFO ready', 'compiling 100%']);
    });

    it('Genie’s own lines are always on a line of their own, never glued to a half-written one', () => {
        const t = new OutputTail();
        t.append('half a line');
        t.note('exited with code 1');
        expect(t.read().text.split('\n')).toEqual(['half a line', '[genie] exited with code 1']);
    });
});

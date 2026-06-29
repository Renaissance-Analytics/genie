import { describe, expect, it } from 'vitest';
import { describeOsc, extractOscSequences } from '../osc-debug';

const ESC = '\x1b';
const BEL = '\x07';
const ST = '\x1b\\';

describe('extractOscSequences', () => {
    it('captures an OSC 52 clipboard write terminated by BEL', () => {
        const data = `before${ESC}]52;c;aGVsbG8=${BEL}after`;
        expect(extractOscSequences(data)).toEqual(['52;c;aGVsbG8=']);
    });

    it('captures an OSC sequence terminated by ST (ESC \\)', () => {
        expect(extractOscSequences(`${ESC}]52;c;Zm9v${ST}`)).toEqual(['52;c;Zm9v']);
    });

    it('captures multiple OSC sequences in one chunk (e.g. title + clipboard)', () => {
        const data = `${ESC}]0;my title${BEL}text${ESC}]52;c;YmFy${BEL}`;
        expect(extractOscSequences(data)).toEqual(['0;my title', '52;c;YmFy']);
    });

    it('returns nothing when the pty emits no OSC (the "TUI sent nothing" case)', () => {
        expect(extractOscSequences('plain text\r\n\x1b[31mred\x1b[0m')).toEqual([]);
    });

    it('handles an OSC 52 read request (?)', () => {
        expect(extractOscSequences(`${ESC}]52;c;?${BEL}`)).toEqual(['52;c;?']);
    });
});

describe('describeOsc', () => {
    it('tags OSC 52 prominently', () => {
        expect(describeOsc('52;c;aGVsbG8=')).toContain('OSC52(clipboard)');
    });

    it('labels other idents generically', () => {
        expect(describeOsc('0;window title')).toContain('OSC0');
    });

    it('truncates a long payload', () => {
        const long = `52;c;${'A'.repeat(500)}`;
        const out = describeOsc(long);
        expect(out).toContain('chars)');
        expect(out.length).toBeLessThan(long.length);
    });
});

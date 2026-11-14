import { describe, expect, it } from 'vitest';
import { commandOutputMasker } from '../src/main/command-output-masker.js';

const MASK = '********';
// Intentionally synthetic, with no credential-shaped prefix for secret scanners.
const CREDENTIAL = ['fixture', 'credential', '633'].join('-');

function rig(secrets: readonly string[] = [CREDENTIAL]) {
    const chunks: string[] = [];
    const stream = commandOutputMasker(secrets, (data) => { chunks.push(data); });
    return { ...stream, chunks, text: () => chunks.join('') };
}

describe('service command output is masked before live publication (#633)', () => {
    it('masks a whole known credential before a subscriber sees it', () => {
        const w = rig();
        w.write(`before ${CREDENTIAL} after\n`);
        expect(w.text()).toBe(`before ${MASK} after\n`);
        expect(w.chunks.every((chunk) => !chunk.includes(CREDENTIAL))).toBe(true);
    });

    it('withholds an unfinished credential prefix instead of publishing it to IPC', () => {
        const w = rig();
        w.write(`before ${CREDENTIAL.slice(0, 9)}`);
        expect(w.text()).toBe('before ');
        w.write(`${CREDENTIAL.slice(9)} after\n`);
        expect(w.text()).toBe(`before ${MASK} after\n`);
    });

    it('handles every possible two-chunk split without exposing the credential or losing ordinary output', () => {
        for (let split = 1; split < CREDENTIAL.length; split += 1) {
            const w = rig();
            w.write(`before ${CREDENTIAL.slice(0, split)}`);
            expect(w.text(), `prefix leaked at split ${split}`).toBe('before ');
            w.write(`${CREDENTIAL.slice(split)} after\n`);
            w.finish();
            expect(w.text(), `wrong final text at split ${split}`).toBe(`before ${MASK} after\n`);
        }
    });

    it('handles a credential delivered one character at a time', () => {
        const w = rig();
        for (const character of CREDENTIAL) {
            w.write(character);
            expect([ '', MASK ]).toContain(w.text());
        }
        w.finish();
        expect(w.text()).toBe(MASK);
    });

    it('prefers the longest overlapping credential without leaking its suffix', () => {
        const short = 'fixture-633';
        const long = `${short}-extended`;
        const w = rig([short, long]);
        w.write(short);
        expect(w.text()).toBe('');
        w.write('-extended\n');
        w.finish();
        expect(w.text()).toBe(`${MASK}\n`);
    });

    it('treats credential punctuation literally and masks repeated occurrences', () => {
        const secret = 'fixture.[633]+(sample)';
        const w = rig([secret]);
        w.write(`value=${secret}; again=${secret}!\n`);
        w.finish();
        expect(w.text()).toBe(`value=${MASK}; again=${MASK}!\n`);
    });

    it('masks an incomplete secret prefix at end of stream instead of disclosing it', () => {
        const w = rig();
        w.write(`truncated ${CREDENTIAL.slice(0, 10)}`);
        expect(w.text()).toBe('truncated ');
        w.finish();
        expect(w.text()).toBe(`truncated ${MASK}`);
    });

    it('releases an ordinary suffix once it can no longer form a credential', () => {
        const w = rig();
        w.write('fixture-');
        expect(w.text()).toBe('');
        w.write('not-a-credential\n');
        expect(w.text()).toBe('fixture-not-a-credential\n');
    });

    it('isolates masking state between simultaneous commands', () => {
        const left = rig(); const right = rig(['different-fixture-633']);
        left.write(CREDENTIAL.slice(0, 8));
        right.write(`${CREDENTIAL}\n`);
        expect(right.text()).toBe(`${CREDENTIAL}\n`);
        expect(left.text()).toBe('');
        left.write(CREDENTIAL.slice(8)); left.finish();
        expect(left.text()).toBe(MASK);
    });

    it('finishes once and refuses late output after completion', () => {
        const w = rig();
        w.write('ordinary\n'); w.finish(); w.finish(); w.write('late data\n');
        expect(w.text()).toBe('ordinary\n');
    });

    it('CONTROL: no credentials streams ordinary output immediately, without waiting for completion', () => {
        const w = rig([]);
        w.write('first\n');
        expect(w.text()).toBe('first\n');
        w.write('second\n');
        expect(w.text()).toBe('first\nsecond\n');
    });

    it('CONTROL: empty credentials do not mask everything or block live ordinary output', () => {
        const w = rig(['', '', CREDENTIAL, CREDENTIAL]);
        const output = `${'ordinary output '.repeat(2_000)}\n`;
        w.write(output);
        expect(w.text()).toBe(output);
    });
});

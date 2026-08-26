import { describe, expect, it } from 'vitest';
import { appendCapped, TRUNCATION_MARKER } from '../seams';

/**
 * A capture that silently drops the FRONT (genie#280).
 *
 * `defaultCommandRunner` keeps only the last 8,000 bytes of a command's output.
 * That is the RIGHT choice for what the cap was written for — `seams.ts` says so
 * itself: "Cap what we keep from a chatty command — this output exists to
 * explain", and for error text the last lines are the useful ones.
 *
 * The failure is that nothing distinguished *explain* from *capture*. A caller
 * collecting DATA got the same silent truncation, and this bit for real: the CA
 * bundle export printed ~130KB of PEM to stdout, the capture kept its tail, and
 * 4 roots out of 80 survived — exit 0, a syntactically valid PEM on disk, tests
 * green. A bundle missing 95% of its anchors, presented as a success.
 *
 * Front-truncation is the worst direction for exactly this reason. Structured
 * output carries its header, schema or opening delimiter first, so dropping the
 * front destroys the part that would have made the corruption detectable: a
 * truncated JSON document fails to parse and gets noticed, a truncated PEM stays
 * syntactically valid and does not.
 *
 * The fix is a MARKER, not a bigger buffer. Any buffer is the wrong size
 * eventually, and raising it converts a reliable failure into a rarer one, which
 * is worse. A marker makes truncation a fact the caller can see and act on.
 */
describe('appendCapped', () => {
    const LIMIT = 100;

    it('leaves output that fits completely alone', () => {
        const got = appendCapped('', 'hello world', LIMIT);

        expect(got).toBe('hello world');
        expect(got).not.toContain(TRUNCATION_MARKER);
    });

    it('keeps the TAIL when output overflows — the explain case still works', () => {
        const got = appendCapped('', 'x'.repeat(150) + 'THE-END', LIMIT);

        expect(got).toContain('THE-END');
        expect(got.length).toBeLessThanOrEqual(LIMIT + 200);
    });

    it('MARKS the truncation, so a data caller can see it happened', () => {
        const got = appendCapped('', 'y'.repeat(500), LIMIT);

        expect(got).toContain(TRUNCATION_MARKER);
        // The counts are the actionable part: "how much did I lose" decides
        // whether a caller can proceed on what is left.
        expect(got).toMatch(/\d+ bytes dropped/);
    });

    it('marks ONCE however many chunks arrive, not once per chunk', () => {
        // Output streams in chunks; a marker per chunk would bury the output in
        // markers and make the count meaningless.
        let acc = '';
        for (let i = 0; i < 20; i++) acc = appendCapped(acc, 'z'.repeat(50), LIMIT);

        // Counted by split rather than a regex: the marker starts with `[`, so
        // used raw as a pattern it silently reads as a character class.
        const count = acc.split(TRUNCATION_MARKER).length - 1;
        expect(count).toBe(1);
    });

    it('reports the TOTAL dropped across chunks, not just the last one', () => {
        let acc = '';
        for (let i = 0; i < 10; i++) acc = appendCapped(acc, 'w'.repeat(100), LIMIT);

        const m = acc.match(/(\d+) bytes dropped/);
        expect(m).not.toBeNull();
        // 1000 bytes in, ~100 kept, so far more than one chunk's worth is gone.
        expect(Number(m![1])).toBeGreaterThan(500);
    });

    it('keeps the marker at the FRONT, where the dropped bytes were', () => {
        // At the end it reads as trailing noise after the real output; at the
        // front it reads as what it is — a hole where the beginning should be.
        const got = appendCapped('', 'q'.repeat(400), LIMIT);

        expect(got.indexOf(TRUNCATION_MARKER)).toBe(0);
    });

    it('never loses the newest bytes to make room for the marker', () => {
        // The tail is the whole point of the cap. A marker that pushed real
        // output out of the window would trade one silent loss for another.
        const got = appendCapped('', 'a'.repeat(300) + 'NEWEST', LIMIT);

        expect(got).toContain('NEWEST');
    });
});

import { describe, expect, it } from 'vitest';
import { flatten } from '../dev-channel-consent';

/**
 * Pin what `flatten` strips (CodeQL `js/overly-large-range`, alert #20).
 *
 * ## The alert is about the SPELLING, not the behaviour
 *
 * The class was `[\0-\b\v-\037]`. Measured against Node before anything was
 * changed, it matched exactly 30 code points — `0x00-0x08` and `0x0B-0x1F` — and
 * matched neither space nor any printable character. So the intent CodeQL
 * doubted was in fact correct: every C0 control except tab and newline, which the
 * `\s+` collapse handles instead.
 *
 * What was wrong is that `\037` is a legacy OCTAL escape. Read as decimal 37 it
 * is `%`, which would make the range `0x0B-0x25` and swallow space, `!`, `"`,
 * `#`, `$` and `%` — and that is the reading CodeQL reports. Rewritten as `\x1F`
 * it says the same thing to a scanner, a reviewer, and the engine.
 *
 * ## Why this file exists at all
 *
 * Nothing pinned the set. That is the real finding: **no test would have failed
 * if the class HAD been as wide as CodeQL read it**, because the replacement is a
 * space and the existing tests only use text where turning a space into a space
 * changes nothing. So the alert could not be dismissed by reading the code, and a
 * future widening would land silently.
 *
 * `flatten` feeds a CONSENT decision — what it strips changes what a human is
 * shown before they approve loading a development channel — so the set is pinned
 * exactly, in both directions.
 */
describe('flatten strips C0 controls and nothing else', () => {
    /**
     * Every code point the function removes, over ASCII.
     *
     * Bounded at 0x7F deliberately. Above it the question stops being about the
     * C0 class: `\s` matches U+00A0, so the COLLAPSE step flattens a non-breaking
     * space even though the control class never touches it. That is real and is
     * asserted on its own below rather than filtered away here.
     */
    function strippedSet(): number[] {
        const out: number[] = [];
        for (let c = 0; c <= 0x7f; c++) {
            // Wrap in sentinels: `trim()` would hide a leading/trailing result,
            // and `\s+` collapsing means a bare probe cannot tell "removed" from
            // "was already whitespace".
            const probed = flatten(`A${String.fromCharCode(c)}B`);
            if (probed === 'A B' || probed === 'AB') out.push(c);
        }
        return out;
    }

    it('strips exactly 0x00-0x08 and 0x0B-0x1F', () => {
        const expected = [
            ...Array.from({ length: 9 }, (_, i) => i), // 0x00-0x08
            ...Array.from({ length: 21 }, (_, i) => 0x0b + i), // 0x0B-0x1F
        ];
        // Tab and newline are absent from the class on purpose: `\s+` collapses
        // them, so listing them would be redundant rather than wrong.
        const stripped = strippedSet().filter((c) => c !== 0x09 && c !== 0x0a && c !== 0x20);
        expect(stripped).toEqual(expected);
    });

    it('does NOT touch the printable characters a mis-read octal would eat', () => {
        // The exact set the decimal-37 reading would swallow. If any of these
        // vanished, a channel name or a dialog label containing one would be
        // mangled before the consent match ever saw it.
        for (const ch of ['!', '"', '#', '$', '%', '&', "'"]) {
            expect(flatten(`A${ch}B`)).toBe(`A${ch}B`);
        }
    });

    it('leaves ordinary text and the channel-entry punctuation intact', () => {
        expect(flatten('server:genie-agentinbox-channel')).toBe('server:genie-agentinbox-channel');
        expect(flatten('WARNING: Loading development channels')).toBe(
            'WARNING: Loading development channels',
        );
    });

    it('still removes real CSI sequences, and does not match a literal bracket run', () => {
        // The neighbouring replace carries a raw ESC byte in source. Escaped to
        // `\x1B` in the same change: invisible bytes in a regex literal are the
        // same defect as an ambiguous octal, one line up. If that ESC were ever
        // lost the regex would degrade to a literal-"[" matcher, so both halves
        // are asserted here.
        expect(flatten('[2J[Hhello')).toBe('hello');
        expect(flatten('[0m[36mChannels:')).toBe('Channels:');
        // Text that merely LOOKS like a sequence, with no ESC, is left alone.
        expect(flatten('a [36m b')).toBe('a [36m b');
    });

    it('collapses the whitespace a hard-wrapped repaint introduces', () => {
        expect(flatten('Channels:\r\n   server:x\t\tnext')).toBe('Channels: server:x next');
    });

    it('a non-breaking space is collapsed by \\s, not by the control class', () => {
        // Recorded because the probe above found it: U+00A0 is outside C0 and the
        // control class does not match it, but `\s+` does — so it flattens to a
        // space anyway. Worth pinning, since a dialog rendered with NBSP padding
        // still has to compare equal to the plain-space form the matcher expects.
        expect(flatten('Channels: server:x')).toBe('Channels: server:x');
        // …and DEL is untouched: the class was not widened to 0x7F.
        expect(flatten('A\x7FB')).toBe('A\x7FB');
    });
});

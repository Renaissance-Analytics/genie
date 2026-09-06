import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The ask modal must NEVER navigate — the genie#196 regression gate, extended to
 * cover the file drawer (Tynn story #272).
 *
 * genie#196: a link in the question markdown navigated the frameless
 * always-on-top window ITSELF. The modal became a browser tab showing the link,
 * the question and its options were gone, and the agent that raised it was
 * stranded with no way back. `main/ask/link-route.ts` closed that at the window
 * level — `will-navigate` prevented, `setWindowOpenHandler` denied — and
 * `main/ask/__tests__/link-route.test.ts` holds that line.
 *
 * Story #272 adds a new way to reintroduce it: a file path in the question is now
 * something you can CLICK. Rendered as an anchor, that click is a navigation the
 * window guard has to catch — and a `file:` URL is exactly the case that guard
 * DROPS rather than opens, so the modal would go blank-ish and the file would
 * never appear. The affordance is therefore a button that opens a pane in this
 * page, and this file pins that: the ask page renders no anchors and reaches for
 * no navigation API of its own.
 *
 * The `expect(...).not` assertions here would all pass against a page that
 * rendered nothing at all, so each block is paired with a positive control
 * asserting the affordance under test is actually present.
 */

const SRC = fs.readFileSync(path.resolve(__dirname, '../../pages/ask.tsx'), 'utf8');

/** The source with comments and string literals removed — what the page DOES. */
const CODE = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the ask page never navigates itself', () => {
    it('renders the file references it found (positive control)', () => {
        // Without this the four assertions below pass against a page that has no
        // file affordance at all — the "it is absent" test on a corpse.
        expect(CODE).toContain('extractFileRefs');
        expect(CODE).toContain('ask-file-chip');
    });

    it('renders no anchor elements', () => {
        expect(CODE).not.toMatch(/<a[\s>]/);
    });

    it('sets no href', () => {
        expect(CODE).not.toMatch(/\bhref\s*=/);
    });

    it('assigns no location', () => {
        expect(CODE).not.toMatch(/\blocation\s*(?:\.\s*(?:href|assign|replace)\s*[=(]|=)/);
    });

    it('opens no window', () => {
        expect(CODE).not.toMatch(/\bwindow\s*\.\s*open\s*\(/);
    });

    it('opens the file reference with a button, not a link', () => {
        const chip = /<button[^>]*ask-file-chip/.exec(CODE);
        expect(chip, 'the file chip must be a <button>').not.toBeNull();
    });
});

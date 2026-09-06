import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The canvas modal is sized, and sized LATER than the card it borrows from.
 *
 * ## The bug this is the standing answer to
 *
 * `FlowCanvasModal` renders `<div className="prompt-card flowmgr-canvas">`, and
 * `.flowmgr-canvas` **did not exist in `master.css`**. The class was added and
 * its rules never were, so the graph editor inherited `.prompt-card` whole:
 *
 *     .prompt-card { width: 380px; max-width: calc(100vw - 32px); }
 *
 * 380px, less 36px of padding, is 344px of content — and fancy-flow lays
 * `.ff-editor` out as `grid-template-columns: 216px 1fr 300px`. Palette and
 * config panel alone want 516px, so the `1fr` canvas column collapses to
 * nothing and the palette becomes one long scrolling list with a sliver of
 * graph beside it. That is what the owner opened.
 *
 * ## Why a source-level test, and why the ORDER matters
 *
 * `.prompt-card` and `.flowmgr-canvas` are both single-class selectors, so they
 * have EQUAL specificity and the cascade is decided by source order alone. A
 * correct-looking `.flowmgr-canvas` written above `.prompt-card` would lose,
 * silently, and look exactly like this bug. That is a fact about the stylesheet
 * as a document, which is what makes it answerable here rather than only in a
 * browser.
 *
 * The E2E in `e2e/master-window.spec.ts` measures what actually rendered. This
 * one says WHY when it breaks, and runs in milliseconds on every change.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');

/**
 * The declaration block for a single-class selector, and where it starts.
 *
 * Deliberately crude — one flat `{ … }`, no nesting — because every selector
 * asked about below is a plain top-level rule. `(?![-\w])` stops `.flowmgr-canvas`
 * matching inside `.flowmgr-canvas-body`, which is the one collision that would
 * make an assertion here quietly meaningless.
 */
function ruleFor(className: string): { body: string; at: number } | null {
    const re = new RegExp(`(^|\\n)([^\\n{}]*\\.${className}(?![-\\w])[^\\n{}]*)\\{([^{}]*)\\}`);
    const m = re.exec(CSS);
    return m ? { body: m[3]!, at: m.index } : null;
}

/** Does this rule set `prop`, in its own right? */
const declares = (body: string, prop: string) =>
    new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(body);

describe('the flow canvas modal is a workspace, not a prompt', () => {
    it('POSITIVE CONTROL: the parser reads real rules and detects absent ones', () => {
        // Every assertion below is `ruleFor(...)`. If the reader broke — a moved
        // stylesheet, a regex that stopped matching — they would all report
        // "missing" or all report "present", and the suite would guard nothing.
        const card = ruleFor('prompt-card');
        expect(card, '.prompt-card is missing — has master.css moved?').not.toBeNull();
        expect(ruleFor('flowmgr-row'), 'a known .flowmgr rule is unreadable').not.toBeNull();
        expect(ruleFor('flowmgr-no-such-class-exists')).toBeNull();

        // The premise. If `.prompt-card` ever stops being a narrow fixed width,
        // this whole file is arguing about something that no longer exists, and
        // it should say so rather than keep passing.
        expect(declares(card!.body, 'width')).toBe(true);
        expect(card!.body).toMatch(/width:\s*380px/);
    });

    it('gives .flowmgr-canvas its own width and height', () => {
        const canvas = ruleFor('flowmgr-canvas');

        expect(
            canvas,
            '.flowmgr-canvas is used in FlowManagerFlyout.tsx but has no rule — ' +
                'the editor is inheriting .prompt-card’s 380px',
        ).not.toBeNull();
        expect(declares(canvas!.body, 'width'), '.flowmgr-canvas must set its own width').toBe(
            true,
        );
        expect(
            declares(canvas!.body, 'height'),
            '.flowmgr-canvas must set its own height — .prompt-card sets none, so the ' +
                'editor falls back to fancy-flow’s fixed 720px',
        ).toBe(true);
    });

    it('sets that width AFTER .prompt-card, or the cascade discards it', () => {
        // Equal specificity: last one in the file wins. This is the assertion
        // that a plausible-looking fix can still fail.
        const card = ruleFor('prompt-card')!;
        const canvas = ruleFor('flowmgr-canvas')!;

        expect(
            canvas.at,
            '.flowmgr-canvas is declared BEFORE .prompt-card; at equal specificity ' +
                'the later rule wins, so the 380px would survive',
        ).toBeGreaterThan(card.at);
    });

    it('lets the body shrink so the canvas fills what is left', () => {
        // `.prompt-card` is a flex column. A flex child will not shrink below
        // its content unless `min-height: 0` says it may — without it the body
        // keeps the editor's natural height and the CARD scrolls instead of the
        // canvas, which looks like a different bug entirely.
        const body = ruleFor('flowmgr-canvas-body');

        expect(body, '.flowmgr-canvas-body is used in the TSX but has no rule').not.toBeNull();
        expect(declares(body!.body, 'min-height')).toBe(true);
        expect(body!.body).toMatch(/min-height:\s*0/);
    });
});

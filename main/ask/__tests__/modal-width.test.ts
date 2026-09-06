import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_MODAL_WIDTH, ASK_DRAWER_WIDTH, askWindowBounds } from '../drawer-bounds';

/**
 * The question column's width is ONE fact (genie#458).
 *
 * `ASK_MODAL_WIDTH` sizes the BrowserWindow; `.ask-shell.with-file .ask-frame`
 * sizes the column inside it once the file drawer opens. They have to agree, and
 * they agreed only because both said `560` — so widening the window on its own
 * would have left the column at 560 and handed every new pixel to the drawer,
 * which looks exactly like the change having no effect.
 *
 * The CSS must therefore READ the width rather than repeat it.
 */
const CSS = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'renderer', 'styles', 'globals.css'),
    'utf8',
);

/** The body of a rule, by selector. Null when the rule is absent. */
function ruleBody(selector: string): string | null {
    const at = CSS.indexOf(selector + ' {');
    if (at === -1) return null;
    const open = CSS.indexOf('{', at);
    const close = CSS.indexOf('}', open);
    return close === -1 ? null : CSS.slice(open + 1, close);
}

describe('the ask modal is wide enough to read a question in', () => {
    it('gives the question column a comfortable measure, not a squeeze', () => {
        // The owner's report was "the whole FTQ modal should be wider to begin
        // with, it squished everything". 560 is narrower than the options grid
        // and the markdown body want; this pins the floor so it cannot drift
        // back without someone deciding to.
        expect(ASK_MODAL_WIDTH).toBeGreaterThanOrEqual(720);
    });

    it('opens the drawer BESIDE the question rather than over it', () => {
        const workArea = { x: 0, y: 0, width: 3840, height: 2160 };
        const current = { x: 100, y: 100, width: ASK_MODAL_WIDTH, height: 700 };
        const open = askWindowBounds({ current, workArea, drawerOpen: true });
        // The widened window must have room for the full question column AND a
        // drawer; if it did not, the drawer would be eating the question.
        expect(open.width).toBe(ASK_MODAL_WIDTH + ASK_DRAWER_WIDTH);
    });
});

describe('the column width is not written down twice', () => {
    it('sizes the drawer-open question column from the shared custom property', () => {
        const body = ruleBody('.ask-shell.with-file .ask-frame');
        expect(body).not.toBeNull();
        expect(body).toContain('var(--ask-modal-width)');
    });

    it('does not hardcode a pixel width that must match ASK_MODAL_WIDTH', () => {
        const body = ruleBody('.ask-shell.with-file .ask-frame') ?? '';
        // POSITIVE CONTROL: the rule was found and has a flex basis at all, so
        // "no hardcoded px" below is a real absence rather than an empty string.
        expect(body).toContain('flex:');
        expect(body).not.toMatch(/flex:[^;]*\b\d{3,}px/);
    });
});

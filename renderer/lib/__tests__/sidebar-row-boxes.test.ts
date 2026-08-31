import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The workspace row's controls are BOXES — the owner's word for them is "side
 * boxes", and the IssueWatch control was to become "a square".
 *
 * The first attempt read "square" as square CORNERS and only swapped the
 * border-radius. It left the geometry alone, so the row shipped with a 40x13
 * IssueWatch lozenge and a 30x14 runtime lozenge sitting next to 18x18 agent
 * avatars. The owner's verdict, with a screenshot: "why the FUCK was the
 * workspace sidebar not redesigned the way I fucking told you to make it?"
 *
 * A rounded rectangle three times wider than it is tall is not a square by any
 * reading, so the property under test is the ASPECT RATIO and the SHARED EDGE
 * — not the presence of a `border-radius`. Getting the radius right while the
 * box stays a lozenge is exactly the bug this pins, and a radius-only test
 * would have passed the entire time the lozenges were on screen.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');

/** The body of the first rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
    const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /^([^@\s}][^{}]*)\{([^{}]*)\}/gm;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        const selectors = m[1]!.split(',').map((s) => s.trim());
        if (selectors.includes(selector)) return m[2]!;
    }
    throw new Error(`no rule for ${selector}`);
}

/** A `px` declaration's number, e.g. `width: 18px` -> 18. */
function px(selector: string, prop: string): number {
    const body = ruleBody(selector);
    const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`, 'm').exec(body);
    if (m) return Number(m[1]);
    throw new Error(`${selector} declares no ${prop} in px:\n${body}`);
}

/** Every control that sits in the row, and must read as a sibling of the others. */
const BOXES = ['.iw-pill', '.tproj-head .runtime-pill'];

/** The size the agent avatars already are, and therefore the size the row is. */
const EDGE = 18;

describe('the workspace row is a line of squares', () => {
    it.each(BOXES)('%s is square, not a lozenge', (selector) => {
        const w = px(selector, 'width');
        const h = px(selector, 'height');
        expect(w).toBe(h);
    });

    it.each(BOXES)('%s shares the avatar edge of %ipx', (selector) => {
        // One edge for the whole row. A square that is merely square while
        // being half the height of its neighbours still reads as a different
        // KIND of control, which is the thing being fixed.
        expect(px(selector, 'width')).toBe(EDGE);
        expect(px(selector, 'height')).toBe(EDGE);
    });

    it('the agent avatar is the edge the boxes match', () => {
        // POSITIVE CONTROL. If the avatars are ever resized, the two
        // assertions above are pinning a number that no longer means anything,
        // and this fails to say so rather than letting the row drift apart.
        expect(px('.ws-agent-avatar', 'width')).toBe(EDGE);
        expect(px('.ws-agent-avatar', 'height')).toBe(EDGE);
    });

    it('the IssueWatch square stacks its four dots, rather than lining them up', () => {
        // Four dots in a row is what MADE it a lozenge. In a square they have
        // to wrap, so the grid is the shape rather than an incidental choice.
        const body = ruleBody('.iw-pill');
        expect(body).toMatch(/display:\s*(inline-)?grid/);
        expect(body).toMatch(/grid-template-columns:\s*1fr\s+1fr/);
    });
});

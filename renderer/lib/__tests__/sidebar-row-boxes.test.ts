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
    // A bare `0` carries no unit and is still zero pixels -- `top: 0` is the
    // idiomatic way to write flush, so requiring `0px` would fail a
    // correct stylesheet.
    const zero = new RegExp(`(?:^|;)\\s*${prop}:\\s*0\\s*(?:;|$)`, 'm').exec(body);
    if (zero) return 0;
    throw new Error(`${selector} declares no ${prop} in px:\n${body}`);
}

/** The IssueWatch control, which is one square among the row's controls. */
const EDGE = 18;

describe('the workspace row is a line of squares', () => {
    it('.iw-pill is square, not a lozenge', () => {
        expect(px('.iw-pill', 'width')).toBe(px('.iw-pill', 'height'));
    });

    it('.iw-pill shares the avatar edge', () => {
        expect(px('.iw-pill', 'width')).toBe(EDGE);
        expect(px('.iw-pill', 'height')).toBe(EDGE);
    });

    it('the agent avatar is the edge the square matches', () => {
        // POSITIVE CONTROL. If the avatars are resized, the assertion above is
        // pinning a number that no longer means anything, and this says so.
        expect(px('.ws-agent-avatar', 'width')).toBe(EDGE);
        expect(px('.ws-agent-avatar', 'height')).toBe(EDGE);
    });

    it('the IssueWatch square stacks its four dots, rather than lining them up', () => {
        const body = ruleBody('.iw-pill');
        expect(body).toMatch(/display:\s*(inline-)?grid/);
        expect(body).toMatch(/grid-template-columns:\s*1fr\s+1fr/);
    });
});

/**
 * The SITE / PROCESS control is TWO BOXES STACKED, flush to the row's right
 * edge and to its top and bottom — the owner's words, after two wrong passes.
 *
 * First it was a 30x14 lozenge. Then I read "square" as square CORNERS and made
 * it an 18x18 box with its two halves SIDE BY SIDE, which is neither stacked
 * nor flush to anything. The spec is not a square at all: it is a full-height
 * strip on the right edge, split into an upper box and a lower box.
 *
 * So what is pinned here is the geometry that was actually asked for —
 * stacked ROWS, and zero offset on three sides. A test that only checked "is it
 * square" passed while the control was still wrong, twice.
 */
describe('the site/process control', () => {
    const body = () => ruleBody('.tproj-head .runtime-pill');

    it('STACKS its two boxes rather than sitting them side by side', () => {
        expect(body()).toMatch(/grid-template-rows:\s*1fr\s+1fr/);
        // And explicitly NOT the column split it had before.
        expect(body()).not.toMatch(/grid-template-columns:\s*1fr\s+1fr/);
    });

    it('is flush to the right edge and to the top and bottom', () => {
        // The row has 8px of padding; the control has to escape it on three
        // sides, so it is positioned rather than laid out as a flex child.
        expect(body()).toMatch(/position:\s*absolute/);
        for (const side of ['top', 'right', 'bottom']) {
            expect(px('.tproj-head .runtime-pill', side)).toBe(0);
        }
    });

    it('reserves its own width, so the row content cannot run under it', () => {
        // Taking the control out of flow is what makes "flush" possible and is
        // also how the workspace name would end up sliding beneath it.
        expect(px('.tproj-head', 'padding-right')).toBeGreaterThanOrEqual(
            px('.tproj-head .runtime-pill', 'width'),
        );
    });
});

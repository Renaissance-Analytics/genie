import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_KIND_CLASS } from '../workspace-kind';

/**
 * A GApp Development Workspace has to read as a DIFFERENT KIND of workspace at a
 * glance — including when it is selected (genie#245 follow-on).
 *
 * The first attempt did not. It marked a GDW with a 2px amber-500 ring while
 * every `.agi` envelope already wears a 1px amber-300 one, and gave the selected
 * row a gold-gradient wash within two percentage points of the envelope's. On
 * screen that is one treatment, not two: the owner's verdict was "this is not
 * very distinctive and it has the same selected bg gradient".
 *
 * So the property under test is DISTANCE, not the presence of a rule. A test
 * that only asserted "a `.ws-gapp-dev` rule exists" passed the whole time the
 * bug was on screen.
 *
 * The values live in the stylesheet and are read from it here, so this cannot
 * drift into a second copy of the palette that agrees with itself while
 * disagreeing with what renders.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');

/** The value of a `--token: <value>;` declaration, first occurrence. */
function token(name: string): string {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(CSS);
    if (!m) throw new Error(`no such token in master.css: ${name}`);
    return m[1]!.trim();
}

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

/** HSL hue in degrees, from a `#rrggbb`. */
function hue(hex: string): number {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error(`not a plain hex colour: ${hex}`);
    const n = parseInt(m[1]!, 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    const h =
        max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
}

/** Shortest distance between two hues, in degrees (0–180). */
function hueGap(a: string, b: string): number {
    const raw = Math.abs(hue(a) - hue(b));
    return Math.min(raw, 360 - raw);
}

/**
 * Far enough apart to be a different COLOUR rather than a shade of the same one.
 *
 * 60° is a sixth of the wheel — amber-300 to amber-500 is 8°, which is what
 * shipped and what the owner rejected.
 */
const DISTINCT_HUE_DEGREES = 60;

describe('the GDW mark is a different colour from the envelope mark', () => {
    it('is not a shade of the .agi envelope gold', () => {
        const gap = hueGap(token('--gapp-dev'), token('--agi-gold'));

        expect(
            gap,
            `--gapp-dev and --agi-gold are ${gap.toFixed(0)}° apart. Every .agi workspace already wears a gold hairline ring, so a GDW ring within a hue of it reads as the same ring on every workspace.`,
        ).toBeGreaterThanOrEqual(DISTINCT_HUE_DEGREES);
    });

    it('is not the selection colour either', () => {
        // Stated as policy in the stylesheet already: a marker that vanishes the
        // moment you select the row is not a marker.
        const gap = hueGap(token('--gapp-dev'), token('--agent'));

        expect(
            gap,
            `--gapp-dev and --agent (the selection indigo) are ${gap.toFixed(0)}° apart, so the mark would disappear into the selected state.`,
        ).toBeGreaterThanOrEqual(DISTINCT_HUE_DEGREES);
    });
});

describe('the SELECTED state is distinct too — the owner’s actual complaint', () => {
    const activeGdw = () => ruleBody('.tproj.agi.ws-gapp-dev.is-active > .tproj-head');
    const activeAgi = () => ruleBody('.tproj.agi.is-active > .tproj-head');

    it('does not paint a selected GDW with the envelope’s gradient', () => {
        expect(activeGdw()).not.toContain('--agi-gold-grad');
    });

    it('does not reuse the plain selected-row wash either', () => {
        expect(activeGdw()).not.toContain('--agent-soft');
    });

    it('paints a wash of its OWN — POSITIVE CONTROL', () => {
        // The two negatives above would both pass on a rule that set no
        // background at all, which would be its own bug (a selected GDW would
        // fall through to the envelope's gold). This is what makes them mean
        // something.
        expect(activeGdw()).toContain('--gapp-dev-grad');
        expect(activeAgi()).toContain('--agi-gold-grad');
    });

    it('does not draw that wash the same SHAPE as the envelope’s', () => {
        // Same hue-family mistake, one level down: two 135° diagonal washes at
        // near-identical alphas are one treatment even in different colours.
        expect(token('--gapp-dev-grad')).not.toContain('135deg');
        expect(token('--agi-gold-grad')).toContain('135deg');
    });
});

describe('a GDW carries a mark an ordinary envelope does not', () => {
    it('marks the row at rest, not only when it is selected', () => {
        // `.agi` gets its accent bar ONLY when active. If a GDW's only difference
        // is the ring colour, an UNSELECTED GDW in a list of envelopes is a
        // hairline apart from its neighbours — which is how this shipped.
        const atRest = ruleBody('.tproj.ws-gapp-dev > .tproj-head::before');

        expect(atRest).toContain('--gapp-dev');
    });

    it('is styled through the class the frozen first-party table hands out', () => {
        // The boundary that keeps a GApp from styling the workspace around it is
        // `WORKSPACE_KIND_CLASS`: a frozen lookup whose range is five fixed
        // strings, so no value a manifest carries can become a class name. This
        // pins the other end of that — the sheet styles the class the TABLE
        // produces, so renaming it in code cannot silently strip the chrome.
        const marked = WORKSPACE_KIND_CLASS['gapp-dev-workspace'];

        expect(CSS).toContain(`.tproj.${marked} > .tproj-head`);
        expect(CSS).toContain(`.crail-btn.${marked}`);
    });
});

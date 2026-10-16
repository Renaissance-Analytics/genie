import { ActivityLight } from '@particle-academy/react-fancy';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * THE DIRECTION ARROW MUST BE A CHARACTER THAT DRAWS.
 *
 * A guard in Genie for a fix in Fancy, because the Dashboard's comms column depends on it and
 * a regression upstream would land here silently.
 *
 * ## What was measured, and why this is pinned
 *
 * In a Liberation-only container, `ActivityLight direction="both"` rendered **U+21C4 `⇄` as
 * tofu** while `in` and `out` drew their arrows fine. Three directions, two working indicators
 * and one box — and a reader has no way to tell a font gap from a state. That inconsistency
 * was a better argument than the coverage was.
 *
 * The band that failed turned out to be WGL4, the repertoire Liberation targets. Measured with
 * a falsifier and four boundary probes: `↔` U+2194 draws, `⇆` U+21C6 does not, U+2195/21A8/
 * 25CA/2660 draw, U+2756 does not. Seven predictions, seven correct — the control failing as
 * predicted is what made it evidence rather than agreement.
 *
 * react-fancy 5.35.1 ships U+2194. **Do not "improve" this back to a prettier arrow** — the
 * prettier ones are outside WGL4 and draw as a box on a lean Linux machine.
 */

const DOUBLE_HEADED = '↔';
/** The ones that look better and are not covered. Each would fail this test, deliberately. */
const UNCOVERED = ['⇄', '⇆', '⇋', '⬌'];

describe('ActivityLight direction="both"', () => {
    it('renders a character that draws in a WGL4-only font', () => {
        const html = renderToStaticMarkup(
            <ActivityLight level="live" direction="both" label="kai and wren" />,
        );

        expect(html).toContain(DOUBLE_HEADED);
    });

    it('renders NONE of the prettier arrows that are outside the covered repertoire', () => {
        /**
         * Asserted as a COUNT over the alternatives rather than as "not U+21C4", so swapping
         * in a different uncovered arrow fails this too. The upstream test does the same thing
         * on their side; this one protects the surface that actually depends on it.
         */
        const html = renderToStaticMarkup(
            <ActivityLight level="live" direction="both" label="kai and wren" />,
        );

        expect(UNCOVERED.filter((char) => html.includes(char))).toEqual([]);
    });

    it('still draws single-direction arrows, which were never the problem', () => {
        // POSITIVE CONTROL: `in` and `out` were fine all along, and this proves the component
        // is rendering arrows at all rather than having quietly stopped.
        const inward = renderToStaticMarkup(<ActivityLight level="live" direction="in" label="x" />);
        const outward = renderToStaticMarkup(<ActivityLight level="live" direction="out" label="x" />);

        expect(inward).toContain('←');
        expect(outward).toContain('→');
    });

    it('renders no arrow at all when direction is omitted', () => {
        // Defaulting to `both` would assert traffic in two directions nobody observed — the
        // component's own rule, pinned here because the Dashboard relies on it.
        const html = renderToStaticMarkup(<ActivityLight level="live" label="x" />);

        expect(html).not.toContain(DOUBLE_HEADED);
        expect(html).not.toContain('←');
        expect(html).not.toContain('→');
    });
});

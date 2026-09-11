import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { declarationsFor } from '../../lib/css-rules';

/**
 * THE GENIE OS SURFACES ANIMATE ON WORK, NOT ON BEING OPEN (owner).
 *
 * Genie OS has no AgentPulse, so its activity read-outs are the flyout's
 * conic-gradient chase and the header icon's pulse. Both were keyed on being
 * open:
 *
 *   - `.genie-os-layer.is-open .genie-os-flyout { animation: genie-os-chase … }`
 *     — the shimmer ran for exactly as long as the panel was up.
 *   - the icon's `is-active` came from `activeIds`, which is "this spec has a
 *     live pty" (a panel joins on XTerm mount, leaves on exit) — so it too was
 *     true the whole time the OSA was open.
 *
 * An activity animation that means "you opened this" tells the user something
 * they can already see, and — worse — makes a working agent indistinguishable
 * from an idle one at a glance, which is the only thing the animation is for.
 *
 * ## What is asserted where
 *
 * The CSS half is here, because "which selector carries the animation" is
 * readable from source and the renderer env has no DOM. The behavioural half —
 * that nothing is actually animating while the panel sits idle — is in
 * `e2e/master-window.spec.ts`, measured with `getAnimations()` against a real
 * compositor, because a rule can be present and still not apply (genie#114).
 *
 * The guard's own non-vacuity comes from {@link declarationsFor}, whose
 * fixture-driven tests live beside the lists-dock guard that shares it.
 */

const css = readFileSync(join(__dirname, '../../styles/master.css'), 'utf8');

describe('the flyout shimmer', () => {
    it('does not run on is-open alone', () => {
        // The regression, stated as the thing it is: open is the slide-in.
        const open = declarationsFor(css, '.genie-os-layer.is-open .genie-os-flyout') ?? '';
        expect(open).not.toContain('animation');
    });

    it('still slides in on is-open — the transform must not have gone with it', () => {
        // POSITIVE CONTROL. Without this, "no animation on is-open" would also
        // pass for a rule someone deleted outright, and the panel would never
        // appear at all.
        const open = declarationsFor(css, '.genie-os-layer.is-open .genie-os-flyout') ?? '';
        expect(open).toContain('transform: translateX(0)');
        expect(open).toContain('opacity: 1');
    });

    it('runs the chase only when the layer is ALSO active', () => {
        const active =
            declarationsFor(css, '.genie-os-layer.is-open.is-active .genie-os-flyout') ?? '';
        expect(active).toContain('genie-os-chase');
    });
});

describe('the header icon', () => {
    it('pulses on is-active, and nothing else does', () => {
        expect(declarationsFor(css, '.genie-os-button.is-active')).toContain('genie-os-pulse');
        // `is-open` on the button is a state, not an animation — it must not
        // have quietly acquired one, or the icon is back to meaning "open".
        const open = declarationsFor(css, '.genie-os-button.is-open') ?? '';
        expect(open).not.toContain('animation');
    });
});

describe('reduced motion still wins', () => {
    it('keeps the blanket animation:none for both surfaces', () => {
        // Splitting one rule into two is exactly the kind of change that leaves
        // a new selector outside an accessibility override.
        const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
        expect(reduced).toContain('.genie-os-flyout');
        expect(reduced).toContain('.genie-os-button');
        expect(reduced).toContain('animation: none !important');
    });
});

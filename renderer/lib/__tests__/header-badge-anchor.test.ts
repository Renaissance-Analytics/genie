import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A HEADER BADGE LANDS ON ITS OWN BUTTON.
 *
 * `.iw-btn-badge` is `position: absolute; top: -2px; right: -2px`, so it anchors
 * to the nearest POSITIONED ancestor. `.gicon` — the class every header icon
 * button wears — did not establish one, so the badge resolved against something
 * far up the title bar and painted where nobody could see it.
 *
 * Two buttons were unaffected and that is exactly what hid the bug for so long:
 * `.iw-btn` and `.agentinbox-btn` each declare `position: relative` themselves.
 * So IssueWatch and AgentInbox showed their counts while Questions and Lists —
 * whose buttons declare no rule — silently showed nothing, with correct numbers
 * in state the whole time and every unit test green. The owner: *"the count
 * indicators for pending questions and users list still does not work at all. I
 * never see any indication that I have items waiting for me."*
 *
 * Per-button `position: relative` is the bandaid; the contract is "a `.gicon` can
 * carry an `.iw-btn-badge`", so `.gicon` is where the containing block belongs.
 * This asserts the contract rather than the two historical exceptions — adding a
 * third badge to a fourth header button must not need anyone to remember this.
 */
const CSS = fs.readFileSync(
    path.resolve(__dirname, '../../styles/master.css'),
    'utf8',
);
const MASTER = fs.readFileSync(path.resolve(__dirname, '../../pages/master.tsx'), 'utf8');

/** The declarations of a rule whose selector is exactly `sel`. */
function rule(sel: string): string {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return CSS.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('header icon badges', () => {
    it('anchors to the button, because .gicon establishes a containing block', () => {
        // THE fix. Without it `top: -2px; right: -2px` is measured against
        // whatever happens to be positioned further up the tree.
        expect(rule('.gicon')).toMatch(/position:\s*relative/);
    });

    it('still positions the badge absolutely — the anchor is the only half that moved', () => {
        // POSITIVE CONTROL. If the badge stopped being absolute this would all
        // pass while the badge sat inline, pushing the icon sideways.
        expect(rule('.iw-btn-badge')).toMatch(/position:\s*absolute/);
    });

    it('gives every badge-carrying header button the .gicon class', () => {
        // The anchor lives on `.gicon`, so a button that carries a badge without
        // it is back in the broken state. Checked against the source because the
        // markup is the only place the pairing exists.
        const withBadge = MASTER.split('<button')
            .slice(1)
            .map((seg) => seg.slice(0, seg.indexOf('</button>')))
            .filter((seg) => seg.includes('iw-btn-badge'));
        // THREE today: AgentInbox, Lists, IssueWatch. It was four until P7 removed the
        // Questions icon — the Deck owns that queue now, and the Deck is meant to be the
        // ONLY place badges exist. So this number going DOWN is the design working; if a
        // badge ever reappears elsewhere, that is the failure to look for.
        //
        // The floor still guards against a selector that quietly matches nothing and passes
        // vacuously, which is why it is a floor rather than an exact count.
        expect(withBadge.length).toBeGreaterThanOrEqual(3);
        for (const block of withBadge) {
            expect(block).toMatch(/className=[^\n]*gicon/);
        }
    });

    it('does not dress the Lists header icon as a flyout action button', () => {
        // `.lists-btn` is the Lists FLYOUT's Done/Refuse action-button class —
        // `border: 1px solid`, `background: var(--bg-2)`, `padding: 4px 9px`. The
        // header icon wore it by name collision, which painted a stray bordered
        // pill around one icon in a row of flat ones.
        expect(MASTER).not.toMatch(/className="gicon lists-btn"/);
        // And the flyout's own class keeps its look — this is a rename at the
        // header, not a restyle of the panel.
        expect(rule('.lists-btn')).toMatch(/border:/);
    });
});

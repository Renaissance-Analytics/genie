import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE HEADER CARRIES NO BADGES — and that is this file's whole contract now.
 *
 * ## What it used to be about
 *
 * `.iw-btn-badge` is `position: absolute; top: -2px; right: -2px`, so it anchored to the nearest
 * POSITIONED ancestor. `.gicon` — the class every header icon button wore — established none, so
 * a badge resolved against something far up the title bar and painted where nobody could see it.
 * Two buttons were unaffected because they declared `position: relative` themselves, which is
 * exactly what hid it: IssueWatch and AgentInbox showed their counts while Questions and Lists
 * silently showed nothing, with correct numbers in state and every test green. The owner: *"the
 * count indicators for pending questions and users list still does not work at all."*
 *
 * The fix put the containing block on `.gicon`, and this file asserted the contract "a `.gicon`
 * can carry an `.iw-btn-badge`" rather than the two historical exceptions.
 *
 * ## Why it is now the opposite assertion
 *
 * That file also recorded the design this was heading for: *"the Deck owns that queue now, and the
 * Deck is meant to be the ONLY place badges exist. So this number going DOWN is the design
 * working; if a badge ever reappears elsewhere, that is the failure to look for."*
 *
 * P7 finished it. The icon cluster is gone and the live signals moved to the Deck
 * (`lib/station-signals.ts`, owner: *"move the signals to the Deck, then delete the icons"*), so
 * the count is zero and the anchoring bug has no surface left to occur on. Rewritten rather than
 * deleted, because the regression it guards against is real and now stateable directly: a badge
 * reappearing in the title bar.
 */
const CSS = fs.readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');
const MASTER = fs.readFileSync(path.resolve(__dirname, '../../pages/master.tsx'), 'utf8');

/** The declarations of a rule whose selector is exactly `sel`. */
function rule(sel: string): string {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return CSS.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

/** Every `<button>` in the master page, as its own source block. */
function buttons(): string[] {
    return MASTER.split('<button')
        .slice(1)
        .map((seg) => seg.slice(0, seg.indexOf('</button>')));
}

describe('the title bar carries no badges', () => {
    it('POSITIVE CONTROL: the scan finds the buttons that ARE there', () => {
        // Every assertion below is of the form "nothing matches", which passes beautifully
        // against a scan that found nothing. The menu button and the window controls remain.
        const found = buttons();
        expect(found.length).toBeGreaterThan(3);
        expect(found.some((b) => b.includes('Genie menu'))).toBe(true);
    });

    it('has no button carrying a count badge', () => {
        // The design, completed: the Deck is the only place a number waits for you. A badge here
        // would mean two places to look, and the one people stop looking at is the one that
        // matters on the day it changes.
        expect(buttons().filter((b) => b.includes('iw-btn-badge'))).toEqual([]);
    });

    it('has no badge-carrying header CLASSES left in the sheet either', () => {
        // Dead CSS for a badge nobody renders is an invitation to render one again.
        expect(rule('.iw-btn-badge')).toBe('');
        expect(rule('.iw-btn')).toBe('');
    });

    it('KEEPS the containing block on .gicon, which costs nothing and is still correct', () => {
        // `.gicon` survives on the menu button and the window controls. Keeping `position:
        // relative` means the next thing anyone absolutely-positions inside one lands on the
        // button — the fix this file was written for, left in place rather than reverted along
        // with its reason.
        expect(rule('.gicon')).toMatch(/position:\s*relative/);
    });

    it('does not dress a header icon as a flyout action button', () => {
        // `.lists-btn` is the Lists FLYOUT's Done/Refuse action-button class — `border: 1px
        // solid`, `background: var(--bg-2)`, `padding: 4px 9px`. A header icon wore it by name
        // collision, which painted a stray bordered pill around one icon in a row of flat ones.
        expect(MASTER).not.toMatch(/className="gicon lists-btn"/);
        // And the flyout's own class keeps its look — this was a rename at the header, not a
        // restyle of the panel.
        expect(rule('.lists-btn')).toMatch(/border:/);
    });
});

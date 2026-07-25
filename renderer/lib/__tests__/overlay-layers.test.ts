import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * genie #66 part 1 — Fancy's PORTALED overlays must paint above Genie's chrome.
 *
 * Fancy renders Modal and Popover content through a Portal into `document.body`
 * at Tailwind's `z-50`. Genie's own overlay chrome sits far higher — the flyout
 * root alone is `z-index: 60` — and both are siblings in the body stacking
 * context. So a Fancy Modal opened FROM a Genie flyout painted *underneath* the
 * entire flyout, which is what the owner saw: the AgentInbox delete confirmation
 * sitting behind the DM/channel list. The roster Popover had the identical bug.
 *
 * The fix is a documented layer in Genie's ladder, not a per-component nudge, so
 * this test guards the INVARIANT rather than a magic number: whatever the flyout
 * is renumbered to, the Fancy portal layer must stay above it (and below toasts,
 * which are notifications and should survive over a modal).
 */

const CSS = fs.readFileSync(
    path.resolve(__dirname, '../../styles/master.css'),
    'utf8',
);

/** The `z-index` declared in the first rule block for `selector`. */
function zIndexOf(css: string, selector: string): number | null {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) return null;
    const block = css.slice(at, css.indexOf('}', at));
    const m = /z-index:\s*([0-9]+)\s*;/.exec(block);
    return m ? Number(m[1]) : null;
}

/** The value of a `--custom-property: N;` declaration anywhere in the sheet. */
function tokenValue(css: string, name: string): number | null {
    const m = new RegExp(`${name}:\\s*([0-9]+)\\s*;`).exec(css);
    return m ? Number(m[1]) : null;
}

describe('Fancy portal overlay layer (genie #66)', () => {
    it('declares a --z-fancy-overlay token', () => {
        expect(tokenValue(CSS, '--z-fancy-overlay')).toBeTypeOf('number');
    });

    it('sits ABOVE the flyout root — the bug was the flyout painting over the modal', () => {
        const overlay = tokenValue(CSS, '--z-fancy-overlay');
        const flyout = zIndexOf(CSS, '.docs-flyout-root');
        expect(flyout).toBeTypeOf('number');
        expect(overlay).toBeGreaterThan(flyout!);
    });

    it('sits above every other Genie chrome layer that can host a Fancy dialog', () => {
        const overlay = tokenValue(CSS, '--z-fancy-overlay')!;
        // The scrims/menus a modal can be opened from or over.
        for (const sel of ['.ctx-scrim', '.prompt-scrim', '.proc-ctx-menu']) {
            const z = zIndexOf(CSS, sel);
            expect(z, `${sel} should declare a z-index`).toBeTypeOf('number');
            expect(overlay, `--z-fancy-overlay must beat ${sel}`).toBeGreaterThan(z!);
        }
    });

    it('stays BELOW toasts, which must remain visible over a modal', () => {
        const overlay = tokenValue(CSS, '--z-fancy-overlay')!;
        const toast = zIndexOf(CSS, '.g-toast');
        expect(toast).toBeTypeOf('number');
        expect(overlay).toBeLessThan(toast!);
    });

    it('applies the layer to BOTH portaled surfaces — modal overlay and popover content', () => {
        // The modal's positioned element is the portal child WRAPPING the panel;
        // the popover's positioned element carries its own data attribute.
        expect(CSS).toContain('[data-react-fancy-portal] > div:has([data-react-fancy-modal])');
        expect(CSS).toContain('[data-react-fancy-portal] > [data-react-fancy-popover]');
        // Both must reference the token, not a hardcoded number.
        const rules = CSS.split('\n').filter((l) => l.includes('var(--z-fancy-overlay)'));
        expect(rules.length).toBeGreaterThanOrEqual(1);
    });
});

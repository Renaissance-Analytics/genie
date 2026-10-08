import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE Z-INDEX LADDER, asserted instead of described.
 *
 * ## What it was
 *
 * A comment at the top of `master.css` listing eight rungs — *"flyout 60 · ctx-scrim 80 ·
 * prompt-scrim 100 · proc menus 119/120 · [fancy overlays 900] · [picker 950] · toasts 1000 ·
 * boot screen 9999"* — two of which were tokens and the rest raw numbers scattered through the
 * sheet. Prose cannot be wrong in a way anything notices, so it was: `.system-menu` and
 * `.agent-panel-menu` sit at **1200, above the toast rung the same comment says must stay on
 * top**, and two more surfaces quietly share 1000 with toasts.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * The ladder is now tokens, each holding the value its selector already had — so naming it
 * changed no behaviour. This test pins the ORDER, which is the part a future nudge breaks, and
 * refuses a raw numeric rung at 60 or above anywhere in the sheet: that is how every one of
 * those ad-hoc numbers got there in the first place.
 *
 * It does NOT assert that 1200-above-1000 is correct. It is not — the comment says the opposite
 * — but changing a live stacking order is a visual change no test here can verify, and it is not
 * mine to make silently. The contradiction is named in the sheet and pinned here so it is a
 * decision someone takes rather than a surprise someone finds.
 *
 * Values below 60 are out of scope on purpose: a sparkline behind a button face or a sticky
 * header over its own rows answers to its own stacking context, not to the global ladder.
 */

const ROOT = path.resolve(__dirname, '../../..');
const CSS = fs
    .readFileSync(path.join(ROOT, 'renderer/styles/master.css'), 'utf8')
    .split('\r\n')
    .join('\n');

/** The ladder, in the order things must paint. Ties are explicit. */
const LADDER = [
    '--z-chrome-flyout',
    '--z-ctx-scrim',
    '--z-prompt-scrim',
    '--z-proc-menu',
    '--z-genie-os',
    '--z-fancy-overlay',
    '--z-picker',
    '--z-toast',
    '--z-chrome-pop',
    '--z-chrome-menu',
    '--z-whats-new',
    '--z-upgrade',
    '--z-boot',
] as const;

function rung(name: string): number | null {
    const m = CSS.match(new RegExp(`${name}:\\s*(\\d+)\\s*;`));
    return m ? Number(m[1]) : null;
}

describe('the z-index ladder', () => {
    it('defines every rung', () => {
        const missing = LADDER.filter((name) => rung(name) === null);
        expect(missing).toEqual([]);
    });

    it('never goes DOWN as it goes up', () => {
        // Non-decreasing rather than strictly increasing, because two rungs genuinely tie today
        // and inventing a number to separate them would be a change nobody asked for.
        const values = LADDER.map((name) => rung(name)!);
        const sorted = [...values].sort((a, b) => a - b);
        expect(values).toEqual(sorted);
    });

    it('keeps the two rungs genie#66 and genie#86 are ABOUT in their proven order', () => {
        // The bug: a Fancy dialog opened from Genie chrome painted underneath it. The picker is
        // then the rung above, because it is opened FROM those dialogs and rode chrome at 80.
        expect(rung('--z-ctx-scrim')!).toBeLessThan(rung('--z-fancy-overlay')!);
        expect(rung('--z-fancy-overlay')!).toBeLessThan(rung('--z-picker')!);
    });

    it('keeps the GENIE OS layer under the Fancy rung, which is deliberate', () => {
        // A dialog opened from inside that flyout portals to the body and must paint over it.
        // Reading this as a bug and "fixing" it would put the flyout over its own modals.
        expect(rung('--z-genie-os')!).toBeLessThan(rung('--z-fancy-overlay')!);
    });

    it('keeps the boot screen on top of everything', () => {
        expect(rung('--z-boot')!).toBe(Math.max(...LADDER.map((n) => rung(n)!)));
    });

    it('has NO raw numeric rung at 60 or above left in the sheet', () => {
        // The mechanism by which the ladder came apart: a number typed into a selector because
        // something was painting underneath something else. The token has to be the only way.
        const offenders: string[] = [];
        CSS.split('\n').forEach((line, i) => {
            for (const m of line.matchAll(/z-index:\s*(\d+)/g)) {
                if (Number(m[1]) >= 60) offenders.push(`line ${i + 1}: ${line.trim()}`);
            }
        });
        expect(offenders).toEqual([]);
    });

    it('POSITIVE CONTROL: the scan reads the real sheet', () => {
        // Without this, a renamed file or a regex that stopped matching makes every assertion
        // above pass against nothing.
        expect(CSS).toContain('--z-fancy-overlay');
        expect(rung('--z-boot')).toBe(9999);
        expect(CSS.length).toBeGreaterThan(10_000);
    });
});

/**
 * THE COMMAND PALETTE MUST BE LIFTED — found by CI, and a severe defect since P7.
 *
 * E2E `master-window.spec.ts:1437` failed on all three platforms with Playwright naming the
 * culprit outright: *"`<div class="docs-scrim">` from `<div id="root">…</div>` subtree intercepts
 * pointer events"*. The palette was open and visible, and its rows could not be clicked.
 *
 * ## Why
 *
 * Fancy's `Command` portals into a container styled with Tailwind's `z-50` (read from
 * `dist/chunk-YCV43A7D.js`: `className: "fixed inset-0 z-50 flex items-start justify-center"`).
 * Genie's own chrome flyouts sit at `--z-chrome-flyout: 60`. So **the palette paints UNDER any
 * open flyout's scrim** — and `.docs-flyout-root` is shared by eight of them (Lists, Docs, Flows,
 * Sharing, IssueWatch, AgentInbox, Tasks, GitHub caps).
 *
 * genie#66 already built the mechanism for exactly this: lift every Fancy portal surface onto one
 * rung. That rule matches `[data-react-fancy-modal]` and `[data-react-fancy-popover]` and was
 * simply never extended to `Command`, whose positioned portal child carries neither marker — it
 * only CONTAINS `[data-react-fancy-command]`.
 *
 * ## Why it only started mattering now
 *
 * Before P7 the palette was one way in among eight title-bar icons; now it IS the way in, and the
 * features it reaches are flyouts. So "⌘K does nothing while a flyout is open" went from an
 * annoyance to the palette being unusable precisely when it is needed.
 *
 * Asserted here rather than only in E2E because the ladder is this file's subject, and because a
 * source assertion runs on every push while E2E runs on the VM.
 */
describe('every Fancy portal surface rides the Fancy rung', () => {
    /** The one lift rule, as text — selectors and all. */
    const LIFT = CSS.slice(CSS.indexOf('[data-react-fancy-portal]'));
    const liftBlock = LIFT.slice(0, LIFT.indexOf('}') + 1);

    it('lifts the MODAL portal, which is the rule genie#66 built', () => {
        // The positive control: if this stops matching, the extraction below is reading the wrong
        // block and every assertion here is vacuous.
        expect(liftBlock).toContain('div:has([data-react-fancy-modal])');
        expect(liftBlock).toContain('var(--z-fancy-overlay)');
    });

    it('lifts the POPOVER portal', () => {
        expect(liftBlock).toContain('[data-react-fancy-popover]');
    });

    it('lifts the COMMAND portal, or ⌘K opens under every flyout scrim', () => {
        expect(liftBlock).toContain('div:has([data-react-fancy-command])');
    });

    it('lifts it ABOVE the chrome flyout rung, which is the number that broke it', () => {
        // Fancy's own `z-50` is below `--z-chrome-flyout: 60`. The lift is only a fix if the rung
        // it lifts to actually outranks the thing that was covering it.
        expect(rung('--z-fancy-overlay')!).toBeGreaterThan(rung('--z-chrome-flyout')!);
    });
});

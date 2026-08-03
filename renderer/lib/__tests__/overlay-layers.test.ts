import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { OVERLAY_ROOT_CLASS } from '../overlay-root';

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
const GLOBALS = fs.readFileSync(
    path.resolve(__dirname, '../../styles/globals.css'),
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

/**
 * Every top-level rule in a sheet, as `{ selector, body }`. Only rules whose
 * selector starts at column 0 are matched, which skips the indented innards of
 * `@media` / `@keyframes` / `@supports` — Genie's sheets nest nothing else.
 */
function rules(css: string): { selector: string; body: string }[] {
    const out: { selector: string; body: string }[] = [];
    // Comments first: a `/* … */` block at column 0 otherwise reads as the
    // start of a selector and swallows the rule it documents.
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /^([^@\s}][^{}]*)\{([^{}]*)\}/gm;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        out.push({ selector: m[1].trim(), body: m[2] });
    }
    return out;
}

/** Custom properties DECLARED by every rule whose selector matches `pick`. */
function declaredBy(css: string, pick: (selector: string) => boolean): Set<string> {
    const names = new Set<string>();
    for (const r of rules(css)) {
        if (!pick(r.selector)) continue;
        for (const m of r.body.matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(m[1]);
    }
    return names;
}

/**
 * Custom properties CONSUMED without a fallback by every rule whose selector
 * matches `pick`. `var(--x, 12px)` is excluded on purpose: a fallback is a
 * self-contained declaration that cannot go blank when the token is out of
 * scope, so it is not a scope dependency.
 */
function consumedBy(css: string, pick: (selector: string) => boolean): Set<string> {
    const names = new Set<string>();
    for (const r of rules(css)) {
        if (!pick(r.selector)) continue;
        for (const m of r.body.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) names.add(m[1]);
    }
    return names;
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

/**
 * genie #86 — the MIRROR of #66: a picker opened FROM a Fancy modal.
 *
 * #66 lifted every Fancy portal surface above Genie's chrome, and `.ctx-scrim`
 * (z-index 80) is chrome. But the in-app file picker rides that same scrim, and
 * it is opened FROM Fancy modals — Add workspace → Local folder → Browse. So the
 * picker painted UNDER the very modal that launched it: dimmed by the modal's
 * own backdrop and, because the backdrop sits on top, not clickable at all.
 *
 * A picker is a LEAF dialog — nothing opens from it — so it belongs on its own
 * documented rung above every dialog layer and below notifications, rather than
 * on the shared chrome scrim. These tests guard that ordering, and guard that
 * fixing it did not simply undo #66 by shoving `.ctx-scrim` back on top.
 */
describe('File-picker layer (genie #86)', () => {
    it('declares a --z-picker token', () => {
        expect(tokenValue(CSS, '--z-picker')).toBeTypeOf('number');
    });

    it('sits ABOVE the Fancy overlay — the bug was the launching modal painting over the picker', () => {
        const picker = tokenValue(CSS, '--z-picker');
        const fancy = tokenValue(CSS, '--z-fancy-overlay');
        expect(picker).toBeTypeOf('number');
        expect(picker).toBeGreaterThan(fancy!);
    });

    it('stays BELOW toasts, so a notification still survives over the picker', () => {
        const picker = tokenValue(CSS, '--z-picker')!;
        const toast = zIndexOf(CSS, '.g-toast');
        expect(toast).toBeTypeOf('number');
        expect(picker).toBeLessThan(toast!);
    });

    it('lifts the picker via its OWN scrim class, leaving .ctx-scrim on the chrome rung', () => {
        // The picker gets a second class rather than a raised `.ctx-scrim`: the
        // scrim is shared with the agent-settings modal, and raising it above
        // `--z-fancy-overlay` would regress genie #66 for every Fancy dialog.
        const at = CSS.indexOf('.file-picker-scrim {');
        expect(at, '.file-picker-scrim should exist').toBeGreaterThan(-1);
        expect(CSS.slice(at, CSS.indexOf('}', at))).toContain('var(--z-picker)');
        // …and it must come AFTER `.ctx-scrim`, or equal specificity lets the
        // chrome rung win on source order.
        expect(CSS.indexOf('.file-picker-scrim {')).toBeGreaterThan(CSS.indexOf('.ctx-scrim {'));
        // #66's invariant still holds for the shared scrim.
        expect(tokenValue(CSS, '--z-fancy-overlay')!).toBeGreaterThan(zIndexOf(CSS, '.ctx-scrim')!);
    });
});

/**
 * genie #114 — the OTHER half of "renders behind the modal", and the half #86
 * never touched: what the picker paints, not where it sits.
 *
 * `.file-picker-modal` draws its surface with `background: var(--shell)` and
 * `box-shadow: var(--shadow-xl)`. Both tokens are declared on `.gwrap` — the
 * MASTER PAGE's wrapper — while the picker is mounted by `_app.tsx` as a
 * sibling of the page, outside that wrapper entirely. Out of scope, `var()`
 * resolves to nothing, the declarations go invalid-at-computed-value-time, and
 * the longhands fall back to their initial values: `transparent` and `none`.
 *
 * So the picker was a see-through rectangle over the Add-workspace modal. It
 * was on top (#86 saw to that) and clickable, and it still READ as being
 * behind, because the modal showed straight through it.
 *
 * The guard is the general one rather than "`--shell` must be global": every
 * custom property the picker's own rules consume has to be declared in a scope
 * the picker actually inherits from. That catches the next token someone
 * reaches for as well as this one — which is the bit that kept recurring.
 */
describe('Overlay token scope (genie #114)', () => {
    /** The rules FilePickerModal's markup actually lands on. */
    const isPickerRule = (sel: string) =>
        sel.includes('.file-picker') ||
        sel.includes('.ctx-scrim') ||
        sel.includes('.agent-form-btn');

    /**
     * Scopes the picker inherits from, once it is portaled into the overlay
     * host: `<html class="dark">` → `<body>` → the host. So `:root` / `.dark`
     * in globals.css, plus whatever the host's own class declares.
     */
    const inScope = new Set([
        ...declaredBy(GLOBALS, (sel) => sel === ':root' || sel === '.dark'),
        ...declaredBy(CSS, (sel) => sel === ':root'),
        ...declaredBy(CSS, (sel) =>
            sel.split(',').some((s) => s.trim() === `.${OVERLAY_ROOT_CLASS}`),
        ),
    ]);

    it('declares every token the picker paints itself with in a scope it inherits', () => {
        const missing = [...consumedBy(CSS, isPickerRule)].filter((t) => !inScope.has(t));
        expect(
            missing,
            `the picker consumes ${missing.join(', ')} but nothing in its ancestor chain ` +
                `declares them — those properties compute to their initial value ` +
                `(background: transparent, box-shadow: none), which is what made the ` +
                `panel see-through over the modal that launched it`,
        ).toEqual([]);
    });

    it('gives the overlay host the SAME surface tokens as the in-page chrome', () => {
        // Sharing one declaration is the point: a token added for `.gwrap`
        // later must reach portaled overlays too, or this bug returns for
        // whichever surface reaches for it first.
        const gwrap = declaredBy(CSS, (sel) =>
            sel.split(',').some((s) => s.trim() === '.gwrap'),
        );
        const host = declaredBy(CSS, (sel) =>
            sel.split(',').some((s) => s.trim() === `.${OVERLAY_ROOT_CLASS}`),
        );
        expect(gwrap.size, '.gwrap should declare Genie surface tokens').toBeGreaterThan(0);
        expect([...gwrap].filter((t) => !host.has(t))).toEqual([]);
    });

    it('adds a layer, not a box — the host must not disturb page flow', () => {
        const host = rules(CSS).find(
            (r) => r.selector.split(',').some((s) => s.trim() === `.${OVERLAY_ROOT_CLASS}`)
                && /display\s*:/.test(r.body),
        );
        expect(host, `.${OVERLAY_ROOT_CLASS} should set a display`).toBeTruthy();
        expect(host!.body).toContain('display: contents');
    });
});

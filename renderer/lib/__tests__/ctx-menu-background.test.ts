import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Context menus render TRANSPARENT — content behind them shows through and the
 * menu is unreadable. Reported repeatedly across multiple menus (#312).
 *
 * Root cause: every context menu (AgentContextMenu, ProjectContextMenu,
 * SpecContextMenu, FileTreeContextMenu) renders `className="proj-popover
 * ctx-menu [...]"`. Of those classes, only `.proj-popover` sets a `background`
 * (`var(--shell)`) — it is a DROPDOWN class. `.ctx-menu` exists solely to undo
 * `.proj-popover`'s absolute-positioning anchor (see its own comment) and sets
 * no background of its own; neither does any per-menu class layered on top
 * (e.g. `.agent-ctx-menu`). So a context menu's opacity is borrowed entirely
 * from a class it is fighting for positioning — any context where
 * `var(--shell)` fails to resolve, or gets overridden/unset upstream, yields a
 * fully transparent menu with no fallback.
 *
 * The fix is for `.ctx-menu` itself to declare an opaque background (with a
 * literal fallback so an unresolved token can never produce transparency), a
 * border, radius and shadow — so a context menu is readable on its own class
 * stack, independent of `.proj-popover`, and the fix covers all four menus at
 * once since they all carry `.ctx-menu`.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');

/** The body of the first rule whose selector list contains exactly `selector`. */
function ruleBody(selector: string): string {
    const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /^([^@\s}][^{}]*)\{([^{}]*)\}/gm;
    for (let m = re.exec(src); m; m = re.exec(src)) {
        const selectors = m[1]!.split(',').map((s) => s.trim());
        if (selectors.includes(selector)) return m[2]!;
    }
    throw new Error(`no rule for ${selector}`);
}

describe('.ctx-menu has its own opaque background', () => {
    it('declares a background declaration at all', () => {
        const body = ruleBody('.ctx-menu');
        expect(body).toMatch(/(?:^|;)\s*background:/);
    });

    it('falls back to a literal colour if --shell is unresolved', () => {
        const body = ruleBody('.ctx-menu');
        // Must reference --shell WITH a literal fallback value, e.g.
        // `var(--shell, #0e0e12)` -- a bare `var(--shell)` with no fallback can
        // still resolve to nothing (transparent) if the token is missing or
        // overridden upstream.
        expect(body).toMatch(/background:\s*var\(--shell,\s*#[0-9a-fA-F]{3,8}\s*\)/);
    });

    it('is not transparent', () => {
        const body = ruleBody('.ctx-menu');
        expect(body).not.toMatch(/background:\s*transparent/);
    });

    it('also declares a border, radius and shadow, matching a real menu surface', () => {
        // POSITIVE CONTROL -- pins that this is a genuine standalone menu
        // surface, not just a background bolted on to the positioning rule.
        const body = ruleBody('.ctx-menu');
        expect(body).toMatch(/(?:^|;)\s*border:/);
        expect(body).toMatch(/(?:^|;)\s*border-radius:/);
        expect(body).toMatch(/(?:^|;)\s*box-shadow:/);
    });

    it('still overrides the positioning inherited from .proj-popover', () => {
        // POSITIVE CONTROL -- the fix must not remove the reason `.ctx-menu`
        // exists in the first place (undoing the dropdown anchor).
        const body = ruleBody('.ctx-menu');
        expect(body).toMatch(/position:\s*fixed/);
    });
});

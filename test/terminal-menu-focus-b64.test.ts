import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { refocusingMenu } from '../src/core/terminal-menu.js';

/**
 * PASTE FROM THE TERMINAL'S MENU GIVES THE KEYBOARD BACK (beta.64, the owner). fancy-term draws the terminal's own
 * right-click menu; picking an item focuses the menu's button and then the menu closes, so focus was left on nothing and
 * the next keystrokes went nowhere until the terminal was clicked again. Genie hands fancy-term a menu that is its own
 * default items, each one returning focus to the terminal once it has run.
 */
type Ctx = { hasSelection: boolean; selection: string; readOnly: boolean };
const ctx: Ctx = { hasSelection: true, selection: 'ls', readOnly: false };

function defaults(log: string[]) {
    return [
        { id: 'copy', label: 'Copy', disabled: false, onSelect: (_c: Ctx) => { log.push('copy'); } },
        { id: 'paste', label: 'Paste', onSelect: (_c: Ctx) => { log.push('paste'); } },
        { id: 'select-all', label: 'Select all', onSelect: (_c: Ctx) => { log.push('select-all'); } },
        { id: 'note', label: 'Read-only' },
    ];
}

describe('refocusingMenu', () => {
    it('Paste pastes, then the terminal has the keyboard again', () => {
        const log: string[] = [];
        const items = refocusingMenu(() => { log.push('focus'); })(ctx, defaults(log));
        items.find((i) => i.id === 'paste')!.onSelect!(ctx);
        expect(log).toEqual(['paste', 'focus']);
    });

    it('every action does the same: Copy and Select all too', () => {
        const log: string[] = [];
        const items = refocusingMenu(() => { log.push('focus'); })(ctx, defaults(log));
        items.find((i) => i.id === 'copy')!.onSelect!(ctx);
        items.find((i) => i.id === 'select-all')!.onSelect!(ctx);
        expect(log).toEqual(['copy', 'focus', 'select-all', 'focus']);
    });

    it('control: the menu is fancy-term’s own, item for item; an item with no action stays without one', () => {
        const log: string[] = [];
        const items = refocusingMenu(() => {})(ctx, defaults(log));
        expect(items.map((i) => [i.id, i.label])).toEqual([['copy', 'Copy'], ['paste', 'Paste'], ['select-all', 'Select all'], ['note', 'Read-only']]);
        expect(items[3]!.onSelect).toBeUndefined();
    });

    it('the terminal pane hands fancy-term that menu, focusing its own terminal', () => {
        const src = readFileSync('src/renderer/components/TerminalPane.tsx', 'utf8');
        // xterm's textarea, focused without scrolling the window (genie#1290's rule for every .focus( in the renderer).
        expect(src).toContain('refocusingMenu(() => term.current?.xterm?.textarea?.focus({ preventScroll: true }))');
        expect(src).toMatch(/const (\w+) = useMemo\(\(\) => refocusingMenu\([\s\S]*contextMenu=\{\1\}/);
    });
});

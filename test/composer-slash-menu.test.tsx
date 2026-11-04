// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PromptInput } from '@particle-academy/react-fancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPromptCmds, type ProviderCommand } from '../src/core/provider-commands.js';

/**
 * THE COMPOSER'S `/` MENU (the owner, 2026-11-04, Tynn task #941, with a screenshot of "COMMANDS · 120"):
 *
 * 1. Moving through it with the arrow keys must bring the highlighted entry into view. The list is a short scroll box
 *    (react-fancy `PromptInput`, `max-h-56`); with 120 commands the highlight walked off the bottom and stayed there.
 * 2. "it should not have a horizontal scroll so whatever is causing that, stop it." The cause: the menu is a fixed
 *    `w-72` (288px) and its rows set no wrapping, so an unbroken name such as `/claude-code-setup:claude-automation-
 *    recommender` (48 monospace characters at 12px, about 345px) is wider than the menu. The list scrolls on y, so CSS
 *    computes its x overflow to `auto` too, and the over-wide row becomes a horizontal scrollbar. The cure is rows that
 *    wrap or truncate long tokens inside the menu's width, not hiding the scrollbar over them.
 *
 * Both live in react-fancy's `PromptInput`, which Genie does not patch; react-fancy 6.7.2 fixes them, and these rows
 * are Genie's acceptance for it (red on 6.3.0, CI run 41915954216). A rendered claim, so happy-dom (docs/decisions.md D3, as
 * test/rail-keyboard.test.tsx). Rendered in textarea mode: Genie's composer uses the inline paste editor, but the menu
 * is the same markup after either editor, and the textarea is the one a DOM without layout can type into.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
let scrolled: Element[];
let original: typeof HTMLElement.prototype.scrollIntoView;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    scrolled = [];
    original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    HTMLElement.prototype.scrollIntoView = original;
});

/** Thirty commands as Claude reports them: short ones, plugin-qualified long ones, and descriptions with long tokens. */
const COMMANDS: ProviderCommand[] = [
    { name: 'dreaming', description: 'Run a dreaming session that produces speculative UI components on a `dreaming` branch. (user)', source: 'skill' },
    { name: 'claude-code-setup:claude-automation-recommender', description: 'Analyze a codebase and recommend Claude Code automations (plugin)', source: 'skill' },
    { name: 'plugin-dev:hook-development', description: 'Uses ${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json/PreToolUse/PostToolUse/SubagentStop/SessionStart (plugin)', source: 'skill' },
    ...Array.from({ length: 27 }, (_, i) => ({ name: `command-${String(i).padStart(2, '0')}`, description: `Command number ${i}`, source: 'command' as const })),
];
const LONG = '/claude-code-setup:claude-automation-recommender';

const textarea = () => host.querySelector<HTMLTextAreaElement>('[data-react-fancy-prompt-input-textarea]')!;
const menuItems = () => [...host.querySelectorAll<HTMLLIElement>('li')];
const key = (k: string) => act(() => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const type = (value: string) => act(() => {
    const ta = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value);
    ta.setSelectionRange(value.length, value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
});
const openMenu = () => {
    act(() => root.render(<PromptInput budgetTokens={0} meter="hidden" commands={toPromptCmds(COMMANDS)} onSubmit={() => {}} />));
    type('/');
    expect(menuItems()).toHaveLength(COMMANDS.length);
};

describe('the arrow keys bring the highlighted command into view', () => {
    it('ArrowDown to the eighth entry scrolls THAT entry into view (control: Enter then picks the eighth)', () => {
        openMenu();
        for (let i = 0; i < 7; i++) key('ArrowDown');
        const target = menuItems()[7];
        const last = scrolled.at(-1);
        // The control first: the highlight really is on the eighth entry, so a missing scroll is not a missing move.
        key('Enter');
        expect(textarea().value).toBe(`/${COMMANDS[7]!.name} `);
        expect(last).toBe(target);
    });

    it('ArrowUp back to the third scrolls the third into view', () => {
        openMenu();
        for (let i = 0; i < 9; i++) key('ArrowDown');
        for (let i = 0; i < 7; i++) key('ArrowUp');
        const target = menuItems()[2];
        const last = scrolled.at(-1);
        key('Enter');
        expect(textarea().value).toBe(`/${COMMANDS[2]!.name} `);
        expect(last).toBe(target);
    });
});

/** Classes and styles that keep an unbroken token inside its box: wrap it anywhere, or truncate it. */
const CONTAINS_LONG_TOKENS = /(^|\s)(truncate|text-ellipsis|break-all|break-words|wrap-break-word|wrap-anywhere|\[overflow-wrap:(anywhere|break-word)\]|\[word-break:(break-all|break-word)\])(\s|$)/;
function keepsTokensInside(el: Element, stop: Element): boolean {
    for (let at: Element | null = el; at && at !== stop.parentElement; at = at.parentElement) {
        if (CONTAINS_LONG_TOKENS.test(at.getAttribute('class') ?? '')) return true;
        const style = (at as HTMLElement).style;
        if (style && (/anywhere|break-word/.test(style.overflowWrap) || /break-all|break-word/.test(style.wordBreak) || style.textOverflow === 'ellipsis')) return true;
    }
    return false;
}

describe('no horizontal scroll: long names and descriptions stay inside the menu', () => {
    it('the guard can fail: a bare monospace row does not keep its tokens inside (positive control)', () => {
        const li = document.createElement('li');
        li.innerHTML = '<div class="font-mono font-medium">/x</div>';
        expect(keepsTokensInside(li.firstElementChild!, li)).toBe(false);
        li.innerHTML = '<div class="font-mono truncate">/x</div>';
        expect(keepsTokensInside(li.firstElementChild!, li)).toBe(true);
    });

    it('every text in every row wraps or truncates its long tokens', () => {
        openMenu();
        // The fixture really is wider than the menu: 48 monospace characters at 12px ~ 345px against `w-72`'s 288px.
        expect(LONG.length * 7.2).toBeGreaterThan(288);
        const long = menuItems().find((li) => li.textContent?.includes(LONG));
        expect(long).toBeDefined();
        const offenders: string[] = [];
        for (const li of menuItems()) {
            const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (!n.textContent?.trim()) continue;
                if (!keepsTokensInside(n.parentElement!, li)) offenders.push(n.textContent.trim().slice(0, 50));
            }
        }
        expect(offenders).toEqual([]);
    });
});

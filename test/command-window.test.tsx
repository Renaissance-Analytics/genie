import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COMMAND_PREFIXES, filterCommandItems, groupCommandItems, parseCommandQuery, type CommandItem } from '../src/core/command-window.js';
import { globalAction } from '../src/core/keys.js';
import { CommandWindow } from '../src/renderer/components/CommandWindow.js';

/**
 * CTRL/CMD+K — THE COMMAND WINDOW (Tynn #757; Genie 1 story #247, its renderer/lib/command-window.ts and
 * GenieCommandWindow.tsx at v0.7.0-beta.342). The owner, 2026-10-17: the title bar's "Search, jump, run · Ctrl K" box
 * opened nothing. Genie 1's rules, ported: type-ahead prefixes that count only when complete (`p>` not `p` — someone
 * typing "php" must not be swallowed), an unknown prefix kept as text, order preserved (a list that re-sorts moves the
 * row under Enter), groups with prompts first. In Genie 2 an agent is a session, not a terminal: the categories are
 * prompts, actions, workspaces and agents (`@>`).
 */
const items: CommandItem[] = [
    { id: 'p1', category: 'prompt', label: 'Review the diff' },
    { id: 'go-hosting', category: 'action', label: 'Open Hosting' },
    { id: 'tynn', category: 'workspace', label: 'tynn', hint: '/w/tynn' },
    { id: 'fancy', category: 'workspace', label: 'fancy' },
    { id: 'a1', category: 'agent', label: 'moic', hint: 'moic.agi' },
];

describe('the query', () => {
    it('a COMPLETE prefix selects a category; a bare letter is text; an unknown prefix is text', () => {
        expect(parseCommandQuery('w> tynn')).toEqual({ category: 'workspace', text: 'tynn' });
        expect(parseCommandQuery('@> mo')).toEqual({ category: 'agent', text: 'mo' });
        expect(parseCommandQuery('p')).toEqual({ category: null, text: 'p' });
        expect(parseCommandQuery('z> x')).toEqual({ category: null, text: 'z> x' });
        expect(Object.keys(COMMAND_PREFIXES).sort()).toEqual(['@', 'a', 'p', 'w']);
    });

    it('filters by label, any case, in the order given; the hint is NOT matched', () => {
        expect(filterCommandItems(items, parseCommandQuery('T')).map((i) => i.id)).toEqual(['p1', 'go-hosting', 'tynn']);
        expect(filterCommandItems(items, parseCommandQuery('w>')).map((i) => i.id)).toEqual(['tynn', 'fancy']);
        expect(filterCommandItems(items, parseCommandQuery('agi')).map((i) => i.id)).toEqual([]);
    });

    it('groups: Prompts, Actions, Workspaces, Agents — empty groups dropped', () => {
        expect(groupCommandItems(items).map((g) => g.heading)).toEqual(['Prompts', 'Actions', 'Workspaces', 'Agents']);
        expect(groupCommandItems(items.filter((i) => i.category === 'agent')).map((g) => g.heading)).toEqual(['Agents']);
    });
});

describe('the key', () => {
    const press = (key: string, mod: { ctrl?: boolean; meta?: boolean }, typing = false) => ({ key, ctrlKey: mod.ctrl ?? false, metaKey: mod.meta ?? false, altKey: false, shiftKey: false, typing });
    it('Ctrl+K (Cmd+K) opens it, even while typing in a field; a bare K never does', () => {
        expect(globalAction(press('k', { ctrl: true }))).toBe('open-palette');
        expect(globalAction(press('K', { meta: true }, true))).toBe('open-palette');
        expect(globalAction(press('k', {}))).toBeNull();
    });
});

describe('the window', () => {
    // Fancy's Command mounts its body in the browser, so a server render shows the frame only; what is IN it — the input
    // with the prefixes, the groups, Enter navigating — is driven in a real window by scripts/smoke-cdp.mjs (step 55).
    it('open: its frame; closed: nothing', () => {
        expect(renderToStaticMarkup(<CommandWindow open items={items} onClose={() => {}} onActivate={() => {}} />)).toContain('data-command-window=""');
        expect(renderToStaticMarkup(<CommandWindow open={false} items={items} onClose={() => {}} onActivate={() => {}} />)).toBe('');
    });
});

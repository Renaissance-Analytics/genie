import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COMMAND_PREFIXES, filterCommandItems, firstMatch, groupCommandItems, parseCommandQuery, type CommandItem } from '../src/core/command-window.js';
import { globalAction } from '../src/core/keys.js';
import { DEFAULT_HOTKEYS, hotkeyAction } from '../src/core/hotkeys.js';
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
    // The key is the remappable binding (Tynn #759): Ctrl+K on Windows and Linux, ⌘K on macOS, by default.
    it('Ctrl+K (Cmd+K) opens it, even while typing in a field; a bare K never does', () => {
        expect(hotkeyAction(press('k', { ctrl: true }), DEFAULT_HOTKEYS, 'win32')).toBe('open-palette');
        expect(hotkeyAction(press('K', { meta: true }, true), DEFAULT_HOTKEYS, 'darwin')).toBe('open-palette');
        expect(hotkeyAction(press('k', {}), DEFAULT_HOTKEYS, 'win32')).toBeNull();
        expect(globalAction(press('k', { ctrl: true }))).toBeNull();
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

describe('the chord is caught before anything focused can swallow it', () => {
    // CI's real-window smoke (Linux, #908): with the chat composer focused after an approval, Ctrl+K never reached the
    // window's bubbling listener — a focused component stopped it. Genie 1's rule (hotkeys.ts): Genie's chords are caught
    // BEFORE the focused surface sees them. The global chords' listener is a CAPTURE listener.
    it('App registers the global chords (Ctrl+K, Ctrl+J, Ctrl+B) in the capture phase', async () => {
        const { readFileSync } = await import('node:fs');
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        const at = app.indexOf('const action = globalAction(');
        const effect = app.slice(at, app.indexOf('});', app.indexOf("removeEventListener('keydown'", at)) + 3);
        expect(effect).toContain("window.addEventListener('keydown', onKey, true)");
        expect(effect).toContain("window.removeEventListener('keydown', onKey, true)");
    });
});

describe('Enter in the search box', () => {
    // CI's real window: typing then Enter did nothing — Fancy's Command starts with no row active and handles no Enter;
    // only a FOCUSED item button takes it. In the box, Enter opens the first match, in the order the groups show.
    it('the first match, as shown (Prompts before Actions before Workspaces before Agents); none → null', () => {
        expect(firstMatch(items, 'w>')?.id).toBe('tynn');
        expect(firstMatch(items, '')?.id).toBe('p1');
        expect(firstMatch(items, 'mo')?.id).toBe('a1');
        expect(firstMatch(items, 'zzz')).toBeNull();
    });
});

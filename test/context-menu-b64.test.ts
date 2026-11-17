import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    contextMenuEntries,
    installContextMenu,
    menuTemplate,
    spellLanguages,
    type ContextParams,
    type MenuTemplateItem,
    type MenuWebContents,
} from '../src/main/context-menu.js';

/**
 * THE RIGHT-CLICK MENU AND THE SPELL CHECKER (beta.64, the owner): every text field and the chat composer show the
 * spelling squiggles, and a right-click offers Electron's suggestions, Add to dictionary, then Cut / Copy / Paste /
 * Select all. Text that cannot be edited (chat messages, the file viewer) gets Copy and Select all. Built from
 * Electron's own `context-menu` event on every webContents; the languages are the person's own, where the spell
 * checker has them.
 */
const flags = (over: Partial<ContextParams['editFlags']> = {}): ContextParams['editFlags'] => ({ canCut: true, canCopy: true, canPaste: true, canSelectAll: true, ...over });
const params = (over: Partial<ContextParams> = {}): ContextParams => ({ isEditable: true, misspelledWord: '', dictionarySuggestions: [], selectionText: '', editFlags: flags(), ...over });
const shape = (p: ContextParams) => contextMenuEntries(p).map((e) => (e.kind === 'role' ? `${e.role}${e.enabled ? '' : '(off)'}` : e.kind === 'suggestion' || e.kind === 'add-word' ? `${e.kind}:${e.word}` : e.kind));

describe('contextMenuEntries', () => {
    it('a misspelled word in a field: its suggestions (at most five), Add to dictionary, then the edit actions', () => {
        expect(shape(params({ misspelledWord: 'shoudl', dictionarySuggestions: ['should', 'shout', 'shoal', 'shod', 'shoals', 'shoulder'] }))).toEqual([
            'suggestion:should', 'suggestion:shout', 'suggestion:shoal', 'suggestion:shod', 'suggestion:shoals', 'add-word:shoudl', 'separator',
            'cut', 'copy', 'paste', 'separator', 'selectAll',
        ]);
    });

    it('a misspelled word with no suggestions says so, and can still be added', () => {
        expect(shape(params({ misspelledWord: 'tynn' }))).toEqual(['no-suggestions', 'add-word:tynn', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
    });

    it('a field: Cut, Copy, Paste and Select all, each on only when Chromium says it can', () => {
        expect(shape(params({ editFlags: flags({ canCut: false, canCopy: false }) }))).toEqual(['cut(off)', 'copy(off)', 'paste', 'separator', 'selectAll']);
    });

    it('text that cannot be edited (a chat message, the file viewer): Copy, on with a selection, and Select all', () => {
        expect(shape(params({ isEditable: false, selectionText: 'hello' }))).toEqual(['copy', 'selectAll']);
        expect(shape(params({ isEditable: false, selectionText: '', editFlags: flags({ canCopy: false }) }))).toEqual(['copy(off)', 'selectAll']);
    });
});

function fakeContents() {
    const calls: string[] = [];
    let listener: ((e: unknown, p: ContextParams) => void) | null = null;
    let listeners = 0;
    const contents: MenuWebContents = {
        on: (_event, fn) => { listener = fn; listeners += 1; return contents; },
        replaceMisspelling: (w) => { calls.push(`replace:${w}`); },
        session: {
            availableSpellCheckerLanguages: ['en-US', 'en-GB', 'fr'],
            setSpellCheckerEnabled: (on) => { calls.push(`enabled:${on}`); },
            setSpellCheckerLanguages: (l) => { calls.push(`languages:${l.join(',')}`); },
            addWordToSpellCheckerDictionary: (w) => { calls.push(`add:${w}`); return true; },
        },
    };
    return { contents, calls, fire: (p: ContextParams) => listener?.({}, p), listeners: () => listeners };
}

describe('menuTemplate', () => {
    it('a suggestion replaces the word, Add to dictionary adds it, and the edit actions are Electron roles', () => {
        const f = fakeContents();
        const tpl = menuTemplate(contextMenuEntries(params({ misspelledWord: 'teh', dictionarySuggestions: ['the'] })), f.contents);
        expect(tpl.map((i) => i.label ?? i.role ?? i.type)).toEqual(['the', 'Add to dictionary', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
        tpl[0]!.click!();
        tpl[1]!.click!();
        expect(f.calls).toEqual(['replace:the', 'add:teh']);
        expect(tpl.find((i) => i.role === 'paste')!.enabled).toBe(true);
    });
});

describe('installContextMenu', () => {
    it('a right-click shows the menu; the spell checker is on in the person’s languages; installing twice adds nothing', () => {
        const f = fakeContents();
        const shown: MenuTemplateItem[][] = [];
        const deps = { show: (tpl: MenuTemplateItem[]) => { shown.push(tpl); }, preferredLanguages: () => ['en-GB', 'de-DE'] };
        installContextMenu(f.contents, deps);
        installContextMenu(f.contents, deps);
        expect(f.listeners()).toBe(1);
        expect(f.calls).toEqual(['enabled:true', 'languages:en-GB']);
        f.fire(params({ isEditable: false, selectionText: 'x' }));
        expect(shown).toHaveLength(1);
        expect(shown[0]!.map((i) => i.role)).toEqual(['copy', 'selectAll']);
    });
});

describe('spellLanguages', () => {
    it('the person’s languages the checker has, an exact tag first, else the same language; en-US when none match', () => {
        expect(spellLanguages(['en-CA', 'fr-FR'], ['en-US', 'en-CA', 'fr'])).toEqual(['en-CA', 'fr']);
        expect(spellLanguages(['de'], ['de-DE', 'en-US'])).toEqual(['de-DE']);
        expect(spellLanguages(['ja-JP'], ['en-US', 'fr'])).toEqual(['en-US']);
        expect(spellLanguages(['ja-JP'], [])).toEqual([]);
    });
});

describe('the wiring', () => {
    it('main installs it on every webContents Genie creates', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/app\.on\('web-contents-created'[\s\S]{0,400}installContextMenu\(/);
    });

    it('saved prompts (prose sent to an agent) are spell checked', () => {
        const src = readFileSync('src/renderer/components/FeatureSurfaces.tsx', 'utf8');
        expect(src).not.toMatch(/<Textarea[^>]*aria-label=\{`Text of [^>]*spellCheck=\{false\}/);
        expect(src).not.toMatch(/<Textarea aria-label="New prompt text"[^>]*spellCheck=\{false\}/);
    });

    it('control: the URL bar and the sign-in code stay unchecked', () => {
        expect(readFileSync('src/renderer/components/GenieBrowserChrome.tsx', 'utf8')).toContain('spellCheck={false}');
        expect(readFileSync('src/renderer/components/FeatureSurfaces.tsx', 'utf8')).toMatch(/<Input name="code"[^>]*spellCheck=\{false\}/);
    });
});

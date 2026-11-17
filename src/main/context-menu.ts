/**
 * THE RIGHT-CLICK MENU AND THE SPELL CHECKER (beta.64, the owner): "we need a spell checker and context menus".
 *
 * Electron draws no context menu of its own: a right-click in a Genie window did nothing, so a misspelling under its
 * red squiggle could not be corrected and a chat message could only be copied by keyboard. Chromium still works out
 * what was clicked and hands it to `webContents`' `context-menu` event (`isEditable`, the misspelled word and the
 * spell checker's suggestions, the selection, what Cut / Copy / Paste can do right now); this module turns that into
 * the menu, and turns the spell checker on in the person's own languages.
 *
 * - A text field (an input, a textarea, the chat composer, the file editor): up to five suggestions for a misspelled
 *   word, or "No suggestions", and Add to dictionary; then Cut, Copy, Paste and Select all.
 * - Text that cannot be edited (a chat message, the file viewer): Copy and Select all.
 *
 * A surface that draws its own menu (the Files tree, a terminal) calls `preventDefault()` on the DOM `contextmenu`
 * event, and Chromium then never raises this one, so the two never both open.
 *
 * Pure apart from what it is handed: main.ts passes Electron's Menu in `show`, so all of it is tested without Electron.
 */

export interface ContextParams {
    isEditable: boolean;
    misspelledWord: string;
    dictionarySuggestions: readonly string[];
    selectionText: string;
    editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export type EditRole = 'cut' | 'copy' | 'paste' | 'selectAll';

export type MenuEntry =
    | { kind: 'suggestion'; word: string }
    | { kind: 'no-suggestions' }
    | { kind: 'add-word'; word: string }
    | { kind: 'role'; role: EditRole; enabled: boolean }
    | { kind: 'separator' };

/** The slice of Electron's `MenuItemConstructorOptions` this menu uses. */
export interface MenuTemplateItem {
    label?: string;
    role?: EditRole;
    type?: 'separator';
    enabled?: boolean;
    click?: () => void;
}

export interface SpellSession {
    availableSpellCheckerLanguages: readonly string[];
    setSpellCheckerEnabled(enabled: boolean): void;
    setSpellCheckerLanguages(languages: string[]): void;
    addWordToSpellCheckerDictionary(word: string): boolean;
}

export interface MenuWebContents {
    on(event: 'context-menu', listener: (event: unknown, params: ContextParams) => void): unknown;
    replaceMisspelling(word: string): void;
    session: SpellSession;
}

export interface InstallDeps {
    show: (template: MenuTemplateItem[], contents: MenuWebContents) => void;
    /** The person's languages, most preferred first (`app.getPreferredSystemLanguages()`). */
    preferredLanguages: () => readonly string[];
}

/** More than five suggestions is a list to read, not a correction to pick. */
const MAX_SUGGESTIONS = 5;

export function contextMenuEntries(params: ContextParams): MenuEntry[] {
    const f = params.editFlags;
    if (!params.isEditable) {
        return [
            { kind: 'role', role: 'copy', enabled: f.canCopy || params.selectionText !== '' },
            { kind: 'role', role: 'selectAll', enabled: true },
        ];
    }
    const out: MenuEntry[] = [];
    if (params.misspelledWord !== '') {
        const words = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
        if (words.length === 0) out.push({ kind: 'no-suggestions' });
        for (const word of words) out.push({ kind: 'suggestion', word });
        out.push({ kind: 'add-word', word: params.misspelledWord }, { kind: 'separator' });
    }
    out.push(
        { kind: 'role', role: 'cut', enabled: f.canCut },
        { kind: 'role', role: 'copy', enabled: f.canCopy },
        { kind: 'role', role: 'paste', enabled: f.canPaste },
        { kind: 'separator' },
        { kind: 'role', role: 'selectAll', enabled: f.canSelectAll },
    );
    return out;
}

export function menuTemplate(entries: readonly MenuEntry[], contents: MenuWebContents): MenuTemplateItem[] {
    return entries.map((e): MenuTemplateItem => {
        switch (e.kind) {
            case 'suggestion': return { label: e.word, click: () => contents.replaceMisspelling(e.word) };
            case 'no-suggestions': return { label: 'No suggestions', enabled: false };
            case 'add-word': return { label: 'Add to dictionary', click: () => { contents.session.addWordToSpellCheckerDictionary(e.word); } };
            case 'role': return { role: e.role, enabled: e.enabled };
            case 'separator': return { type: 'separator' };
        }
    });
}

const base = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0] ?? '';

/**
 * The person's languages the spell checker has: the exact tag when it has it (`en-CA`), else the first of the same
 * language (`de` → `de-DE`). None of theirs → `en-US` if it has that, so the squiggles are never silently off.
 * On macOS the system's own checker follows the system's languages, and `availableSpellCheckerLanguages` is empty.
 */
export function spellLanguages(preferred: readonly string[], available: readonly string[]): string[] {
    const out: string[] = [];
    for (const want of preferred) {
        const exact = available.find((a) => a.toLowerCase() === want.toLowerCase());
        const near = exact ?? available.find((a) => base(a) === base(want));
        if (near && !out.includes(near)) out.push(near);
    }
    if (out.length === 0 && available.includes('en-US')) out.push('en-US');
    return out;
}

const installed = new WeakSet<object>();
const configured = new WeakSet<object>();

export function installContextMenu(contents: MenuWebContents, deps: InstallDeps): void {
    if (installed.has(contents)) return;
    installed.add(contents);
    const ses = contents.session;
    if (!configured.has(ses)) {
        configured.add(ses);
        ses.setSpellCheckerEnabled(true);
        const languages = spellLanguages(deps.preferredLanguages(), ses.availableSpellCheckerLanguages);
        // macOS has no list to choose from and ignores the call; elsewhere an unknown tag throws, which must not cost the menu.
        if (languages.length > 0) {
            try { ses.setSpellCheckerLanguages(languages); } catch { /* the checker keeps its default language */ }
        }
    }
    contents.on('context-menu', (_event, params) => {
        const template = menuTemplate(contextMenuEntries(params), contents);
        if (template.length > 0) deps.show(template, contents);
    });
}

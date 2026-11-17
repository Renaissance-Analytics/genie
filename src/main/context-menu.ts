/**
 * THE RIGHT-CLICK MENU AND THE SPELL CHECKER (beta.64). STUB: written in GREEN.
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
    preferredLanguages: () => readonly string[];
}

export function contextMenuEntries(_params: ContextParams): MenuEntry[] {
    return [];
}

export function menuTemplate(_entries: readonly MenuEntry[], _contents: MenuWebContents): MenuTemplateItem[] {
    return [];
}

export function spellLanguages(_preferred: readonly string[], _available: readonly string[]): string[] {
    return [];
}

export function installContextMenu(_contents: MenuWebContents, _deps: InstallDeps): void {}

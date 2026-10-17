import { describe, expect, it } from 'vitest';
import {
    acceleratorFromPress,
    hotkeyProblem,
    newPromptId,
    parsePromptLibrary,
    promptForPress,
    promptTarget,
    removePrompt,
    serializePromptLibrary,
    upsertPrompt,
    type SavedPrompt,
} from '../src/core/prompt-library.js';
import { carryOverV1 } from '../src/core/settings.js';

/**
 * SAVED PROMPTS WITH THEIR OWN HOTKEYS (Tynn #758). The owner, 2026-10-17: "the ability to create prompts I can assign
 * hotkeys to is missing". Genie 1 kept a prompt library in the `saved_prompts` setting (renderer/lib/prompt-library.ts at
 * v0.7.0-beta.342) and offered it in the Command Window; its rules are ported — a forgiving read, a row kept only if it
 * can be found AND sent, an edit keeps its place. New in Genie 2: each prompt may carry a hotkey that sends it at once.
 */
const press = (key: string, mod: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}, typing = false) => ({
    key,
    ctrlKey: mod.ctrl ?? false,
    metaKey: mod.meta ?? false,
    altKey: mod.alt ?? false,
    shiftKey: mod.shift ?? false,
    typing,
});

const library: SavedPrompt[] = [
    { id: 'p1', label: 'Review the diff', text: 'Review your diff before you commit.', hotkey: 'CommandOrControl+Alt+R' },
    { id: 'p2', label: 'Status', text: 'Where are you up to?' },
    { id: 'p3', label: 'Nudge', text: 'Ask me with ForceTheQuestion.', hotkey: 'F6' },
];

describe('the library, read forgivingly (Genie 1’s rules)', () => {
    it('a broken library is empty; a broken ROW is dropped and the rest survive', () => {
        expect(parsePromptLibrary(undefined)).toEqual([]);
        expect(parsePromptLibrary('{not json')).toEqual([]);
        expect(parsePromptLibrary('{"id":"x"}')).toEqual([]);
        const raw = JSON.stringify([{ id: 'a', label: 'A', text: 'go' }, { id: 'b', label: '', text: 'x' }, { id: 'c', label: 'C', text: '  ' }, 7]);
        expect(parsePromptLibrary(raw)).toEqual([{ id: 'a', label: 'A', text: 'go' }]);
    });

    it('keeps a well-formed hotkey; a malformed one is dropped from the row, never the row itself', () => {
        const raw = JSON.stringify([{ id: 'a', label: 'A', text: 'go', hotkey: 'Ctrl+Alt+R' }, { id: 'b', label: 'B', text: 'go', hotkey: 'Ctrl+Banana+' }, { id: 'c', label: 'C', text: 'go', hotkey: 5, extra: true }]);
        expect(parsePromptLibrary(raw)).toEqual([
            { id: 'a', label: 'A', text: 'go', hotkey: 'Ctrl+Alt+R' },
            { id: 'b', label: 'B', text: 'go' },
            { id: 'c', label: 'C', text: 'go' },
        ]);
    });

    it('round-trips, an edit keeps its place, a removal removes one', () => {
        expect(parsePromptLibrary(serializePromptLibrary(library))).toEqual(library);
        expect(upsertPrompt(library, { id: 'p2', label: 'Status?', text: 'x' }).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
        expect(upsertPrompt(library, { id: 'p4', label: 'New', text: 'x' }).map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
        expect(removePrompt(library, 'p2').map((p) => p.id)).toEqual(['p1', 'p3']);
        expect(newPromptId(1, 0.5)).toMatch(/^p-1-/);
    });

    it('Genie 1’s saved_prompts carries over to Genie 2, as written', () => {
        const v1 = JSON.stringify([{ id: 'p-a', label: 'Ship it', text: 'Open a PR.' }]);
        expect(carryOverV1({ saved_prompts: v1 })).toEqual({ applied: { saved_prompts: v1 }, dropped: [] });
    });
});

describe('a prompt’s hotkey', () => {
    // CommandOrControl is Ctrl OR ⌘ — exactly one — on every platform (Tynn #759): Genie 2's chords have always taken
    // either (core/keys.ts), and the title bar's first-paint "Ctrl K" is true only if Ctrl works on an Apple keyboard too.
    it('Ctrl or ⌘ for CommandOrControl, on every platform; the exact modifiers, no more', () => {
        expect(promptForPress(library, press('r', { ctrl: true, alt: true }), 'win32')?.id).toBe('p1');
        expect(promptForPress(library, press('R', { meta: true, alt: true }), 'darwin')?.id).toBe('p1');
        expect(promptForPress(library, press('r', { ctrl: true, alt: true }), 'darwin')?.id).toBe('p1');
        expect(promptForPress(library, press('r', { ctrl: true, meta: true, alt: true }), 'darwin')).toBeNull();
        expect(promptForPress(library, press('r', { ctrl: true, alt: true, shift: true }), 'win32')).toBeNull();
        expect(promptForPress(library, press('F6'), 'linux')?.id).toBe('p3');
        expect(promptForPress(library, press('F6', {}, true), 'linux')?.id).toBe('p3');
        expect(promptForPress(library, press('r'), 'win32')).toBeNull();
    });

    it('the recorder writes what was pressed; a lone modifier is not a hotkey yet', () => {
        expect(acceleratorFromPress(press('r', { ctrl: true, alt: true }), 'win32')).toBe('CommandOrControl+Alt+R');
        expect(acceleratorFromPress(press('r', { meta: true, shift: true }), 'darwin')).toBe('CommandOrControl+Shift+R');
        expect(acceleratorFromPress(press('F6'), 'linux')).toBe('F6');
        expect(acceleratorFromPress(press('Control', { ctrl: true }), 'win32')).toBeNull();
        expect(acceleratorFromPress(press('Shift', { shift: true }), 'win32')).toBeNull();
    });

    it('refused, with the reason: a key you type with, a key Genie already uses, a key another prompt has', () => {
        expect(hotkeyProblem('', library, 'p2', 'win32')).toBeNull();
        expect(hotkeyProblem('CommandOrControl+Alt+P', library, 'p2', 'win32')).toBeNull();
        expect(hotkeyProblem('F7', library, 'p2', 'win32')).toBeNull();
        expect(hotkeyProblem('R', library, 'p2', 'win32')).toMatch(/typ/);
        expect(hotkeyProblem('Shift+R', library, 'p2', 'win32')).toMatch(/typ/);
        expect(hotkeyProblem('CommandOrControl+K', library, 'p2', 'win32')).toMatch(/Command Window/);
        expect(hotkeyProblem('CommandOrControl+J', library, 'p2', 'win32')).toMatch(/chat/);
        expect(hotkeyProblem('CommandOrControl+B', library, 'p2', 'win32')).toMatch(/file/);
        expect(hotkeyProblem('CommandOrControl+Shift+T', library, 'p2', 'win32')).toMatch(/Take Over/);
        expect(hotkeyProblem('CommandOrControl+,', library, 'p2', 'win32')).toMatch(/Settings/);
        expect(hotkeyProblem('Ctrl+Alt+R', library, 'p2', 'win32')).toMatch(/Review the diff/);
        // Its own hotkey is not a clash with itself.
        expect(hotkeyProblem('CommandOrControl+Alt+R', library, 'p1', 'win32')).toBeNull();
    });
});

describe('where a prompt goes', () => {
    it('the agent whose chat is open, else the agent on screen, else Genie', () => {
        expect(promptTarget({ chat: 'moic', agentOnScreen: 'tynn' })).toBe('moic');
        expect(promptTarget({ chat: null, agentOnScreen: 'tynn' })).toBe('tynn');
        expect(promptTarget({ chat: null, agentOnScreen: null })).toBe('genie');
    });
});

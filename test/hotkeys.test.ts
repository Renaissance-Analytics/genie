import { describe, expect, it } from 'vitest';
import { DEFAULT_HOTKEYS, FTQ_NUDGE_TEXT, bindingProblem, bindingsFrom, hotkeyAction } from '../src/core/hotkeys.js';
import { globalAction } from '../src/core/keys.js';
import { hotkeyProblem } from '../src/core/prompt-library.js';
import { carryOverV1, SETTINGS } from '../src/core/settings.js';

/**
 * GENIE'S REMAPPABLE KEYS (Tynn #759; Genie 1's renderer/lib/hotkeys.ts and ftq-nudge.ts at v0.7.0-beta.342). The owner,
 * 2026-10-17: "the FTQ nudge fired from a hotkey (default F5) ... is missing". F5 sends the agent in front of you Genie 1's
 * nudge — "you asked into the void, ask again properly" — and both it and the Command Window's Ctrl+K are remappable in
 * Settings, carried over from Genie 1. A malformed binding is DISABLED, never thrown on every keystroke.
 */
const press = (key: string, mod: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}, typing = false) => ({
    key,
    ctrlKey: mod.ctrl ?? false,
    metaKey: mod.meta ?? false,
    altKey: mod.alt ?? false,
    shiftKey: mod.shift ?? false,
    typing,
});

describe('the bindings', () => {
    it('defaults are Genie 1’s: Ctrl/⌘+K and F5; the nudge text is Genie 1’s, word for word', () => {
        expect(DEFAULT_HOTKEYS).toEqual({ commandWindow: 'CommandOrControl+K', ftqNudge: 'F5' });
        expect(FTQ_NUDGE_TEXT).toBe('Use ForceTheQuestion to help me understand what you need');
    });

    it('read from settings: empty → the default; malformed → disabled (null), never a throw', () => {
        expect(bindingsFrom({})).toEqual(DEFAULT_HOTKEYS);
        expect(bindingsFrom({ command_window_hotkey: '', ftq_nudge_hotkey: '' })).toEqual(DEFAULT_HOTKEYS);
        expect(bindingsFrom({ command_window_hotkey: 'CommandOrControl+P', ftq_nudge_hotkey: 'F6' })).toEqual({ commandWindow: 'CommandOrControl+P', ftqNudge: 'F6' });
        expect(bindingsFrom({ ftq_nudge_hotkey: 'Ctrl+Banana+' })).toEqual({ commandWindow: 'CommandOrControl+K', ftqNudge: null });
    });

    it('both are settings, hidden from the generic list (drawn as recorders), and carry over from Genie 1', () => {
        for (const key of ['command_window_hotkey', 'ftq_nudge_hotkey']) {
            expect(SETTINGS.find((s) => s.key === key)).toMatchObject({ type: 'string', default: '', hidden: true, scope: 'host' });
        }
        expect(carryOverV1({ ftq_nudge_hotkey: 'F6', command_window_hotkey: 'CommandOrControl+P' }).applied).toEqual({ ftq_nudge_hotkey: 'F6', command_window_hotkey: 'CommandOrControl+P' });
    });
});

describe('a key press', () => {
    it('Ctrl+K on Windows/Linux and ⌘K on macOS open the Command Window — even while typing; a bare K never does', () => {
        expect(hotkeyAction(press('k', { ctrl: true }), DEFAULT_HOTKEYS, 'win32')).toBe('open-palette');
        expect(hotkeyAction(press('K', { meta: true }, true), DEFAULT_HOTKEYS, 'darwin')).toBe('open-palette');
        expect(hotkeyAction(press('k'), DEFAULT_HOTKEYS, 'win32')).toBeNull();
        // Ctrl works on an Apple keyboard too — the title bar's first-paint "Ctrl K" is a key that exists everywhere.
        expect(hotkeyAction(press('k', { ctrl: true }), DEFAULT_HOTKEYS, 'darwin')).toBe('open-palette');
        expect(hotkeyAction(press('k', { ctrl: true, meta: true }), DEFAULT_HOTKEYS, 'darwin')).toBeNull();
    });

    it('F5 is the nudge, even while typing; remapped, F5 is nothing and the new key is the nudge', () => {
        expect(hotkeyAction(press('F5', {}, true), DEFAULT_HOTKEYS, 'linux')).toBe('ftq-nudge');
        const remapped = { commandWindow: 'CommandOrControl+P', ftqNudge: 'F6' };
        expect(hotkeyAction(press('F5'), remapped, 'linux')).toBeNull();
        expect(hotkeyAction(press('F6'), remapped, 'linux')).toBe('ftq-nudge');
        expect(hotkeyAction(press('k', { ctrl: true }), remapped, 'linux')).toBeNull();
        expect(hotkeyAction(press('p', { ctrl: true }), remapped, 'linux')).toBe('open-palette');
    });

    it('a disabled binding binds nothing', () => {
        expect(hotkeyAction(press('F5'), { commandWindow: 'CommandOrControl+K', ftqNudge: null }, 'linux')).toBeNull();
    });

    it('Ctrl+K is no longer a fixed chord: it is the remappable binding’s, so the fixed map does not also claim it', () => {
        expect(globalAction(press('k', { ctrl: true }))).toBeNull();
        // CONTROL: the fixed chords that stay fixed still answer.
        expect(globalAction(press('j', { ctrl: true }))).toBe('toggle-chat');
    });
});

describe('remapping is refused, with the reason', () => {
    const prompts = [{ id: 'p1', label: 'Review the diff', text: 'x', hotkey: 'CommandOrControl+Alt+R' }];
    it('a key you type with, Genie’s fixed keys, the other binding, a prompt’s key', () => {
        expect(bindingProblem('F7', 'ftqNudge', DEFAULT_HOTKEYS, prompts, 'win32')).toBeNull();
        expect(bindingProblem('', 'ftqNudge', DEFAULT_HOTKEYS, prompts, 'win32')).toBeNull();
        expect(bindingProblem('R', 'ftqNudge', DEFAULT_HOTKEYS, prompts, 'win32')).toMatch(/typ/);
        expect(bindingProblem('CommandOrControl+J', 'commandWindow', DEFAULT_HOTKEYS, prompts, 'win32')).toMatch(/chat/);
        expect(bindingProblem('CommandOrControl+,', 'ftqNudge', DEFAULT_HOTKEYS, prompts, 'win32')).toMatch(/Settings/);
        expect(bindingProblem('CommandOrControl+K', 'ftqNudge', DEFAULT_HOTKEYS, prompts, 'win32')).toMatch(/Command Window/);
        expect(bindingProblem('F5', 'commandWindow', DEFAULT_HOTKEYS, prompts, 'win32')).toMatch(/ForceTheQuestion/);
        expect(bindingProblem('Ctrl+Alt+R', 'ftqNudge', DEFAULT_HOTKEYS, prompts, 'win32')).toMatch(/Review the diff/);
        // Its own current key is not a clash with itself.
        expect(bindingProblem('F5', 'ftqNudge', DEFAULT_HOTKEYS, prompts, 'win32')).toBeNull();
    });

    it('a prompt cannot take either binding — wherever it is mapped', () => {
        const remapped = { commandWindow: 'CommandOrControl+P', ftqNudge: 'F6' };
        expect(hotkeyProblem('F6', [], 'new', 'win32', remapped)).toMatch(/ForceTheQuestion/);
        expect(hotkeyProblem('CommandOrControl+P', [], 'new', 'win32', remapped)).toMatch(/Command Window/);
        // Ctrl+K is free once the Command Window has moved off it.
        expect(hotkeyProblem('CommandOrControl+K', [], 'new', 'win32', remapped)).toBeNull();
        expect(hotkeyProblem('CommandOrControl+K', [], 'new', 'win32', DEFAULT_HOTKEYS)).toMatch(/Command Window/);
    });
});

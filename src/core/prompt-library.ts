import type { CommandItem } from './command-window.js';
import { agentViewAction, globalAction, type KeyPress } from './keys.js';

/**
 * SAVED PROMPTS WITH THEIR OWN HOTKEYS (Tynn #758; Genie 1 story #247 — its renderer/lib/prompt-library.ts at
 * v0.7.0-beta.342, ported). The owner, 2026-10-17: "the ability to create prompts I can assign hotkeys to is missing".
 *
 * The library is JSON in the `saved_prompts` setting, and Genie 1's rule for reading it holds: deliberately FORGIVING.
 * The string is hand-editable, carried over from Genie 1 and read on the path that opens the Command Window — anything
 * that throws here costs the person Ctrl+K. A broken library is empty; a broken ROW is dropped and the rest survive; a
 * broken HOTKEY is dropped from its row and the prompt stays.
 *
 * New in Genie 2: each prompt may carry a hotkey (an Electron-style accelerator, `CommandOrControl+Alt+R`) that sends
 * it at once to the agent in front of the person. A hotkey must be a chord or a function key — a key you type with
 * would fire in the middle of a sentence — and must not take one Genie already uses or another prompt has.
 */
export interface SavedPrompt {
    readonly id: string;
    /** What the person reads and searches by. */
    readonly label: string;
    /** What is sent to the agent. */
    readonly text: string;
    /** An accelerator; absent when the prompt has none. */
    readonly hotkey?: string;
}

interface Chord {
    readonly key: string;
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
}

const MODIFIER_KEYS = new Set(['control', 'ctrl', 'meta', 'os', 'alt', 'altgraph', 'shift', 'command', 'cmd', 'super', 'option', 'commandorcontrol', 'cmdorctrl']);

const isFunctionKey = (key: string): boolean => /^f([1-9]|1[0-9]|2[0-4])$/i.test(key);

/** Parse an accelerator; `null` for anything malformed, so a bad value disables its binding rather than throwing on every key. */
function parseAccelerator(accelerator: string, platform: string): Chord | null {
    const parts = accelerator.split('+').map((p) => p.trim());
    if (parts.length === 0 || parts.some((p) => p.length === 0)) return null;
    const key = parts[parts.length - 1]!.toLowerCase();
    if (MODIFIER_KEYS.has(key)) return null;
    const chord = { key, ctrl: false, meta: false, alt: false, shift: false };
    for (const modifier of parts.slice(0, -1).map((m) => m.toLowerCase())) {
        switch (modifier) {
            case 'commandorcontrol':
            case 'cmdorctrl':
                // Command on macOS, Control elsewhere — Ctrl+K on macOS stays with the shell.
                if (platform === 'darwin') chord.meta = true;
                else chord.ctrl = true;
                break;
            case 'control':
            case 'ctrl':
                chord.ctrl = true;
                break;
            case 'command':
            case 'cmd':
            case 'meta':
            case 'super':
                chord.meta = true;
                break;
            case 'alt':
            case 'option':
                chord.alt = true;
                break;
            case 'shift':
                chord.shift = true;
                break;
            default:
                // An unknown modifier must not silently widen the binding.
                return null;
        }
    }
    return chord;
}

function chordMatches(chord: Chord, press: KeyPress): boolean {
    return press.key.toLowerCase() === chord.key && press.ctrlKey === chord.ctrl && press.metaKey === chord.meta && press.altKey === chord.alt && press.shiftKey === chord.shift;
}

/** A row is usable only if the palette can both FIND it and SEND it. */
function isUsable(value: unknown): value is { id: string; label: string; text: string; hotkey?: unknown } {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Record<string, unknown>;
    return typeof row.id === 'string' && row.id.trim().length > 0 && typeof row.label === 'string' && row.label.trim().length > 0 && typeof row.text === 'string' && row.text.trim().length > 0;
}

export function parsePromptLibrary(raw: string | undefined): SavedPrompt[] {
    if (!raw || !raw.trim()) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    // Narrowed to the fields Genie uses: a newer Genie's extra fields are not carried into this one's state.
    return parsed.filter(isUsable).map((p) => {
        const hotkey = typeof p.hotkey === 'string' && parseAccelerator(p.hotkey, 'linux') !== null ? p.hotkey : null;
        return hotkey === null ? { id: p.id, label: p.label, text: p.text } : { id: p.id, label: p.label, text: p.text, hotkey };
    });
}

export function serializePromptLibrary(prompts: readonly SavedPrompt[]): string {
    return JSON.stringify(prompts);
}

/** Add or replace a prompt, KEEPING its position: the palette keeps the library's order, and a moved row moves Enter. */
export function upsertPrompt(prompts: readonly SavedPrompt[], prompt: SavedPrompt): SavedPrompt[] {
    const at = prompts.findIndex((p) => p.id === prompt.id);
    if (at === -1) return [...prompts, prompt];
    const next = [...prompts];
    next[at] = prompt;
    return next;
}

export function removePrompt(prompts: readonly SavedPrompt[], id: string): SavedPrompt[] {
    return prompts.filter((p) => p.id !== id);
}

/** An id for a new prompt. Time-ordered so a carried-over library stays readable. */
export function newPromptId(now: number, random: number): string {
    return `p-${now.toString(36)}-${Math.floor(random * 1e6).toString(36)}`;
}

/** The prompt a keypress sends, or `null`. A chord, so it acts while typing too — the composer must not swallow it. */
export function promptForPress(prompts: readonly SavedPrompt[], press: KeyPress, platform: string): SavedPrompt | null {
    for (const prompt of prompts) {
        if (!prompt.hotkey) continue;
        const chord = parseAccelerator(prompt.hotkey, platform);
        if (chord && chordMatches(chord, press)) return prompt;
    }
    return null;
}

/**
 * The recorder: what the person pressed, as an accelerator. Ctrl (⌘ on macOS) is written `CommandOrControl` so a
 * library carried between machines means the same key on each. `null` while only modifiers are down.
 */
export function acceleratorFromPress(press: KeyPress, platform: string): string | null {
    if (MODIFIER_KEYS.has(press.key.toLowerCase())) return null;
    const parts: string[] = [];
    const primary = platform === 'darwin' ? press.metaKey : press.ctrlKey;
    const other = platform === 'darwin' ? press.ctrlKey : press.metaKey;
    if (primary) parts.push('CommandOrControl');
    if (other) parts.push(platform === 'darwin' ? 'Control' : 'Super');
    if (press.altKey) parts.push('Alt');
    if (press.shiftKey) parts.push('Shift');
    parts.push(press.key.length === 1 ? press.key.toUpperCase() : press.key);
    return parts.join('+');
}

/** How a hotkey reads on this platform: `Ctrl+Alt+R` on Windows and Linux, `⌘+Alt+R` on macOS. */
export function hotkeyLabel(accelerator: string, platform: string): string {
    return accelerator
        .split('+')
        .map((part) => {
            const p = part.toLowerCase();
            if (p === 'commandorcontrol' || p === 'cmdorctrl') return platform === 'darwin' ? '⌘' : 'Ctrl';
            if (p === 'control') return 'Ctrl';
            return part;
        })
        .join('+');
}

/**
 * Why a hotkey cannot be used, or `null` when it can (an empty one is "no hotkey" and always fine). Genie's own chords
 * are asked of the functions that bind them, never a second hand-kept list.
 */
export function hotkeyProblem(accelerator: string, prompts: readonly SavedPrompt[], selfId: string, platform: string): string | null {
    if (accelerator.trim() === '') return null;
    const chord = parseAccelerator(accelerator, platform);
    if (!chord) return 'That is not a key Genie can read.';
    if (!chord.ctrl && !chord.meta && !chord.alt && !isFunctionKey(chord.key)) {
        return 'That key is used for typing — hold Ctrl (⌘ on macOS) or Alt with it, or use a function key.';
    }
    const press: KeyPress = { key: chord.key, ctrlKey: chord.ctrl, metaKey: chord.meta, altKey: chord.alt, shiftKey: chord.shift, typing: false };
    const genie = globalAction(press);
    if (genie === 'open-palette') return 'Genie uses that key for the Command Window.';
    if (genie === 'toggle-chat') return 'Genie uses that key to open and close the chat.';
    if (genie === 'toggle-files') return 'Genie uses that key for the file panel.';
    if (agentViewAction(press) === 'take-over') return 'Genie uses that key for Take Over.';
    const other = prompts.find((p) => p.id !== selfId && p.hotkey && (() => {
        const theirs = parseAccelerator(p.hotkey, platform);
        return theirs !== null && theirs.key === chord.key && theirs.ctrl === chord.ctrl && theirs.meta === chord.meta && theirs.alt === chord.alt && theirs.shift === chord.shift;
    })());
    if (other) return `“${other.label}” already has that key.`;
    return null;
}

/** The Command Window's prompt items, in the library's order, each hotkey as its hint. */
export function promptPaletteItems(prompts: readonly SavedPrompt[], platform: string): CommandItem[] {
    return prompts.map((p) => (p.hotkey ? { id: p.id, category: 'prompt' as const, label: p.label, hint: hotkeyLabel(p.hotkey, platform) } : { id: p.id, category: 'prompt' as const, label: p.label }));
}

/**
 * Where a prompt goes: the agent whose chat is open, else the agent on screen, else Genie — who is always there. A
 * prompt that went nowhere would be a key that did nothing.
 */
export function promptTarget(where: { chat: string | null; agentOnScreen: string | null }): string {
    return where.chat ?? where.agentOnScreen ?? 'genie';
}

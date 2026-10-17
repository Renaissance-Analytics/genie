import type { CommandItem } from './command-window.js';
import { DEFAULT_HOTKEYS, chordMatches, genieKeyProblem, hotkeyLabel, parseAccelerator, sameChord, type HotkeyBindings } from './hotkeys.js';
import type { KeyPress } from './keys.js';

export { hotkeyLabel };

/**
 * SAVED PROMPTS WITH THEIR OWN HOTKEYS (Tynn #758; Genie 1 story #247 — its renderer/lib/prompt-library.ts at
 * v0.7.0-beta.342, ported). The owner, 2026-10-17: "the ability to create prompts I can assign hotkeys to is missing".
 *
 * The library is JSON in the `saved_prompts` setting, and Genie 1's rule for reading it holds: deliberately FORGIVING.
 * The string is hand-editable, carried over from Genie 1 and read on the path that opens the Command Window — anything
 * that throws here costs the person Ctrl+K. A broken library is empty; a broken ROW is dropped and the rest survive; a
 * broken HOTKEY is dropped from its row and the prompt stays.
 *
 * New in Genie 2: each prompt may carry a hotkey (an Electron-style accelerator, `CommandOrControl+Alt+R`; parsed and
 * matched by core/hotkeys.ts) that sends it at once to the agent in front of the person. A hotkey must be a chord or a
 * function key — a key you type with would fire in the middle of a sentence — and must not take one Genie uses (its
 * fixed chords, and the Command Window and nudge keys wherever they are mapped) or another prompt has.
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

const MODIFIER_KEYS = new Set(['control', 'ctrl', 'meta', 'os', 'alt', 'altgraph', 'shift', 'command', 'cmd', 'super', 'option']);

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
        const hotkey = typeof p.hotkey === 'string' && parseAccelerator(p.hotkey) !== null ? p.hotkey : null;
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
export function promptForPress(prompts: readonly SavedPrompt[], press: KeyPress, _platform: string): SavedPrompt | null {
    for (const prompt of prompts) {
        if (!prompt.hotkey) continue;
        const chord = parseAccelerator(prompt.hotkey);
        if (chord && chordMatches(chord, press)) return prompt;
    }
    return null;
}

/**
 * The recorder: what the person pressed, as an accelerator. Ctrl or ⌘ is written `CommandOrControl` so a library
 * carried between machines means the same key on each (core/hotkeys.ts: either one, on every platform). `null` while
 * only modifiers are down.
 */
export function acceleratorFromPress(press: KeyPress, _platform: string): string | null {
    if (MODIFIER_KEYS.has(press.key.toLowerCase())) return null;
    const parts: string[] = [];
    if (press.ctrlKey && press.metaKey) parts.push('Control', 'Command');
    else if (press.ctrlKey || press.metaKey) parts.push('CommandOrControl');
    if (press.altKey) parts.push('Alt');
    if (press.shiftKey) parts.push('Shift');
    parts.push(press.key.length === 1 ? press.key.toUpperCase() : press.key);
    return parts.join('+');
}

/** Why a prompt's hotkey cannot be used, or `null` when it can (an empty one is "no hotkey" and always fine). */
export function hotkeyProblem(accelerator: string, prompts: readonly SavedPrompt[], selfId: string, _platform: string, bindings: HotkeyBindings = DEFAULT_HOTKEYS): string | null {
    if (accelerator.trim() === '') return null;
    const problem = genieKeyProblem(accelerator, bindings, null);
    if (problem !== null) return problem;
    const chord = parseAccelerator(accelerator)!;
    const other = prompts.find((p) => {
        if (p.id === selfId || !p.hotkey) return false;
        const theirs = parseAccelerator(p.hotkey);
        return theirs !== null && sameChord(chord, theirs);
    });
    return other ? `“${other.label}” already has that key.` : null;
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

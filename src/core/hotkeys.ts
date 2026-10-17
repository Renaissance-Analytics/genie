import { agentViewAction, globalAction, type KeyPress } from './keys.js';

/**
 * GENIE'S REMAPPABLE KEYS (Tynn #759; Genie 1's renderer/lib/hotkeys.ts and ftq-nudge.ts at v0.7.0-beta.342, ported).
 * The owner, 2026-10-17: "the FTQ nudge fired from a hotkey (default F5) ... is missing".
 *
 * Two keys are the person's to move: the Command Window (Ctrl/⌘+K) and the ForceTheQuestion nudge (F5) — the second
 * sends the agent in front of you Genie 1's words, for an agent that asked its question in plain text where nobody was
 * looking. Both are settings (`command_window_hotkey`, `ftq_nudge_hotkey`) carried over from Genie 1; empty means
 * Genie's default, and a MALFORMED value disables that binding rather than throwing on every keystroke — this runs on
 * the keydown path of the whole window.
 *
 * Accelerators are Electron-style. `CommandOrControl` is Ctrl OR ⌘ — exactly one — on every platform: Genie 2's fixed
 * chords have always taken either (core/keys.ts), and the title bar's first-paint "Ctrl K" is true only if Ctrl works on
 * an Apple keyboard too. `Control` and `Command` name one key each.
 */

/** Genie 1's nudge, word for word: an instruction naming the tool and what the re-ask is for, not a hint. */
export const FTQ_NUDGE_TEXT = 'Use ForceTheQuestion to help me understand what you need';

export interface HotkeyBindings {
    /** `null` = disabled (the setting held something Genie cannot read). */
    readonly commandWindow: string | null;
    readonly ftqNudge: string | null;
}

export type BindingName = keyof HotkeyBindings;

export const DEFAULT_HOTKEYS: { readonly commandWindow: string; readonly ftqNudge: string } = { commandWindow: 'CommandOrControl+K', ftqNudge: 'F5' };

export const BINDING_SETTING: Readonly<Record<BindingName, string>> = { commandWindow: 'command_window_hotkey', ftqNudge: 'ftq_nudge_hotkey' };

export const BINDING_LABEL: Readonly<Record<BindingName, string>> = { commandWindow: 'the Command Window', ftqNudge: 'the ForceTheQuestion nudge' };

export interface Chord {
    readonly key: string;
    /** Ctrl or ⌘, either one (CommandOrControl). */
    readonly primary: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
}

const MODIFIER_KEYS = new Set(['control', 'ctrl', 'meta', 'os', 'alt', 'altgraph', 'shift', 'command', 'cmd', 'super', 'option', 'commandorcontrol', 'cmdorctrl']);

export const isFunctionKey = (key: string): boolean => /^f([1-9]|1[0-9]|2[0-4])$/i.test(key);

/** Parse an accelerator; `null` for anything malformed. */
export function parseAccelerator(accelerator: string): Chord | null {
    const parts = accelerator.split('+').map((p) => p.trim());
    if (parts.length === 0 || parts.some((p) => p.length === 0)) return null;
    const key = parts[parts.length - 1]!.toLowerCase();
    if (MODIFIER_KEYS.has(key)) return null;
    const chord = { key, primary: false, ctrl: false, meta: false, alt: false, shift: false };
    for (const modifier of parts.slice(0, -1).map((m) => m.toLowerCase())) {
        switch (modifier) {
            case 'commandorcontrol':
            case 'cmdorctrl':
                chord.primary = true;
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

/** Does this press match this chord — the exact modifiers, no more? */
export function chordMatches(chord: Chord, press: KeyPress): boolean {
    if (press.key.toLowerCase() !== chord.key || press.altKey !== chord.alt || press.shiftKey !== chord.shift) return false;
    if (chord.primary) {
        // Exactly one of Ctrl / ⌘, unless the accelerator names the other as well.
        const ctrlOk = chord.ctrl ? press.ctrlKey : true;
        const metaOk = chord.meta ? press.metaKey : true;
        const extra = (chord.ctrl ? 0 : Number(press.ctrlKey)) + (chord.meta ? 0 : Number(press.metaKey));
        return ctrlOk && metaOk && extra === 1;
    }
    return press.ctrlKey === chord.ctrl && press.metaKey === chord.meta;
}

/** Same key under any platform: two accelerators that one press would match. */
export function sameChord(a: Chord, b: Chord): boolean {
    const probe = (c: Chord): KeyPress[] =>
        (c.primary ? [true, false] : [c.ctrl]).map((useCtrl) => ({
            key: c.key,
            ctrlKey: c.primary ? useCtrl || c.ctrl : c.ctrl,
            metaKey: c.primary ? !useCtrl || c.meta : c.meta,
            altKey: c.alt,
            shiftKey: c.shift,
            typing: false,
        }));
    return probe(a).some((p) => chordMatches(b, p)) || probe(b).some((p) => chordMatches(a, p));
}

export function matchesAccelerator(accelerator: string, press: KeyPress): boolean {
    const chord = parseAccelerator(accelerator);
    return chord !== null && chordMatches(chord, press);
}

/** The bindings in force, from the settings: empty → Genie's default; malformed → disabled. */
export function bindingsFrom(values: Readonly<Record<string, unknown>> | null | undefined): HotkeyBindings {
    const read = (name: BindingName): string | null => {
        const raw = values?.[BINDING_SETTING[name]];
        if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_HOTKEYS[name];
        return parseAccelerator(raw) === null ? null : raw;
    };
    return { commandWindow: read('commandWindow'), ftqNudge: read('ftqNudge') };
}

export type HotkeyAction = 'open-palette' | 'ftq-nudge';

/** What a press means under these bindings, or `null`. Chords and function keys, so they act while typing too. */
export function hotkeyAction(press: KeyPress, bindings: HotkeyBindings, _platform: string): HotkeyAction | null {
    if (bindings.commandWindow && matchesAccelerator(bindings.commandWindow, press)) return 'open-palette';
    if (bindings.ftqNudge && matchesAccelerator(bindings.ftqNudge, press)) return 'ftq-nudge';
    return null;
}

/** How an accelerator reads: `Ctrl+Alt+R` on Windows and Linux, `⌘+Alt+R` on macOS. */
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
 * Why a key cannot be one of Genie's (a prompt's, or a binding), or `null` when it can. Genie's fixed chords are asked of
 * the functions that bind them; the remappable ones of `bindings`, wherever they are mapped. `except` is the binding
 * being set, whose own current key is no clash.
 */
export function genieKeyProblem(accelerator: string, bindings: HotkeyBindings, except: BindingName | null): string | null {
    const chord = parseAccelerator(accelerator);
    if (!chord) return 'That is not a key Genie can read.';
    if (!chord.primary && !chord.ctrl && !chord.meta && !chord.alt && !isFunctionKey(chord.key)) {
        return 'That key is used for typing — hold Ctrl (⌘ on macOS) or Alt with it, or use a function key.';
    }
    for (const useCtrl of [true, false]) {
        const press: KeyPress = { key: chord.key, ctrlKey: chord.ctrl || (chord.primary && useCtrl), metaKey: chord.meta || (chord.primary && !useCtrl), altKey: chord.alt, shiftKey: chord.shift, typing: false };
        const fixed = globalAction(press);
        if (fixed === 'toggle-chat') return 'Genie uses that key to open and close the chat.';
        if (fixed === 'toggle-files') return 'Genie uses that key for the file panel.';
        if (fixed === 'open-settings') return 'Genie uses that key for Settings.';
        if (agentViewAction(press) === 'take-over') return 'Genie uses that key for Take Over.';
    }
    for (const name of ['commandWindow', 'ftqNudge'] as const) {
        if (name === except) continue;
        const bound = bindings[name];
        const theirs = bound ? parseAccelerator(bound) : null;
        if (theirs && sameChord(chord, theirs)) return `Genie uses that key for ${BINDING_LABEL[name]}.`;
    }
    return null;
}

/** Why a binding cannot take this key, or `null`. Empty is "Genie's default" and always fine. */
export function bindingProblem(
    accelerator: string,
    name: BindingName,
    bindings: HotkeyBindings,
    prompts: ReadonlyArray<{ label: string; hotkey?: string | undefined }>,
    _platform: string,
): string | null {
    if (accelerator.trim() === '') return null;
    const problem = genieKeyProblem(accelerator, bindings, name);
    if (problem !== null) return problem;
    const chord = parseAccelerator(accelerator)!;
    const prompt = prompts.find((p) => {
        const theirs = p.hotkey ? parseAccelerator(p.hotkey) : null;
        return theirs !== null && sameChord(chord, theirs);
    });
    return prompt ? `“${prompt.label}” already has that key.` : null;
}

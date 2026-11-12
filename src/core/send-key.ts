import { genieKeyProblem, hotkeyLabel, matchesAccelerator, parseAccelerator, sameChord, type HotkeyBindings } from './hotkeys.js';

/**
 * THE COMPOSER'S SEND KEY (Tynn issue #697; the owner, 2026-11-11: "I want to swap the user input send key to enter. let
 * shift+enter be the way to add a new line. In the customization settings the user should be able to set this hotkey").
 *
 * One key sends in every composer a person writes to an agent in; the new-line key follows from it. Kept per person on this
 * machine (`send_key`, a device setting; empty = Genie's default). An accelerator, as Genie's other keys are (hotkeys.ts).
 */
export const SEND_KEY_SETTING = 'send_key';
export const DEFAULT_SEND_KEY = 'Enter';

/** The key in force: empty, or anything Genie cannot read, is the default. */
export function sendKeyFrom(values: Readonly<Record<string, unknown>> | null | undefined): string {
    const raw = values?.[SEND_KEY_SETTING];
    if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_SEND_KEY;
    return parseAccelerator(raw) === null ? DEFAULT_SEND_KEY : raw;
}

/** The new line follows from the send key: Enter sends → Shift+Enter; anything else sends → Enter. */
export function newlineKeyFor(sendKey: string): string {
    const chord = parseAccelerator(sendKey);
    const bareEnter = chord !== null && chord.key === 'enter' && !chord.primary && !chord.ctrl && !chord.meta && !chord.alt && !chord.shift;
    return bareEnter ? 'Shift+Enter' : 'Enter';
}

export interface ComposerPress {
    readonly key: string;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly altKey?: boolean;
    readonly shiftKey?: boolean;
    /** An IME is composing: its Enter confirms the composition and is never the composer's. */
    readonly isComposing?: boolean;
    readonly keyCode?: number;
}

/**
 * What a key means in a composer: `send`, `newline`, or `null` (not the composer's). Enter during an IME composition
 * (`isComposing`, or keyCode 229) is the IME's; Enter with a command or mention list open picks the item.
 */
export function composerKey(press: ComposerPress, sendKey: string, state: { readonly listOpen?: boolean } = {}): 'send' | 'newline' | null {
    if (press.isComposing === true || press.keyCode === 229) return null;
    if (state.listOpen === true && press.key === 'Enter') return null;
    // A space is named, as an accelerator names it.
    const p = { key: press.key === ' ' ? 'Space' : press.key, ctrlKey: press.ctrlKey === true, metaKey: press.metaKey === true, altKey: press.altKey === true, shiftKey: press.shiftKey === true, typing: true };
    if (matchesAccelerator(sendKey, p)) return 'send';
    if (matchesAccelerator(newlineKeyFor(sendKey), p)) return 'newline';
    return null;
}

/** What the system keeps for itself, whatever Genie is doing. */
const SYSTEM_KEYS = ['Alt+F4', 'Alt+Tab', 'Alt+Escape', 'Alt+Space', 'Control+Alt+Delete', 'Control+Escape', 'Command+Q', 'Command+W', 'Command+H', 'Command+M', 'Command+Tab', 'Command+Space'];

/**
 * Why a key cannot be the send key, in words, or `null` when it can. Enter, alone or with Shift, is a key for this even
 * though it types: the new line moves to the other one. Anything else must not type or edit, and must be free.
 */
export function sendKeyProblem(accelerator: string, bindings: HotkeyBindings, prompts: ReadonlyArray<{ label: string; hotkey?: string | undefined }>, _platform: string): string | null {
    if (/^(?:.*\+)?(?:space| )$/i.test(accelerator) && !/control|command|alt/i.test(accelerator)) return 'That key is used for typing — hold Ctrl (⌘ on macOS) or Alt with it.';
    const chord = parseAccelerator(accelerator);
    if (!chord) return 'That is not a key Genie can read.';
    for (const taken of SYSTEM_KEYS) {
        const theirs = parseAccelerator(taken);
        if (theirs && sameChord(chord, theirs)) return 'Your computer’s system uses that key, so it would never reach Genie.';
    }
    if (chord.key === 'enter' && !chord.primary && !chord.ctrl && !chord.meta && !chord.alt) return null;
    const problem = genieKeyProblem(accelerator, bindings, null);
    if (problem !== null) return problem;
    const prompt = prompts.find((p) => {
        const theirs = p.hotkey ? parseAccelerator(p.hotkey) : null;
        return theirs !== null && sameChord(chord, theirs);
    });
    return prompt ? `“${prompt.label}” already has that key.` : null;
}

/** The keys of an accelerator as keycaps: `['Ctrl', 'Enter']`, `['⌘', 'Enter']` on macOS. */
export function keycaps(accelerator: string, platform: string): string[] {
    return hotkeyLabel(accelerator, platform).split('+').map((cap) => (cap === ' ' ? 'Space' : cap));
}


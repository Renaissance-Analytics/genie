/**
 * PURE. Which keypresses Genie takes for itself (Tynn stories #246, #247).
 *
 * Two features share one mechanism: F5 nudges the focused agent to re-ask through
 * ForceTheQuestion, and Ctrl+K opens the Command Window. Both must be caught
 * BEFORE the terminal sees them — fancy-term-host/xterm swallows everything it is
 * handed — and once Genie takes one, the terminal must NOT also receive it.
 *
 * The load-bearing decision here is SCOPE, not the binding. These are keys other
 * software owns: F5 reloads a browser and refreshes a file manager; Ctrl+K is
 * kill-to-end-of-line in every readline shell, which is to say inside the very
 * terminal these hotkeys live in. Claiming either too widely does not degrade
 * Genie — it breaks the tool the user is actually using.
 *
 * So the rule is deliberately narrow: a hotkey binds ONLY while a Genie TERMINAL
 * PANEL has focus. Not with Genie in the background, not with another application
 * focused, and not inside Genie's own settings, editors, modals or site manager.
 *
 * `globalShortcut` (main/shortcuts.ts, quick-capture) cannot express that — it is
 * an OS-wide grab that fires with Genie minimised. `before-input-event` is
 * window-scoped, which removes the background case, but still fires for every
 * focused surface in the window. Hence this predicate, kept pure so the renderer's
 * DOM-less test environment can assert it directly.
 */

export interface KeyChord {
    /** The event's `key` — `'F5'`, `'k'`, `'K'`. */
    key: string;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
}

export interface HotkeyBindings {
    /** Accelerator for the ForceTheQuestion nudge. Default `F5`. */
    ftqNudge: string;
    /** Accelerator for the Command Window. Default `CommandOrControl+K`. */
    commandWindow: string;
}

export type HotkeyAction = 'ftq-nudge' | 'command-window';

export interface HotkeyContext {
    /** Focus is inside a Genie TERMINAL PANEL. Nothing binds otherwise. */
    inTerminalPanel: boolean;
}

export const DEFAULT_HOTKEYS: HotkeyBindings = {
    ftqNudge: 'F5',
    commandWindow: 'CommandOrControl+K',
};

interface ParsedAccelerator {
    key: string;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
}

/**
 * Parse an Electron-style accelerator. Returns null for anything malformed, so a
 * bad value in settings disables that binding instead of throwing on every
 * keystroke — this runs on the keydown path for the whole window.
 */
function parseAccelerator(accelerator: string, platform: string): ParsedAccelerator | null {
    const parts = accelerator
        .split('+')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    if (parts.length === 0) return null;

    const key = parts[parts.length - 1]!;
    const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase());

    // A trailing `+` leaves the key slot holding a modifier name: malformed.
    if (isModifier(key.toLowerCase())) return null;

    const parsed: ParsedAccelerator = {
        key: key.toLowerCase(),
        ctrl: false,
        meta: false,
        alt: false,
        shift: false,
    };

    for (const modifier of modifiers) {
        switch (modifier) {
            case 'commandorcontrol':
            case 'cmdorctrl':
                // The whole reason this token exists: Command on macOS, Control
                // elsewhere. Ctrl+K on macOS stays with the shell.
                if (platform === 'darwin') parsed.meta = true;
                else parsed.ctrl = true;
                break;
            case 'control':
            case 'ctrl':
                parsed.ctrl = true;
                break;
            case 'command':
            case 'cmd':
            case 'meta':
            case 'super':
                parsed.meta = true;
                break;
            case 'alt':
            case 'option':
                parsed.alt = true;
                break;
            case 'shift':
                parsed.shift = true;
                break;
            default:
                // An unknown modifier must not silently widen the binding.
                return null;
        }
    }

    return parsed;
}

function isModifier(token: string): boolean {
    return [
        'commandorcontrol',
        'cmdorctrl',
        'control',
        'ctrl',
        'command',
        'cmd',
        'meta',
        'super',
        'alt',
        'option',
        'shift',
    ].includes(token);
}

/**
 * Does this keypress match the accelerator EXACTLY?
 *
 * Exact, not "at least": a binding for Ctrl+K must not swallow Ctrl+Shift+K,
 * which is its own key in plenty of tools. The key itself compares
 * case-insensitively, because a shifted letter arrives as `'K'` while bindings are
 * conventionally written lowercase.
 */
export function matchesAccelerator(chord: KeyChord, accelerator: string, platform: string): boolean {
    const parsed = parseAccelerator(accelerator, platform);
    if (!parsed || !chord.key) return false;

    return (
        chord.key.toLowerCase() === parsed.key &&
        chord.ctrl === parsed.ctrl &&
        chord.meta === parsed.meta &&
        chord.alt === parsed.alt &&
        chord.shift === parsed.shift
    );
}

/**
 * The action this keypress triggers, or null to leave it to whatever has focus.
 *
 * Null is the answer for everything outside a terminal panel — checked FIRST, so
 * no binding can ever be reached from Genie's settings, an editor or a modal.
 */
export function hotkeyActionFor(
    chord: KeyChord,
    bindings: HotkeyBindings,
    context: HotkeyContext,
    platform: string,
): HotkeyAction | null {
    if (!context.inTerminalPanel) return null;

    if (bindings.ftqNudge && matchesAccelerator(chord, bindings.ftqNudge, platform)) {
        return 'ftq-nudge';
    }
    if (bindings.commandWindow && matchesAccelerator(chord, bindings.commandWindow, platform)) {
        return 'command-window';
    }
    return null;
}

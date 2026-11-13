import { formatHotkey, parseHotkey } from '@particle-academy/react-fancy';
import { parseAccelerator } from '../core/hotkeys.js';
import { acceleratorFromPress } from '../core/prompt-library.js';

/**
 * GENIE'S KEYS IN THE KIT'S SPELLING (Tynn #637, react-fancy 6.20+). Genie stores a key as an accelerator
 * (`CommandOrControl+Enter`), as it always has; the kit's HotkeyCapture and PromptInput's `submitKey` take a normalised
 * string (`ctrl+enter`: modifiers ctrl, alt, shift, meta, then one key, lower case). These two convert at that edge only,
 * so nothing stored changes.
 */

/** An accelerator as the kit's string. CommandOrControl is ⌘ on macOS and Ctrl elsewhere. Empty or unreadable → ''. */
export function toHotkey(accelerator: string, platform: string): string {
    if (accelerator.trim() === '') return '';
    const chord = parseAccelerator(accelerator);
    if (!chord) return '';
    const apple = platform === 'darwin';
    return formatHotkey({ key: chord.key, ctrl: chord.ctrl || (chord.primary && !apple), meta: chord.meta || (chord.primary && apple), alt: chord.alt, shift: chord.shift });
}

/** The kit's named keys as a keyboard event names them (`arrowup` → `ArrowUp`); a single character stays as it is. */
const EVENT_KEY: Readonly<Record<string, string>> = { arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown' };
const eventKey = (key: string): string => EVENT_KEY[key] ?? (key.length === 1 ? key : key.charAt(0).toUpperCase() + key.slice(1));

/** A recorded combination as the accelerator Genie stores: exactly what a press of it stored before. Empty → `null`. */
export function fromHotkey(hotkey: string, platform: string): string | null {
    const combo = parseHotkey(hotkey);
    if (!combo) return null;
    return acceleratorFromPress({ key: eventKey(combo.key), ctrlKey: combo.ctrl, metaKey: combo.meta, altKey: combo.alt, shiftKey: combo.shift, typing: false }, platform);
}

/** Genie's platform word as the kit's. */
export function fancyPlatform(platform: string): 'apple' | 'generic' {
    return platform === 'darwin' ? 'apple' : 'generic';
}

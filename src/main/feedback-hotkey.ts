import { parseAccelerator } from '../core/hotkeys.js';

/**
 * THE FEEDBACK KEY (Tynn #760; Genie 1's main/shortcuts.ts): a GLOBAL key — it opens the Feedback window from anywhere on
 * the computer, Genie in the background or not, which is the point of it. Unlike Genie's in-window keys (core/hotkeys.ts)
 * it is the OS's to grant: another application may hold it, and that is said, never thrown. The setting
 * `feedback_hotkey` (Genie 1's `global_hotkey`, carried over) moves it; empty is Genie 1's default.
 */
export const DEFAULT_FEEDBACK_HOTKEY = 'CommandOrControl+Shift+W';

export type FeedbackHotkeyStatus =
    | { readonly state: 'registered'; readonly accelerator: string }
    /** Another application holds it. */
    | { readonly state: 'taken'; readonly accelerator: string }
    /** The setting holds something that is not a key. */
    | { readonly state: 'invalid'; readonly accelerator: string };

export interface FeedbackHotkeyPort {
    /** Electron's `globalShortcut.register`: `false` when the OS would not grant it. */
    register(accelerator: string, onPress: () => void): boolean;
    unregister(accelerator: string): void;
}

/** Registers the key, re-registers it when the setting changes, and answers what happened. */
export function wireFeedbackHotkey(
    settings: { get(): unknown; onChange(listener: (key: string) => void): unknown },
    port: FeedbackHotkeyPort,
    onPress: () => void,
): () => FeedbackHotkeyStatus {
    let held: string | null = null;
    let status: FeedbackHotkeyStatus = { state: 'invalid', accelerator: '' };
    const apply = (): void => {
        if (held !== null) { port.unregister(held); held = null; }
        const raw = settings.get();
        const accelerator = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_FEEDBACK_HOTKEY;
        if (parseAccelerator(accelerator) === null) { status = { state: 'invalid', accelerator }; return; }
        let granted = false;
        try { granted = port.register(accelerator, onPress); } catch { granted = false; }
        if (granted) { held = accelerator; status = { state: 'registered', accelerator }; }
        else status = { state: 'taken', accelerator };
    };
    apply();
    settings.onChange((key) => { if (key === 'feedback_hotkey') apply(); });
    return () => status;
}

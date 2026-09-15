import { globalShortcut } from 'electron';
import { getAllSettings } from './db';
import { openFeedbackWindow } from './background';

/**
 * Global hotkeys. Default is Ctrl+Shift+W / Cmd+Shift+W to open Feedback for
 * the active workspace (genie#675). User can change in Settings (Story #151).
 */

let registered: string | null = null;

export function registerShortcuts(): void {
    const accel = getAllSettings().global_hotkey ?? defaultAccel();
    try {
        if (registered) globalShortcut.unregister(registered);
        const ok = globalShortcut.register(accel, () => openFeedbackWindow());
        registered = ok ? accel : null;
    } catch (e) {
        console.warn('Could not register global hotkey', accel, e);
    }
}

export function unregisterShortcuts(): void {
    globalShortcut.unregisterAll();
    registered = null;
}

function defaultAccel(): string {
    return process.platform === 'darwin'
        ? 'CommandOrControl+Shift+W'
        : 'Control+Shift+W';
}

import { globalShortcut } from 'electron';
import { getAllSettings } from './db';
import { showCaptureWindow, hideCaptureWindow, getCaptureWindow } from './background';

/**
 * Global hotkeys. Default is Ctrl+Shift+W / Cmd+Shift+W to toggle the
 * Quick Capture window. User can change in Settings (Story #151).
 */

let registered: string | null = null;

export function registerShortcuts(): void {
    const accel = getAllSettings().global_hotkey ?? defaultAccel();
    try {
        if (registered) globalShortcut.unregister(registered);
        const ok = globalShortcut.register(accel, () => {
            const w = getCaptureWindow();
            if (w && w.isVisible()) {
                hideCaptureWindow();
            } else {
                showCaptureWindow();
            }
        });
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

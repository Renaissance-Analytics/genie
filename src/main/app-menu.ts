import type { MenuItemConstructorOptions } from 'electron';

/**
 * GENIE'S APPLICATION MENU (Tynn #759; Genie 1's main/app-menu.ts at v0.7.0-beta.342, ported) — the template only, so
 * a test holds it without Electron; main.ts builds and installs it.
 *
 * Genie 2 set none, so Electron's DEFAULT menu was in force with its accelerators: Ctrl+W is its Close, and on Genie's
 * main window a close HIDES Genie to the tray — from any field, mid-sentence. Genie 1's answer, kept: Close Window is
 * offered with NO accelerator. The rest is Genie 1's skeleton (Edit, View, Window, Help with the version), plus
 * Settings… on CmdOrCtrl+, — the platform's settings key — and Genie's own Quit and update check where the tray has them.
 *
 * The Edit roles are not decoration: on macOS the menu IS copy and paste in every field.
 */
export interface AppMenuHandlers {
    onSettings(): void;
    onCheckUpdates(): void;
    onQuit(): void;
    onCloseWindow(): void;
    onOpenRepo(): void;
    onReportIssue(): void;
}

export function appMenuTemplate(platform: string, version: string, h: AppMenuHandlers): MenuItemConstructorOptions[] {
    const mac = platform === 'darwin';
    const settings: MenuItemConstructorOptions = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => h.onSettings() };
    const updates: MenuItemConstructorOptions = { label: 'Check for updates', click: () => h.onCheckUpdates() };
    return [
        mac
            ? {
                  label: 'Genie',
                  submenu: [
                      { role: 'about' },
                      updates,
                      { type: 'separator' },
                      settings,
                      { type: 'separator' },
                      { role: 'services' },
                      { type: 'separator' },
                      { role: 'hide' },
                      { role: 'hideOthers' },
                      { role: 'unhide' },
                      { type: 'separator' },
                      // The role is ⌘Q, which macOS people expect; Genie's own quit path runs from before-quit.
                      { role: 'quit' },
                  ],
              }
            : {
                  label: 'Genie',
                  submenu: [settings, updates, { type: 'separator' }, { label: 'Quit Genie', click: () => h.onQuit() }],
              },
        { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        // No accelerator on Close Window: Ctrl/⌘+W is not Genie's to take from the page.
        { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Close Window', click: () => h.onCloseWindow() }] },
        {
            role: 'help',
            submenu: [
                { label: `Genie v${version}`, enabled: false },
                { type: 'separator' },
                { label: 'Genie on GitHub', click: () => h.onOpenRepo() },
                { label: 'Report an Issue', click: () => h.onReportIssue() },
            ],
        },
    ];
}

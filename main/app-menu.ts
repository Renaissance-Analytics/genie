import { app, BrowserWindow, Menu, shell } from 'electron';

/**
 * Build + install Genie's application menu (top-of-window menu bar
 * on Windows / Linux, app menu on macOS).
 *
 * Electron's default menu has no version surface — for an installed
 * desktop app that's the first thing a user reaches for when they
 * need to report a bug or check whether they're on the latest. We
 * keep the standard Edit/View/Window/Help skeleton and add a Help
 * menu with the version string + links to the repo + issue tracker.
 */
export function installAppMenu(): void {
    const isMac = process.platform === 'darwin';
    const version = app.getVersion();

    const template: Electron.MenuItemConstructorOptions[] = [
        ...(isMac
            ? ([{
                  label: app.name,
                  submenu: [
                      { role: 'about' },
                      { type: 'separator' },
                      { role: 'services' },
                      { type: 'separator' },
                      { role: 'hide' },
                      { role: 'hideOthers' },
                      { role: 'unhide' },
                      { type: 'separator' },
                      { role: 'quit' },
                  ],
              }] as Electron.MenuItemConstructorOptions[])
            : []),
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
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
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                // The default `{ role: 'close' }` registers CmdOrCtrl+W as a
                // native accelerator, which would close the BrowserWindow before
                // the renderer's ⌘/Ctrl+W handler (close the FOCUSED PANEL) could
                // run. We hand W to the renderer by giving this item NO accelerator
                // (plain click handler), so the menu still offers "Close Window"
                // without advertising a shortcut it doesn't truly own.
                {
                    label: 'Close Window',
                    click: () => {
                        const w =
                            BrowserWindow.getFocusedWindow() ??
                            BrowserWindow.getAllWindows()[0];
                        w?.close();
                    },
                },
            ],
        },
        {
            role: 'help',
            submenu: [
                {
                    label: `Genie v${version}`,
                    enabled: false,
                },
                { type: 'separator' },
                {
                    label: 'Genie on GitHub',
                    click: () => {
                        void shell.openExternal(
                            'https://github.com/Renaissance-Analytics/genie',
                        );
                    },
                },
                {
                    label: 'Report an Issue',
                    click: () => {
                        void shell.openExternal(
                            `https://github.com/Renaissance-Analytics/genie/issues/new?title=${
                                encodeURIComponent(`[v${version}] `)
                            }`,
                        );
                    },
                },
            ],
        },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

import { Menu, Tray, nativeImage } from 'electron';

/**
 * THE TRAY — the one place Genie is reachable when its window is hidden behind thirty others,
 * and the one place it can always be quit from. v1 had one; the owner's first run of 2.0.0-beta.5
 * had no tray and a window with no close button, so Genie could not be closed at all except by
 * Alt+F4. A 16 px brand-gradient mark, generated once (`.ai/sandbox/test-vm/make-tray-png.mjs`)
 * and embedded so the tray never depends on a file electron-builder may or may not have packed.
 */
export const TRAY_ICON_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAArElEQVR4nKXTOwrCQBRG4bvxzEwKGwlKUAmEQEQMPkCRgKRIk0IbCxs3M6/wyxVXkLuA73SHkk+k5B1JvQLUM0ANAaoP0J2Hbj30xUMfPczewdQOpnQwG4c0t5RmlqZipJnFbGlJgjHPHUiCF2sOCPCq4IAAF6UHSXBVcUCAtzUHBLjZBZAEn5oAkuDrgQMC3J4jSIK7CwcEuL9F0P+qSXhoR/otyVdNwY/7SF963xi/oZXk8wAAAABJRU5ErkJggg==';

export interface TrayHandlers {
    readonly onOpen: () => void;
    readonly onQuit: () => void;
}

/** The menu, as labels and handlers — pure enough for a test to hold the two verbs. */
export function trayMenuTemplate(handlers: TrayHandlers): { label: string; click: () => void }[] {
    return [
        { label: 'Open Genie', click: handlers.onOpen },
        { label: 'Quit Genie', click: handlers.onQuit },
    ];
}

export function createTray(handlers: TrayHandlers): Tray {
    const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'));
    const tray = new Tray(icon);
    tray.setToolTip('Genie');
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(handlers)));
    tray.on('click', handlers.onOpen);
    return tray;
}

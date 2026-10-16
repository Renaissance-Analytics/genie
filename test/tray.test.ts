import { describe, expect, it, vi } from 'vitest';

/**
 * THE TRAY: Genie is always reachable and always quittable. The owner's first run of 2.0.0-beta.5
 * had no tray and a window with no close button. `electron` is not loadable under vitest, so the
 * module is imported with `electron` mocked; the menu template and the embedded icon are what is held.
 */
vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() }, Tray: vi.fn(), nativeImage: { createFromBuffer: vi.fn() } }));

describe('tray', () => {
    it('offers exactly four verbs — open, settings, check for updates, quit — each wired to its own handler', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const onOpen = vi.fn();
        const onSettings = vi.fn();
        const onCheckUpdates = vi.fn();
        const onQuit = vi.fn();
        const menu = trayMenuTemplate({ onOpen, onSettings, onCheckUpdates, onQuit });
        expect(menu.map((m) => m.label)).toEqual(['Open Genie', 'Settings…', 'Check for updates', 'Quit Genie']);
        menu[0]!.click();
        menu[1]!.click();
        menu[2]!.click();
        menu[3]!.click();
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onSettings).toHaveBeenCalledTimes(1);
        expect(onCheckUpdates).toHaveBeenCalledTimes(1);
        expect(onQuit).toHaveBeenCalledTimes(1);
    });

    it('embeds a real 16×16 PNG for the icon, so the tray never depends on a packed file', async () => {
        const { TRAY_ICON_PNG_BASE64 } = await import('../src/main/tray.js');
        const png = Buffer.from(TRAY_ICON_PNG_BASE64, 'base64');
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        expect(png.readUInt32BE(16)).toBe(16); // width
        expect(png.readUInt32BE(20)).toBe(16); // height
        expect(png.subarray(png.length - 8).toString('latin1')).toContain('IEND');
    });
});

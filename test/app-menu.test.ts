import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate, type AppMenuHandlers } from '../src/main/app-menu.js';

/**
 * GENIE'S APPLICATION MENU (Tynn #759; Genie 1's main/app-menu.ts at v0.7.0-beta.342, ported). Genie 2 set none, so
 * Electron's DEFAULT menu was in force — and its accelerators with it: Ctrl+W is its Close, which on Genie's main window
 * hides Genie to the tray (tray residence), from any field, mid-sentence. Genie 1 kept the standard skeleton and gave
 * Close Window NO accelerator. Genie 2 adds Settings… on Ctrl+, (⌘, on macOS), the platform's settings key.
 */
const handlers = (): AppMenuHandlers => ({ onSettings: vi.fn(), onCheckUpdates: vi.fn(), onQuit: vi.fn(), onCloseWindow: vi.fn(), onOpenRepo: vi.fn(), onReportIssue: vi.fn() });

/** Every item in the tree, submenus included. */
function walk(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? walk(item.submenu) : [])]);
}

const PLATFORMS = ['win32', 'linux', 'darwin'] as const;

describe('the menu', () => {
    it.each(PLATFORMS)('%s: nothing is bound to Ctrl/⌘+W — no Close role, no W accelerator — and Close Window is still offered', (platform) => {
        const h = handlers();
        const all = walk(appMenuTemplate(platform, '2.0.0-beta.30', h));
        expect(all.filter((i) => i.role === 'close' || i.role === 'quit' && platform !== 'darwin')).toEqual([]);
        expect(all.filter((i) => typeof i.accelerator === 'string' && /\+W$/i.test(i.accelerator))).toEqual([]);
        const close = all.find((i) => i.label === 'Close Window');
        expect(close?.accelerator).toBeUndefined();
        (close?.click as () => void)();
        expect(h.onCloseWindow).toHaveBeenCalledTimes(1);
    });

    it.each(PLATFORMS)('%s: Settings… on CmdOrCtrl+, opens Settings', (platform) => {
        const h = handlers();
        const settings = walk(appMenuTemplate(platform, '2.0.0-beta.30', h)).filter((i) => i.label === 'Settings…');
        expect(settings).toHaveLength(1);
        expect(settings[0]!.accelerator).toBe('CmdOrCtrl+,');
        (settings[0]!.click as () => void)();
        expect(h.onSettings).toHaveBeenCalledTimes(1);
    });

    it.each(PLATFORMS)('%s: the Edit roles are there — on macOS they ARE copy and paste in every field', (platform) => {
        const roles = walk(appMenuTemplate(platform, '2.0.0-beta.30', handlers())).map((i) => i.role).filter(Boolean);
        expect(roles).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']));
    });

    it('macOS has its app menu (Quit there, on ⌘Q by the role); Windows and Linux quit through Genie’s own Quit', () => {
        const mac = appMenuTemplate('darwin', '2.0.0-beta.30', handlers());
        expect(mac[0]!.label).toBe('Genie');
        expect(walk(mac).some((i) => i.role === 'quit')).toBe(true);
        const h = handlers();
        const quit = walk(appMenuTemplate('win32', '2.0.0-beta.30', h)).find((i) => i.label === 'Quit Genie');
        expect(quit?.accelerator).toBeUndefined();
        (quit?.click as () => void)();
        expect(h.onQuit).toHaveBeenCalledTimes(1);
    });

    it('Help names the version, and opens the repository and a new issue titled with it', () => {
        const h = handlers();
        const all = walk(appMenuTemplate('linux', '2.0.0-beta.30', h));
        expect(all.find((i) => i.label === 'Genie v2.0.0-beta.30')?.enabled).toBe(false);
        (all.find((i) => i.label === 'Genie on GitHub')?.click as () => void)();
        (all.find((i) => i.label === 'Report an Issue')?.click as () => void)();
        expect(h.onOpenRepo).toHaveBeenCalledTimes(1);
        expect(h.onReportIssue).toHaveBeenCalledTimes(1);
    });
});

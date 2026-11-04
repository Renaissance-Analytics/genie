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
        menu[0]!.click!();
        menu[1]!.click!();
        menu[2]!.click!();
        menu[3]!.click!();
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

    /**
     * THE TRAY WHILE GENIE-HOST RUNS (P1b; the owner, 2026-11-02: "as long as any genie services are running, that tray
     * should be there so users can shut them down or restart if needed"). With a window open it offers "Just close the UI";
     * with none (tray-only), Open Genie rebuilds one. Restart and Shut down everything are always there. The tooltip says the
     * host is running and WHAT it runs.
     */
    it('with a window open: Just close the UI, Restart, Shut down everything — each wired to its own handler, Quit gone', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const onQuit = vi.fn();
        const onCloseUi = vi.fn();
        const onRestart = vi.fn();
        const onShutDown = vi.fn();
        const menu = trayMenuTemplate({ onOpen: vi.fn(), onSettings: vi.fn(), onCheckUpdates: vi.fn(), onQuit, onCloseUi, onRestart, onShutDown, uiOpen: () => true });
        expect(menu.map((m) => m.label ?? m.type)).toEqual(['Open Genie', 'Settings…', 'Check for updates', 'separator', 'Just close the UI', 'Restart', 'Shut down everything']);
        menu[4]!.click!();
        menu[5]!.click!();
        menu[6]!.click!();
        expect([onCloseUi, onRestart, onShutDown].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
        expect(onQuit).not.toHaveBeenCalled();
    });

    it('tray-only (no window): no Just close the UI — Open Genie leads, and Restart and Shut down everything stay', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const onOpen = vi.fn();
        const menu = trayMenuTemplate({ onOpen, onSettings: vi.fn(), onCheckUpdates: vi.fn(), onQuit: vi.fn(), onCloseUi: vi.fn(), onRestart: vi.fn(), onShutDown: vi.fn(), uiOpen: () => false });
        expect(menu.map((m) => m.label ?? m.type)).toEqual(['Open Genie', 'Settings…', 'Check for updates', 'separator', 'Restart', 'Shut down everything']);
        menu[0]!.click!();
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('the tooltip says the host is running and WHAT it runs; without a host it is unchanged', async () => {
        const { trayTooltip } = await import('../src/main/tray.js');
        const none = { agents: 0, terminals: 0, processes: 0, services: 0, armedFlows: 0, scheduledTasks: 0, browser: 0 };
        expect(trayTooltip([], [], [], false, 0, none)).toBe('Genie — host running');
        expect(trayTooltip([], [], [], false, 0, { ...none, agents: 1 })).toBe('Genie — host running: 1 agent');
        expect(trayTooltip([], [], [], false, 2, { ...none, agents: 3, terminals: 2, processes: 1, services: 1 })).toBe('Genie — 2 waiting on you; host running: 3 agents, 2 terminals, 1 process, 1 service');
        expect(trayTooltip([], [], [], false, 0, null)).toBe('Genie');
        expect(trayTooltip([], [], [], false, 0)).toBe('Genie');
    });
});

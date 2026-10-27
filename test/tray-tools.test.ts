import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { formatRoute, parseRoute } from '../src/core/route.js';

/**
 * GENIE 1'S TRAY, THE REST OF IT (Tynn #761). Two items Genie 1's tray carried that Genie 2's did not:
 *  - an update on offer leads the menu — "⬆ Update to vX…" — and, as in Genie 1, opens Genie, where the title bar's
 *    chip downloads and restarts it (a restart is never started from a tray click: it ends every agent's session);
 *  - "Task Manager…": every kept process across workspaces — Genie 2's Hosting → Processes, reachable by a route.
 */
vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() }, Tray: vi.fn(), nativeImage: { createFromBuffer: vi.fn() } }));

const handlers = () => ({ onOpen: vi.fn(), onSettings: vi.fn(), onCheckUpdates: vi.fn(), onQuit: vi.fn(), onUpdate: vi.fn(), onTaskManager: vi.fn() });

describe('the route to the processes', () => {
    it('genie://hosting?tab=processes opens Hosting ON Processes, and formats back to itself', () => {
        expect(parseRoute('genie://hosting?tab=processes')).toMatchObject({ surface: 'hosting', tab: 'processes' });
        expect(formatRoute(parseRoute('genie://hosting?tab=processes'))).toBe('genie://hosting?tab=processes');
        expect(formatRoute(parseRoute('genie://hosting?tab=services'))).toBe('genie://hosting?tab=services');
    });

    it('CONTROL: plain hosting is unchanged — no tab, and none written; an unknown tab is dropped', () => {
        expect(parseRoute('genie://hosting')).not.toHaveProperty('tab');
        expect(formatRoute(parseRoute('genie://hosting'))).toBe('genie://hosting');
        expect(formatRoute(parseRoute('genie://hosting?tab=nope'))).toBe('genie://hosting');
    });

    it('the Shell hands the route’s tab to the Hosting surface, which switches to it even when already open', () => {
        const shell = readFileSync('src/renderer/Shell.tsx', 'utf8');
        expect(shell).toMatch(/parsed\.surface === 'hosting' \? <HostingSurface [^>]*tab=\{parsed\.tab\}/);
        const surfaces = readFileSync('src/renderer/components/FeatureSurfaces.tsx', 'utf8');
        expect(surfaces).toMatch(/<Tabs key=\{tab \?\? 'sites'\} defaultTab=\{tab \?\? 'sites'\}/);
    });
});

describe('the tray', () => {
    it('an update on offer leads the menu and opens Genie; downloading or ready, still there; none, absent', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const h = handlers();
        const menu = trayMenuTemplate(h, [], { version: '2.0.0-beta.32' });
        expect(menu[0]!.label).toBe('⬆ Update to v2.0.0-beta.32…');
        expect(menu[1]!.type).toBe('separator');
        menu[0]!.click!();
        expect(h.onUpdate).toHaveBeenCalledTimes(1);
        // CONTROL: no update, no item
        expect(trayMenuTemplate(h, [], null).some((m) => (m.label ?? '').startsWith('⬆'))).toBe(false);
    });

    it('Task Manager… opens the processes', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const h = handlers();
        const item = trayMenuTemplate(h).find((m) => m.label === 'Task Manager…');
        item!.click!();
        expect(h.onTaskManager).toHaveBeenCalledTimes(1);
    });

    it('which update phases put the item in the tray (COUNTED: three of eight)', async () => {
        const { trayUpdate } = await import('../src/main/tray.js');
        const phases = ['idle', 'checking', 'none', 'available', 'downloading', 'downloaded', 'installing', 'error'] as const;
        const shown = phases.filter((phase) => trayUpdate({ phase, version: '2.0.0-beta.32', percent: null, error: null, checkedAt: null }) !== null);
        expect(shown).toEqual(['available', 'downloading', 'downloaded']);
        expect(trayUpdate(null)).toBeNull();
    });
});

describe('main', () => {
    const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('the update item opens Genie; Task Manager opens the processes; the tray redraws when the update changes', () => {
        expect(src).toMatch(/onUpdate: \(\) => \{ revealMainWindow\('tray: update'\); \},/);
        expect(src).toMatch(/onTaskManager: \(\) => \{ revealMainWindow\('tray: Task Manager'\); showToPerson\(\{ activation: 'user-gesture', route: 'genie:\/\/hosting\?tab=processes', reason: 'tray: Task Manager' \}\); \},/);
        expect(src).toMatch(/const update = trayUpdate\(updates\?\.state\(\) \?\? null\);/);
        expect(src).toMatch(/updates\.onChange\(\(state\) => \{\n\s*refreshTray\(\);/);
    });
});

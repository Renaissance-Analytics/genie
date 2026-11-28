import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostBrowserStart } from '../src/main/host-browser-start.js';

/*
 * THE HOST ASKS THE LAUNCHER FOR THE GENIE BROWSER (Tynn #1058 L4). "The launcher is what manages all genie executables"
 * (the owner, 2026-11-25): a host with a launcher calls `launcher.startBrowser` and starts no Electron itself. A host with
 * no launcher (a dev run; the single-app install until the bridge, L9) starts it as before.
 */
const launch = { file: 'C:\\Genie\\Genie.exe', args: ['--genie-browser'] };

describe('the host starts the Genie browser', () => {
    it('with a launcher: asks it, and spawns nothing', async () => {
        const asked: string[] = [];
        const spawned: string[] = [];
        const start = hostBrowserStart({ launcher: { reachable: () => true, call: async (m) => { asked.push(m); return { ok: true, value: { pid: 5 } }; } }, here: (l) => { spawned.push(l.file); }, log: () => {} });
        await start(launch);
        expect(asked).toEqual(['launcher.startBrowser']);
        expect(spawned).toEqual([]);
    });

    it('a launcher that refuses is said in its words, and the host still spawns nothing', async () => {
        const lines: string[] = [];
        const spawned: string[] = [];
        const start = hostBrowserStart({ launcher: { reachable: () => true, call: async () => ({ ok: false, reason: 'No browser is installed on this computer.' }) }, here: (l) => { spawned.push(l.file); }, log: (l) => lines.push(l) });
        await start(launch);
        expect(spawned).toEqual([]);
        expect(lines.join('\n')).toContain('No browser is installed on this computer.');
    });

    it('CONTROL, no launcher (a dev run, the single-app install): started here, as before', async () => {
        const asked: string[] = [];
        const spawned: string[] = [];
        const start = hostBrowserStart({ launcher: { reachable: () => false, call: async (m) => { asked.push(m); return { ok: true, value: null }; } }, here: (l) => { spawned.push(l.file); }, log: () => {} });
        await start(launch);
        expect(asked).toEqual([]);
        expect(spawned).toEqual([launch.file]);
    });
});

describe('genie-host is wired to it', () => {
    it('its BrowserService starts the browser through hostBrowserStart, on the launcher\'s wire in its own runtime folder', () => {
        const src = readFileSync(join('src', 'main', 'genie-host.ts'), 'utf8');
        expect(src).toMatch(/const startBrowserNow = hostBrowserStart\(/);
        expect(src).toContain('startBrowser: (launch) => { void startBrowserNow(launch); }, startsWithoutLaunch: () => launcherReachable(launcher) });');
        expect(src).toMatch(/launcherWire\(/);
    });
});

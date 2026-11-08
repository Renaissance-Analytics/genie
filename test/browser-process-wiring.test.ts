import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entryFor } from '../src/core/entry-mode.js';
import { linkToRunningHost } from '../src/main/engine-launch.js';
import { ENGINE_PROTOCOL } from '../src/core/engine-protocol.js';

/**
 * THE GENIE BROWSER AS ITS OWN PROCESS (the host split, P2b; decision 5: "its own process, not dependent on the workspace
 * UX"). The rules behind each wire are driven in browser-service.test.ts and browser-process-link.test.ts. Source guards,
 * comments stripped by line, so prose cannot satisfy them.
 */

const strip = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

describe('which Genie a launch is', () => {
    it('--genie-browser is the browser, and nothing else is', () => {
        expect(entryFor(['Genie.exe', '--genie-browser'])).toBe('browser');
        expect(entryFor(['electron', '.', '--genie-browser'])).toBe('browser');
        expect(entryFor(['Genie.exe'])).toBe('main');
        expect(entryFor(['Genie.exe', '--doctor'])).toBe('doctor');
    });

    it('the entry takes it, lazily, before Genie loads', () => {
        const entry = strip('src/main/entry.ts');
        expect(entry).toMatch(/=== 'browser'[\s\S]*?import\('\.\/browser-process\.js'\)/);
    });
});

describe('linkToRunningHost: adopt or nothing', () => {
    const record = (over: Record<string, unknown> = {}) => JSON.stringify({ pid: 7, endpoint: 'pipe', protocol: ENGINE_PROTOCOL, build: 'any-build', startedAt: 1, ...over });
    const transport = { send() {}, close() {} } as never;
    const ports = (host: string | null, token: string | null, over: Record<string, unknown> = {}) => ({
        runtimeDir: '/r',
        alive: () => true,
        readFile: (file: string) => (file.endsWith('host.json') ? host : token),
        connectTo: async () => transport,
        ...over,
    });

    it('a live host of this protocol, whatever its build: linked. It never asks a host of another build to go', async () => {
        const link = await linkToRunningHost(ports(record(), 'TOKEN'));
        expect(link).toMatchObject({ token: 'TOKEN', how: 'adopted' });
    });

    it.each([
        ['no record', null, 'TOKEN', {}],
        ['no token', record(), null, {}],
        ['another protocol', record({ protocol: ENGINE_PROTOCOL + 1 }), 'TOKEN', {}],
        ['a dead pid', record(), 'TOKEN', { alive: () => false }],
        ['nothing answering', record(), 'TOKEN', { connectTo: async () => { throw new Error('refused'); } }],
    ])('%s: nothing, and nothing started', async (_name, host, token, over) => {
        expect(await linkToRunningHost(ports(host as string | null, token as string | null, over))).toBeNull();
    });
});

describe('the process', () => {
    const code = () => strip('src/main/browser-process.ts');

    it('its own user data folder under Genie’s root (GENIE_HOME, P7), set before anything is ready: two processes cannot share a profile', () => {
        const src = code();
        expect(src).toMatch(/const home = genieRoot\(\);\s*app\.setPath\('userData', join\(home, 'browser', '\.process'\)\)/);
        expect(src.indexOf("app.setPath('userData'")).toBeLessThan(src.indexOf('whenReady'));
        expect(src).toMatch(/requestSingleInstanceLock\(\)/);
    });

    it('it ends with its last window, and links only to a running host', () => {
        const src = code();
        expect(src).toMatch(/app\.on\('window-all-closed'/);
        expect(src).toMatch(/linkToRunningHost\(/);
        expect(src).not.toMatch(/linkToHost\(/);
    });

    it('it says in words when the door is down', () => {
        expect(code()).toMatch(/setNotice\(/);
    });
});

describe('the window', () => {
    const main = () => strip('src/main/main.ts');

    it('opens this machine’s sites through the host, and publishes what a browser needs', () => {
        const src = main();
        expect(src).toMatch(/browserCall\('open', \[/);
        expect(src).toMatch(/browserCall\('publish', \[/);
        expect(src).toMatch(/args: \[\.\.\.\(app\.isPackaged \? \[\] : \[app\.getAppPath\(\)\]\), '--genie-browser'/);
    });

    it('it starts no process for it: the host does (genie#1397)', () => {
        const host = strip('src/main/genie-host.ts');
        // P10.1d: on plain Node (no Electron to start it with) the service has no browser and says why; the start is the host's either way.
        expect(host).toMatch(/new BrowserService\(\{ \.\.\.\(capabilities\.browser \? \{\} : \{ unavailable: NO_BROWSER_HERE \}\), startBrowser: \(launch\) => \{/);
        // Tynn #535: through the host's supervised spawn-host child while it is up (never on the host's own thread); between its lives, here.
        expect(host).toMatch(/supervisedClient\.spawnDetached\(launch\.file, launch\.args,/);
        expect(host).toMatch(/const here = \(\) => \{ spawnBrowserProcess\(launch,/);
        expect(strip('src/main/engine-launch.ts')).toMatch(/export function spawnBrowserProcess\(/);
    });

    it('the host tells the browser before it ends, so an installer finds the binary free', () => {
        const host = strip('src/main/genie-host.ts');
        expect(host).toMatch(/browserService\.quit\(\)/);
        const shutdown = host.slice(host.indexOf('async function shutdown('));
        expect(shutdown.indexOf('browserService.quit()')).toBeLessThan(shutdown.indexOf('server.close()'));
    });
});

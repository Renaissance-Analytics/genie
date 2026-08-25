import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { hostBrowserPaths, hostCaddySpawnOptions } from '../host-browser-desktop';

/**
 * Where the host-browser reconcile reads/writes on the real machine (story #238
 * P3). Only the PATH resolution is unit-tested — the fs/child_process leaves are
 * exercised by CI/real-machine. The OS hosts file is what varies here and has
 * bitten similar code: System32 on Windows, `/etc/hosts` everywhere else.
 */
describe('hostBrowserPaths', () => {
    it('resolves the Windows hosts file, and the data-dir cert/config paths', () => {
        const p = hostBrowserPaths({
            userDataDir: '/u',
            caddyBin: 'C:\\Users\\u\\AppData\\Roaming\\Genie\\runtime\\k\\caddy.exe',
            platform: 'win32',
            systemRoot: 'C:\\Windows',
        });
        expect(p.hostsFilePath.replace(/\\/g, '/')).toMatch(/System32\/drivers\/etc\/hosts$/i);
        // CA + leaf + Caddyfile live in the Genie data dir, never a system path.
        expect(p.caCertPath.startsWith(path.join('/u', 'host-gen'))).toBe(true);
        expect(p.caddyfilePath.startsWith(path.join('/u', 'host-gen'))).toBe(true);
    });

    it('resolves /etc/hosts on unix', () => {
        for (const platform of ['linux', 'darwin'] as const) {
            const p = hostBrowserPaths({ userDataDir: '/u', caddyBin: '/u/runtime/k/caddy', platform });
            expect(p.hostsFilePath).toBe('/etc/hosts');
        }
    });

    /**
     * The caddy the reconcile spawns is HANDED to it, never re-derived from
     * `process.resourcesPath`. That derivation is what put the `.gen` front door
     * inside the NSIS installer's path sweep, so every update killed it
     * (genie#265 — `resolveShippedCaddyBin`, and the sweep test beside it). A
     * second derivation here would silently reintroduce the bug for the front
     * door while the site server stayed fixed.
     */
    it('spawns the caddy it was GIVEN — it never re-derives one from the install dir', () => {
        const given = path.join('/userData', 'runtime', 'node20-caddy2.9.1', 'caddy.exe');
        const p = hostBrowserPaths({ userDataDir: '/u', caddyBin: given, platform: 'win32' });
        expect(p.caddyBin).toBe(given);
    });
});

/**
 * NO STRAY CONSOLE WINDOW ON WINDOWS (genie#183).
 *
 * Enabling `browserExposed` brought up the host Caddy on :443 and, on Windows,
 * popped a blank terminal at `…\caddy.exe` that then just sat there. Two spawns
 * feed that Caddy and NEITHER hid its window: `caddy start` (detached, so Windows
 * gives the child its OWN console) and `caddy reload`, which runs on every
 * reconcile — hence a flash each time a browser-exposed site starts or stops.
 *
 * The pattern was already solved one file over for site dev servers
 * (`host-process-run.ts`): on win32 NEVER detach — a detached console pops a
 * window — and always set `windowsHide`. This asserts the caddy spawns follow it.
 */
describe('hostCaddySpawnOptions (genie#183)', () => {
    it('hides the console and does NOT detach on win32', () => {
        // `detached: true` is what hands the child its own console window; the
        // daemon does not need it, because `caddy start` daemonises itself.
        expect(hostCaddySpawnOptions('win32')).toMatchObject({
            windowsHide: true,
            detached: false,
        });
    });

    it('still detaches on posix, where a process group is what keeps it alive', () => {
        expect(hostCaddySpawnOptions('linux')).toMatchObject({ detached: true });
        expect(hostCaddySpawnOptions('darwin')).toMatchObject({ detached: true });
    });

    it('hides the window on EVERY platform — the flag is inert off Windows', () => {
        for (const platform of ['win32', 'linux', 'darwin'] as const) {
            expect(hostCaddySpawnOptions(platform).windowsHide).toBe(true);
        }
    });
});

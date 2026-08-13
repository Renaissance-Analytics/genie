import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { hostBrowserPaths, hostCaddySpawnOptions } from '../host-browser-desktop';

/**
 * Where the host-browser reconcile reads/writes on the real machine (story #238
 * P3). Only the PATH resolution is unit-tested — the fs/child_process leaves are
 * exercised by CI/real-machine. Two things vary by OS and both have bitten similar
 * code: the caddy binary's name (`.exe` on Windows) and the OS hosts file, which
 * lives under System32 on Windows and at `/etc/hosts` everywhere else.
 */
describe('hostBrowserPaths', () => {
    it('resolves the Windows hosts file + caddy.exe, under the given roots', () => {
        const p = hostBrowserPaths({
            userDataDir: '/u',
            resourcesPath: '/r',
            platform: 'win32',
            systemRoot: 'C:\\Windows',
        });
        expect(path.basename(p.caddyBin)).toBe('caddy.exe');
        expect(p.caddyBin.replace(/\\/g, '/')).toMatch(/\/r\/runtime\/caddy\.exe$/);
        expect(p.hostsFilePath.replace(/\\/g, '/')).toMatch(/System32\/drivers\/etc\/hosts$/i);
        // CA + leaf + Caddyfile live in the Genie data dir, never a system path.
        expect(p.caCertPath.startsWith(path.join('/u', 'host-gen'))).toBe(true);
        expect(p.caddyfilePath.startsWith(path.join('/u', 'host-gen'))).toBe(true);
    });

    it('resolves /etc/hosts + a bare caddy on unix', () => {
        for (const platform of ['linux', 'darwin'] as const) {
            const p = hostBrowserPaths({ userDataDir: '/u', resourcesPath: '/r', platform });
            expect(p.hostsFilePath).toBe('/etc/hosts');
            expect(path.basename(p.caddyBin)).toBe('caddy');
        }
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

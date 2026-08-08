import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { hostBrowserPaths } from '../host-browser-desktop';

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

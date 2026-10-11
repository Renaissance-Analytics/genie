import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { caddyBinPath, caddyDownload, CADDY_VERSION } from '../src/main/caddy-runtime.js';

/**
 * THE BUNDLED CADDY RUNTIME (§6.6) — Genie serves static and php sites and the external-browser
 * front door with its OWN Caddy, shipped beside the app (the owner's v1 decision; agents never
 * write a web-server config). This pins: where the binary lives in a packaged app, that the
 * installer carries it (`extraResources`), and the exact release the build step fetches — by
 * version and sha256 per platform, so a build cannot silently pick up a different binary.
 */

describe('where the binary lives', () => {
    it('resources/runtime/caddy, with .exe on Windows; null when the file is not there (an install without it is refused, not guessed)', () => {
        expect(caddyBinPath('/opt/Genie/resources', 'linux', () => true)).toBe('/opt/Genie/resources/runtime/caddy');
        expect(caddyBinPath('C:\\Users\\me\\AppData\\Local\\Programs\\genie\\resources', 'win32', () => true)).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\genie\\resources\\runtime\\caddy.exe');
        expect(caddyBinPath('/opt/Genie/resources', 'linux', () => false)).toBeNull();
    });
});

describe('the installer carries it', () => {
    it('electron-builder.yml maps build/runtime/ into resources/runtime/', () => {
        const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
        expect(yml).toMatch(/extraResources:[\s\S]*from: build\/runtime[\s\S]*to: runtime/);
    });

    it('the CI fetch step is pinned by version and sha512 per platform, and every platform has a checksum', () => {
        expect(CADDY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        for (const platform of ['win32', 'darwin', 'linux'] as const) {
            const d = caddyDownload(platform, 'x64');
            expect(d.url).toContain(`v${CADDY_VERSION}`);
            expect(d.url).toMatch(/^https:\/\/github\.com\/caddyserver\/caddy\/releases\/download\//);
            expect(d.sha512).toMatch(/^[a-f0-9]{128}$/);
            expect(d.binaryInArchive).toBe(platform === 'win32' ? 'caddy.exe' : 'caddy');
        }
        expect(caddyDownload('darwin', 'arm64').url).toContain('mac_arm64');
    });
});

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caddyBinPath, caddyDownload, CADDY_VERSION, userCaddyCopy } from '../src/main/caddy-runtime.js';
import { isInside } from '../src/main/paths.js';

/**
 * THE BUNDLED CADDY RUNTIME (§6.6) — Genie serves static and php sites and the external-browser
 * front door with its OWN Caddy, shipped beside the app (the owner's v1 decision; agents never
 * write a web-server config). This pins: where the binary lives in a packaged app, that the
 * installer carries it (`extraResources`), the exact release the build step fetches — by
 * version and sha256 per platform, so a build cannot silently pick up a different binary — and
 * that Genie RUNS it from a per-user copy, never from the install an update replaces (S8, genie#265).
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

describe('the Caddy that RUNS is a per-user copy, refreshed only when the bundled binary changes', () => {
    let dir: string;
    let install: string;
    let base: string;
    let copies: string[];
    const countingCopy = async (from: string, to: string) => { copies.push(to); await copyFile(from, to); };
    const sha16 = (bytes: string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-caddy-copy-'));
        install = join(dir, 'Programs', 'genie', 'resources', 'runtime');
        base = join(dir, 'home', '.genie', 'runtime', 'caddy-bin');
        await mkdir(install, { recursive: true });
        await writeFile(join(install, 'caddy'), 'caddy v2.11.7 bytes');
        copies = [];
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('the first boot copies it under the data dir, in a folder named by its sha256 — and the path to RUN is that copy, outside the install', async () => {
        const r = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: countingCopy, platform: 'linux' });
        expect(r).toEqual({ path: join(base, sha16('caddy v2.11.7 bytes'), 'caddy'), copied: true, error: null });
        expect(await readFile(r.path, 'utf8')).toBe('caddy v2.11.7 bytes');
        expect(isInside(r.path, install)).toBe(false);
        expect(((await stat(r.path)).mode & 0o111) !== 0).toBe(true);
        expect(copies).toHaveLength(1);
    });

    it('the next boot with the SAME bundled binary copies NOTHING (counted) and runs the same copy', async () => {
        const first = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: countingCopy, platform: 'linux' });
        const second = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: countingCopy, platform: 'linux' });
        expect(second).toEqual({ path: first.path, copied: false, error: null });
        expect(copies).toHaveLength(1);
    });

    it('an update that changes the bundled binary → a NEW copy beside the old (never overwriting one that may run); the old folder is cleared', async () => {
        const first = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: countingCopy, platform: 'linux' });
        await writeFile(join(install, 'caddy'), 'caddy v2.12.0 bytes');
        const second = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: countingCopy, platform: 'linux' });
        expect(second.copied).toBe(true);
        expect(second.path).not.toBe(first.path);
        expect(await readFile(second.path, 'utf8')).toBe('caddy v2.12.0 bytes');
        expect(copies).toHaveLength(2);
        expect(await readdir(base)).toEqual([sha16('caddy v2.12.0 bytes')]);
    });

    it('a copy without its .complete marker (interrupted) is never run — it is copied again', async () => {
        const first = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: countingCopy, platform: 'linux' });
        await rm(join(base, sha16('caddy v2.11.7 bytes'), '.complete'));
        const again = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: countingCopy, platform: 'linux' });
        expect(again).toEqual({ path: first.path, copied: true, error: null });
        expect(copies).toHaveLength(2);
    });

    it('a copy that cannot be made runs the bundled binary, with the reason — never nothing', async () => {
        const r = await userCaddyCopy(join(install, 'caddy'), base, { copyFile: async () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); }, platform: 'linux' });
        expect(r.path).toBe(join(install, 'caddy'));
        expect(r.copied).toBe(false);
        expect(r.error).toMatch(/per-user copy could not be made: ENOSPC/);
        // A copy that does not hash to the bundled bytes is refused the same way.
        const torn = await userCaddyCopy(join(install, 'caddy'), join(dir, 'other'), { copyFile: async (_from, to) => { await writeFile(to, 'caddy v2.11'); }, platform: 'linux' });
        expect(torn.path).toBe(join(install, 'caddy'));
        expect(torn.error).toMatch(/does not match/);
        expect(existsSync(join(dir, 'other', sha16('caddy v2.11.7 bytes'), 'caddy'))).toBe(false);
    });
});

describe('main runs the per-user copy (main.ts is Electron, so its lines are read)', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    it('the bundled Caddy is copied under ~/.genie/runtime/caddy-bin — once — and composeServices is handed THAT path, not the install’s', () => {
        expect(main.match(/await userCaddyCopy\(bundledCaddy, join\(runtimeDir\(genieHome\(\)\), 'caddy-bin'\)\)/g) ?? []).toHaveLength(1);
        expect(main.match(/caddyBin: caddyCopy\?\.path \?\? null,/g) ?? []).toHaveLength(1);
        expect(main).not.toMatch(/caddyBin: caddyBinPath\(/);
    });
});

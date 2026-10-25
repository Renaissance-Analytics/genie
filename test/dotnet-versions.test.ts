import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOTNET_RECIPES, dotnetArchiveName, dotnetDownloadUrl, dotnetReleasesUrl, dotnetRid, dotnetShaFromReleases, parseListSdks } from '../src/core/dotnet-versions.js';
import { installDotnetVersion, listDotnetVersions, removeDotnetVersion, type DotnetVersionsPorts } from '../src/main/dotnet-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN .NET (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6a). Microsoft publishes every SDK as an archive per
 * OS and architecture, with its sha512, in the channel's releases.json. Measured on the Windows test VM (2026-10-25,
 * 10.0.402): the zip is FLAT (dotnet.exe at its top), `dotnet --list-sdks` names the SDK in Genie's directory, a new
 * console app builds and runs, and nothing is registered (no HKLM dotnet keys, no Program Files\dotnet). And: after a
 * build, .NET's BUILD SERVERS keep running and hold files inside the SDK — the directory could not be moved ("being
 * used by another process"). So Remove first asks THAT version's dotnet to shut its build servers down.
 */

const ROOT = join('/data', 'genie2-toolchain', 'dotnet-versions');
const V = DOTNET_RECIPES[0]!.version;
const ARCHIVE = new TextEncoder().encode('the official dotnet sdk archive');
const sha512 = (b: Uint8Array) => createHash('sha512').update(b).digest('hex');
type Os = 'win32' | 'linux' | 'darwin';
const exe = (p: Os) => (p === 'win32' ? 'dotnet.exe' : 'dotnet');

function releases(version: string, rid: string, hash: string, url = dotnetDownloadUrl(version, dotnetArchiveName(version, rid))): string {
    return JSON.stringify({ releases: [
        { 'release-version': '10.0.13', sdk: { version, files: [
            { name: `dotnet-sdk-${rid}.pkg`, rid, url: url.replace(/[.](zip|tar[.]gz)$/, '.pkg'), hash: 'a'.repeat(128) },
            { name: 'dotnet-sdk-x', rid: 'linux-musl-x64', url: url.replace(rid, 'linux-musl-x64'), hash: 'b'.repeat(128) },
            { name: `dotnet-sdk-${rid}`, rid, url, hash },
        ] } },
    ] });
}

function fakeFs(initial: string[] = []) {
    const files = new Set<string>(initial);
    const counts = { writeBytes: 0 };
    const under = (f: string, p: string) => f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}\\`);
    const fs: PhpVersionsFs = {
        exists: (p) => [...files].some((f) => under(f, p)),
        list: (d) => [...new Set([...files].filter((f) => f.startsWith(`${d}/`) || f.startsWith(`${d}\\`)).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: () => {},
        writeText: (p) => { files.add(p); },
        writeBytes: (p) => { counts.writeBytes += 1; files.add(p); },
        rename: (a, b) => { for (const f of [...files]) if (under(f, a)) { files.delete(f); files.add(b + f.slice(a.length)); } },
        removeTree: (p) => { for (const f of [...files]) if (under(f, p)) files.delete(f); },
    };
    return { fs, files, counts };
}

function ports(opts: { platform?: Os; arch?: 'x64' | 'arm64'; hash?: string; sdksSay?: string; files?: string[] } = {}) {
    const platform = opts.platform ?? 'win32';
    const arch = opts.arch ?? 'x64';
    const rid = dotnetRid(platform, arch);
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    let fetched = 0;
    const p: DotnetVersionsPorts = {
        platform, arch, root: ROOT, fs: disk.fs,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            const unpackTo = bin === 'powershell.exe' ? args.join(' ').match(/-DestinationPath '([^']+)'/)?.[1] : bin === 'tar' ? args[args.indexOf('-C') + 1] : undefined;
            if (unpackTo) { disk.files.add(join(unpackTo, exe(platform))); disk.files.add(join(unpackTo, 'sdk', V, 'dotnet.dll')); return { stdout: '', exitCode: 0 }; }
            if (bin === 'dotnet') return Promise.reject(Object.assign(new Error('spawn dotnet ENOENT'), { code: 'ENOENT' }));
            if (bin.endsWith(exe(platform)) && args[0] === '--list-sdks') {
                const dir = bin.slice(0, -exe(platform).length - 1);
                return { stdout: opts.sdksSay ?? `${V} [${join(dir, 'sdk')}]\n`, exitCode: 0 };
            }
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (): Promise<Fetched<Uint8Array>> => { fetched += 1; return { ok: true, body: ARCHIVE }; },
        fetchText: async (): Promise<Fetched<string>> => ({ ok: true, body: releases(V, rid, opts.hash ?? sha512(ARCHIVE)) }),
    };
    return { p, disk, ran, fetched: () => fetched, leftovers: () => [...disk.files].filter((f) => f.startsWith(ROOT)) };
}

describe('what Genie installs', () => {
    it("the supported SDK lines, newest first, from Microsoft's own archives", () => {
        expect(DOTNET_RECIPES.map((r) => [r.version, r.channel])).toEqual([['10.0.402', '10.0'], ['9.0.319', '9.0'], ['8.0.426', '8.0']]);
        expect(dotnetRid('win32', 'x64')).toBe('win-x64');
        expect(dotnetRid('linux', 'arm64')).toBe('linux-arm64');
        expect(dotnetRid('darwin', 'arm64')).toBe('osx-arm64');
        expect(dotnetArchiveName('10.0.402', 'win-x64')).toBe('dotnet-sdk-10.0.402-win-x64.zip');
        expect(dotnetArchiveName('10.0.402', 'linux-x64')).toBe('dotnet-sdk-10.0.402-linux-x64.tar.gz');
        expect(dotnetDownloadUrl('10.0.402', 'dotnet-sdk-10.0.402-win-x64.zip')).toBe('https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.zip');
        expect(dotnetReleasesUrl('10.0')).toBe('https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json');
    });

    it('the sha512 is read for EXACTLY that SDK, rid and url — never a decoy, never guessed', () => {
        const json = releases(V, 'win-x64', 'c'.repeat(128));
        expect(dotnetShaFromReleases(json, V, 'win-x64')).toBe('c'.repeat(128));
        expect(dotnetShaFromReleases(json, V, 'linux-x64')).toBeNull();
        expect(dotnetShaFromReleases(json, '9.0.319', 'win-x64')).toBeNull();
        expect(dotnetShaFromReleases(releases(V, 'win-x64', 'c'.repeat(128), 'https://evil.example/sdk.zip'), V, 'win-x64')).toBeNull();
        expect(dotnetShaFromReleases(releases(V, 'win-x64', 'c'.repeat(64)), V, 'win-x64')).toBeNull();
        expect(dotnetShaFromReleases('not json', V, 'win-x64')).toBeNull();
    });

    it('`dotnet --list-sdks` is read for the SDKs and where each lives', () => {
        expect(parseListSdks('10.0.402 [C:\\g\\sdk]\r\n9.0.319 [/x/sdk]\n')).toEqual([{ version: '10.0.402', path: 'C:\\g\\sdk' }, { version: '9.0.319', path: '/x/sdk' }]);
        expect(parseListSdks('')).toEqual([]);
    });
});

describe('installing one, on every OS', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
        it(`${platform}: unpacked flat into dotnet-versions/<version>, PROVEN by its own --list-sdks naming that SDK there`, async () => {
            const a = ports({ platform });
            const r = await installDotnetVersion(V, true, a.p);
            expect(r).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
            expect(a.disk.files.has(join(ROOT, V, exe(platform)))).toBe(true);
            expect(a.ran).toContain(`${join(ROOT, V, exe(platform))} --list-sdks`);
            expect(a.leftovers().filter((f) => f.includes('.staging-') || /[.](zip|tar[.]gz)$/.test(f))).toEqual([]);
        });
    }

    it('nothing without consent; an unknown version is refused by name', async () => {
        const a = ports();
        expect(await installDotnetVersion(V, false, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(await installDotnetVersion('7.0.410', true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/no installer for [.]NET SDK 7[.]0[.]410/) });
        expect(a.fetched()).toBe(0);
    });

    it("an archive whose sha512 is not Microsoft's is never written or unpacked", async () => {
        const a = ports({ hash: 'f'.repeat(128) });
        expect(await installDotnetVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha512 Microsoft publishes/) });
        expect(a.disk.counts.writeBytes).toBe(0);
    });

    it('a dotnet that does not list that SDK in ITS directory is not an install — and nothing is left', async () => {
        for (const sdksSay of [`9.0.319 [${join(ROOT, V, 'sdk')}]\n`, `${V} [C:\\Program Files\\dotnet\\sdk]\n`, '']) {
            const a = ports({ sdksSay });
            expect((await installDotnetVersion(V, true, a.p)).kind, sdksSay).toBe('not-installed');
            expect(a.leftovers(), sdksSay).toEqual([]);
        }
    });
});

describe('the list and removal', () => {
    it("lists Genie's versions (newest first) and what can be installed", async () => {
        const a = ports({ files: [join(ROOT, '8.0.426', 'dotnet.exe'), join(ROOT, V, 'dotnet.exe')] });
        const view = await listDotnetVersions(a.p);
        expect(view.managed.map((m) => m.version)).toEqual([V, '8.0.426']);
        expect(view.system).toBeNull();
        expect(view.available).toEqual(DOTNET_RECIPES.map((r) => ({ version: r.version, installed: r.version !== '9.0.319' })));
    });

    it("Remove first shuts THAT version's build servers down (they hold its files), then deletes it", async () => {
        const a = ports({ files: [join(ROOT, V, 'dotnet.exe')] });
        expect(await removeDotnetVersion('7.0.410', a.p)).toMatchObject({ kind: 'refused' });
        expect(await removeDotnetVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.ran).toContain(`${join(ROOT, V, 'dotnet.exe')} build-server shutdown`);
        expect(a.leftovers()).toEqual([]);
    });
});

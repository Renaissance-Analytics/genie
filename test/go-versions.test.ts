import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GO_DL_INDEX, GO_RECIPES, goArchiveName, goBinaryName, goDownloadUrl, goShaFromIndex, parseGoVersion } from '../src/core/go-versions.js';
import { installGoVersion, listGoVersions, removeGoVersion, type GoVersionsPorts } from '../src/main/go-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN GO (the owner, 2026-10-18: "the toolchain is not even close to being functional and should not be partial
 * to any language"; 2026-10-25 picked "rest of the toolchain"). Go has official relocatable builds on every OS, each
 * archive's sha256 published by go.dev in its own JSON index (`?mode=json&include=all`). Genie installs a version the
 * way it installs Node and PHP: the archive is checked against that published sha256 BEFORE a byte of it is written,
 * unpacked into a staging directory, moved into `<toolchain>/go-versions/<version>`, and PROVEN — `go version` names
 * the version and this platform — or nothing of it is left. Windows, macOS and Linux alike. Every effect is a fake that
 * counts.
 */

const ROOT = join('/data', 'genie2-toolchain', 'go-versions');
const V = GO_RECIPES[0]!.version;
type Os = 'win32' | 'linux' | 'darwin';
const ARCHIVE = new TextEncoder().encode('the official go archive bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function index(file: string, hash: string): string {
    return JSON.stringify([
        { version: `go${V}`, stable: true, files: [
            { filename: `go${V}.src.tar.gz`, os: '', arch: '', sha256: 'a'.repeat(64), kind: 'source' },
            { filename: file, os: 'x', arch: 'x', sha256: hash, kind: 'archive' },
            { filename: `go${V}.freebsd-amd64.tar.gz`, os: 'freebsd', arch: 'amd64', sha256: 'b'.repeat(64), kind: 'archive' },
        ] },
    ]);
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

function ports(opts: { platform?: Os; arch?: 'x64' | 'arm64'; sumsHash?: string; goSays?: string; files?: string[] } = {}) {
    const platform = opts.platform ?? 'linux';
    const arch = opts.arch ?? 'x64';
    const file = goArchiveName(V, platform, arch);
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    let fetched = 0;
    const p: GoVersionsPorts = {
        platform, arch, root: ROOT, fs: disk.fs,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            const unpackTo = bin === 'powershell.exe'
                ? args.join(' ').match(/-DestinationPath '([^']+)'/)?.[1]
                : bin === 'tar' ? args[args.indexOf('-C') + 1] : undefined;
            if (unpackTo) {
                // The archive's one top folder `go`, with bin/go(.exe) inside.
                disk.files.add(join(unpackTo, 'go', 'bin', goBinaryName(platform)));
                return { stdout: '', exitCode: 0 };
            }
            // The PATH lookup (`go`, bare) first: no go on this machine's PATH. A path ending in bin/go(.exe) is Genie's own.
            if (bin === 'go' && args[0] === 'version') return Promise.reject(new Error('not found'));
            if (bin.endsWith(goBinaryName(platform)) && args[0] === 'version') {
                const goos = platform === 'win32' ? 'windows' : platform;
                return { stdout: `${opts.goSays ?? `go version go${V} ${goos}/${arch === 'x64' ? 'amd64' : 'arm64'}`}\n`, exitCode: 0 };
            }
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (): Promise<Fetched<Uint8Array>> => { fetched += 1; return { ok: true, body: ARCHIVE }; },
        fetchText: async (): Promise<Fetched<string>> => ({ ok: true, body: index(file, opts.sumsHash ?? sha(ARCHIVE)) }),
    };
    return { p, disk, ran, fetched: () => fetched };
}

describe('what Genie installs', () => {
    it('the supported Go lines, newest first, from go.dev with the sha256 go.dev publishes', () => {
        expect(GO_RECIPES.map((r) => r.version)).toEqual(['1.27.3', '1.26.10']);
        expect(goArchiveName('1.27.3', 'win32', 'x64')).toBe('go1.27.3.windows-amd64.zip');
        expect(goArchiveName('1.27.3', 'linux', 'arm64')).toBe('go1.27.3.linux-arm64.tar.gz');
        expect(goArchiveName('1.27.3', 'darwin', 'arm64')).toBe('go1.27.3.darwin-arm64.tar.gz');
        expect(goDownloadUrl('go1.27.3.linux-amd64.tar.gz')).toBe('https://go.dev/dl/go1.27.3.linux-amd64.tar.gz');
        expect(GO_DL_INDEX).toBe('https://go.dev/dl/?mode=json&include=all');
    });

    it('the sha256 is read for EXACTLY the archive asked for; a missing one is null, never guessed', () => {
        const json = index('go1.27.3.linux-amd64.tar.gz', 'c'.repeat(64));
        expect(goShaFromIndex(json, 'go1.27.3.linux-amd64.tar.gz')).toBe('c'.repeat(64));
        expect(goShaFromIndex(json, 'go1.27.3.linux-arm64.tar.gz')).toBeNull();
        expect(goShaFromIndex('not json', 'go1.27.3.linux-amd64.tar.gz')).toBeNull();
    });

    it('`go version` is read for its version and platform', () => {
        expect(parseGoVersion('go version go1.27.3 linux/amd64\n')).toEqual({ version: '1.27.3', platform: 'linux/amd64' });
        expect(parseGoVersion('go: command not found')).toBeNull();
    });
});

describe('installing one, on every OS', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
        it(`${platform}: a good archive is unpacked, moved into go-versions/<version>, and PROVEN by \`go version\``, async () => {
            const a = ports({ platform });
            const r = await installGoVersion(V, true, a.p);
            expect(r).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
            const bin = join(ROOT, V, 'bin', goBinaryName(platform));
            expect(a.disk.files.has(bin)).toBe(true);
            expect(a.ran).toContain(`${bin} version`);
            expect(a.ran.some((c) => c.startsWith(platform === 'win32' ? 'powershell.exe' : 'tar '))).toBe(true);
            expect([...a.disk.files].some((f) => f.includes('.staging-'))).toBe(false);
        });
    }

    it('nothing without consent; an unknown version is refused by name', async () => {
        const a = ports();
        expect(await installGoVersion(V, false, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(await installGoVersion('1.20.1', true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/no installer for Go 1\.20\.1/) });
        expect(a.fetched()).toBe(0);
    });

    it('an archive whose sha256 is not the published one is never written or unpacked', async () => {
        const a = ports({ sumsHash: 'f'.repeat(64) });
        expect(await installGoVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 go\.dev publishes/) });
        expect(a.disk.counts.writeBytes).toBe(0);
        expect(a.ran.some((c) => c.startsWith('tar '))).toBe(false);
    });

    it('a go that reports another version or another platform is not an install — and nothing of it is left', async () => {
        for (const goSays of [`go version go1.26.10 linux/amd64`, `go version go${V} linux/arm64`]) {
            const a = ports({ goSays });
            const r = await installGoVersion(V, true, a.p);
            expect(r.kind, goSays).toBe('not-installed');
            expect(a.disk.files.has(join(ROOT, V, 'bin', 'go')), goSays).toBe(false);
        }
    });

    it('already there: nothing is downloaded', async () => {
        const a = ports({ files: [join(ROOT, V, 'bin', 'go')] });
        expect(await installGoVersion(V, true, a.p)).toEqual({ kind: 'already-installed', version: V });
        expect(a.fetched()).toBe(0);
    });
});

describe('the list and removal', () => {
    it('lists Genie’s versions (newest first), and what can be installed here', async () => {
        const a = ports({ files: [join(ROOT, '1.26.10', 'bin', 'go'), join(ROOT, V, 'bin', 'go'), join(ROOT, '.staging-1.27.3', 'go', 'bin', 'go')] });
        const view = await listGoVersions(a.p);
        expect(view.managed.map((m) => m.version)).toEqual([V, '1.26.10']);
        expect(view.system).toBeNull();
        expect(view.available).toEqual(GO_RECIPES.map((r) => ({ version: r.version, installed: true })));
    });

    it('removes only what Genie installed', () => {
        const a = ports({ files: [join(ROOT, V, 'bin', 'go')] });
        expect(removeGoVersion('1.19.0', a.p)).toMatchObject({ kind: 'refused' });
        expect(removeGoVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.disk.files.has(join(ROOT, V, 'bin', 'go'))).toBe(false);
    });
});

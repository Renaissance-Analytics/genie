import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PYTHON_RECIPES, PYTHON_WIN_INDEX, parsePythonProof, pythonArchiveName, pythonDownloadUrl, pythonShaFromIndex } from '../src/core/python-versions.js';
import { installPythonVersion, listPythonVersions, removePythonVersion, type PythonVersionsPorts } from '../src/main/python-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN PYTHON ON WINDOWS (plan `.ai/plans/genie-2-toolchain-rest.md`, TC4a). python.org publishes, for its own
 * Windows install manager, a FULL Python as a zip per version and architecture (`pythoncore-3.15-64` →
 * `python-3.15.1-amd64.zip`), with each zip's sha256, in `index-windows.json`. Measured on the Windows test VM
 * (2026-10-24): the zip is FLAT (python.exe at its top, no folder around it), relocatable (it runs after being moved
 * twice), carries venv, ensurepip and pip, and installs nothing in the registry. So Genie installs it exactly like Go:
 * checked against the published sha256 BEFORE a byte is written, unpacked in staging, moved into
 * `<toolchain>/python-versions/<version>`, PROVEN — that python names the version, this machine's architecture, and
 * imports ssl, venv and pip — or nothing of it is left. macOS and Linux have no official relocatable build: they come
 * from source in TC4b, and are refused by name here until then.
 */

const ROOT = join('/data', 'genie2-toolchain', 'python-versions');
const V = PYTHON_RECIPES[0]!.version;
const ARCHIVE = new TextEncoder().encode('the official python zip bytes');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const minor = (v: string) => v.split('.').slice(0, 2).join('.');

function index(version: string, arch: '64' | 'arm64', hash: string, url = pythonDownloadUrl(version, arch === '64' ? 'x64' : 'arm64')): string {
    return JSON.stringify({ versions: [
        // Decoys: another architecture, the embeddable build, the free-threaded build, an older patch of the same line.
        { id: `pythoncore-${minor(version)}-32`, 'sort-version': version, url: url.replace(/-(amd64|arm64)\.zip$/, '-win32.zip'), hash: { sha256: 'a'.repeat(64) } },
        { id: `pythonembed-${minor(version)}-${arch}`, 'sort-version': version, url: url.replace('python-', 'python-embeddable-'), hash: { sha256: 'b'.repeat(64) } },
        { id: `pythoncore-${minor(version)}t-${arch}`, 'sort-version': version, url: url.replace(`${version}-`, `${version}t-`), hash: { sha256: 'c'.repeat(64) } },
        { id: `pythoncore-${minor(version)}-${arch}`, 'sort-version': `${minor(version)}.0`, url: 'https://www.python.org/ftp/python/old.zip', hash: { sha256: 'd'.repeat(64) } },
        { id: `pythoncore-${minor(version)}-${arch}`, 'sort-version': version, url, hash: { sha256: hash } },
    ], next: 'index-windows-recent.json' });
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

function ports(opts: { platform?: 'win32' | 'linux' | 'darwin'; arch?: 'x64' | 'arm64'; indexHash?: string; indexUrl?: string; pySays?: string; pipFails?: boolean; files?: string[] } = {}) {
    const platform = opts.platform ?? 'win32';
    const arch = opts.arch ?? 'x64';
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    let fetched = 0;
    const p: PythonVersionsPorts = {
        platform, arch, root: ROOT, fs: disk.fs,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            const unpackTo = bin === 'powershell.exe' ? args.join(' ').match(/-DestinationPath '([^']+)'/)?.[1] : undefined;
            if (unpackTo) {
                // python.org's zip is FLAT: python.exe and Lib/ straight into the destination.
                disk.files.add(join(unpackTo, 'python.exe'));
                disk.files.add(join(unpackTo, 'Lib', 'venv', '__init__.py'));
                return { stdout: '', exitCode: 0 };
            }
            // The PATH python (bare) first: on a fresh Windows that is the Store alias, which says no Python.
            if (bin === 'python') return { stdout: 'Python was not found; run without arguments to install from the Microsoft Store', exitCode: 9009 };
            // pip from the BUNDLED wheel (offline): pip's own installer writes Scripts\pip.exe next to that python.
            if (bin.endsWith('python.exe') && args.includes('--force-reinstall')) {
                if (opts.pipFails) return { stdout: 'ERROR: Could not find a version that satisfies the requirement pip', exitCode: 1 };
                disk.files.add(join(bin.slice(0, -'python.exe'.length), 'Scripts', 'pip.exe'));
                return { stdout: 'Successfully installed pip-26.2.2', exitCode: 0 };
            }
            if (bin.endsWith('python.exe')) return { stdout: `${opts.pySays ?? `${V} ${arch === 'x64' ? 'AMD64' : 'ARM64'} 26.0.1`}\n`, exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (): Promise<Fetched<Uint8Array>> => { fetched += 1; return { ok: true, body: ARCHIVE }; },
        fetchText: async (): Promise<Fetched<string>> => ({ ok: true, body: index(V, arch === 'x64' ? '64' : 'arm64', opts.indexHash ?? sha(ARCHIVE), opts.indexUrl) }),
    };
    return { p, disk, ran, fetched: () => fetched };
}

describe('what Genie installs', () => {
    it("the supported lines, newest first, as python.org's install-manager zips", () => {
        expect(PYTHON_RECIPES.map((r) => r.version)).toEqual(['3.15.1', '3.14.9', '3.13.17']);
        expect(pythonArchiveName('3.15.1', 'x64')).toBe('python-3.15.1-amd64.zip');
        expect(pythonArchiveName('3.15.1', 'arm64')).toBe('python-3.15.1-arm64.zip');
        expect(pythonDownloadUrl('3.15.1', 'x64')).toBe('https://www.python.org/ftp/python/3.15.1/python-3.15.1-amd64.zip');
        expect(PYTHON_WIN_INDEX).toBe('https://www.python.org/ftp/python/index-windows.json');
    });

    it('the sha256 is read for EXACTLY that version, architecture and file — never a decoy, never guessed', () => {
        const url = pythonDownloadUrl(V, 'x64');
        const json = index(V, '64', 'e'.repeat(64));
        expect(pythonShaFromIndex(json, V, 'x64')).toBe('e'.repeat(64));
        expect(pythonShaFromIndex(json, V, 'arm64')).toBeNull();
        expect(pythonShaFromIndex(json, '3.14.9', 'x64')).toBeNull();
        // The index naming another file for this version is not trusted: the bytes Genie checks are the bytes at `url`.
        expect(pythonShaFromIndex(index(V, '64', 'e'.repeat(64), `${url}.evil`), V, 'x64')).toBeNull();
        expect(pythonShaFromIndex(index(V, '64', 'not-a-sha'), V, 'x64')).toBeNull();
        expect(pythonShaFromIndex('not json', V, 'x64')).toBeNull();
    });

    it("the proof line is read for version, machine and pip; anything else is null", () => {
        expect(parsePythonProof('3.15.1 AMD64 26.0.1\n')).toEqual({ version: '3.15.1', machine: 'AMD64', pip: '26.0.1' });
        expect(parsePythonProof('Traceback (most recent call last):')).toBeNull();
        expect(parsePythonProof('')).toBeNull();
    });
});

describe('installing one on Windows', () => {
    for (const arch of ['x64', 'arm64'] as const) {
        it(`${arch}: the flat zip is unpacked, moved into python-versions/<version>, and PROVEN by that python`, async () => {
            const a = ports({ arch });
            const r = await installPythonVersion(V, true, a.p);
            expect(r).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
            const bin = join(ROOT, V, 'python.exe');
            expect(a.disk.files.has(bin)).toBe(true);
            expect(a.disk.files.has(join(ROOT, V, 'Lib', 'venv', '__init__.py'))).toBe(true);
            // The proof runs ISOLATED (-I: no user site, no PYTHON* env) and imports what a person needs: ssl, venv, pip.
            // The proof — not the pip step, which the same python runs first (TC4a-2).
            const proof = a.ran.find((c) => c.startsWith(`${bin} `) && c.includes(' -c '));
            expect(proof).toMatch(/^\S+ -I -c /);
            expect(proof).toMatch(/import .*ssl/);
            expect(proof).toMatch(/venv/);
            expect(proof).toMatch(/pip/);
            expect([...a.disk.files].some((f) => f.includes('.staging-') || f.endsWith('.zip'))).toBe(false);
        });
    }

    it('`pip` becomes a COMMAND: after the move, that python reinstalls pip from its own bundled wheel, offline', async () => {
        const a = ports();
        expect(await installPythonVersion(V, true, a.p)).toMatchObject({ kind: 'installed' });
        const bin = join(ROOT, V, 'python.exe');
        // Run by the FINAL directory's python — pip.exe bakes in the python that made it (measured: moved, it fails).
        const pip = a.ran.find((c) => c.includes('--force-reinstall'));
        expect(pip?.startsWith(`${bin} -I -m pip install `)).toBe(true);
        expect(pip).toContain('--no-index');
        expect(pip).toContain(`--find-links ${join(ROOT, V, 'Lib', 'ensurepip', '_bundled')}`);
        expect(pip).not.toContain('.staging-');
        expect(a.disk.files.has(join(ROOT, V, 'Scripts', 'pip.exe'))).toBe(true);
    });

    it('a pip step that fails is not an install — and nothing of it is left', async () => {
        const a = ports({ pipFails: true });
        expect(await installPythonVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/pip/) });
        expect([...a.disk.files].filter((f) => f.startsWith(ROOT))).toEqual([]);
    });

    it('nothing without consent; an unknown version is refused by name', async () => {
        const a = ports();
        expect(await installPythonVersion(V, false, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(await installPythonVersion('3.9.1', true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/no installer for Python 3\.9\.1/) });
        expect(a.fetched()).toBe(0);
    });

    it('a zip whose sha256 is not the published one is never written or unpacked', async () => {
        const a = ports({ indexHash: 'f'.repeat(64) });
        expect(await installPythonVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 python\.org publishes/) });
        expect(a.disk.counts.writeBytes).toBe(0);
        expect(a.ran.some((c) => c.startsWith('powershell.exe'))).toBe(false);
    });

    it('a python that reports another version, another machine, or no pip is not an install — and nothing of it is left', async () => {
        for (const pySays of ['3.14.9 AMD64 26.0.1', `${V} ARM64 26.0.1`, `Traceback: No module named 'pip'`]) {
            const a = ports({ pySays });
            const r = await installPythonVersion(V, true, a.p);
            expect(r.kind, pySays).toBe('not-installed');
            expect([...a.disk.files].filter((f) => f.startsWith(ROOT)), pySays).toEqual([]);
        }
    });

    it('already there: nothing is downloaded', async () => {
        const a = ports({ files: [join(ROOT, V, 'python.exe')] });
        expect(await installPythonVersion(V, true, a.p)).toEqual({ kind: 'already-installed', version: V });
        expect(a.fetched()).toBe(0);
    });
});

describe('macOS and Linux (TC4b builds from source)', () => {
    for (const platform of ['linux', 'darwin'] as const) {
        it(`${platform}: install is refused by name and nothing is fetched; the list offers nothing to install`, async () => {
            const a = ports({ platform });
            expect(await installPythonVersion(V, true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/Windows/) });
            expect(a.fetched()).toBe(0);
            const view = await listPythonVersions(a.p);
            expect(view.available).toEqual([]);
            expect(view.installRefused).toMatch(/Windows/);
        });
    }
});

describe('the list and removal', () => {
    it("lists Genie's versions (newest first), and the Store alias is not taken for a Python", async () => {
        const a = ports({ files: [join(ROOT, '3.14.9', 'python.exe'), join(ROOT, V, 'python.exe'), join(ROOT, '.staging-3.13.17', 'python.exe')] });
        const view = await listPythonVersions(a.p);
        expect(view.managed.map((m) => m.version)).toEqual([V, '3.14.9']);
        expect(view.system).toBeNull();
        expect(view.available).toEqual(PYTHON_RECIPES.map((r) => ({ version: r.version, installed: r.version !== '3.13.17' })));
    });

    it('removes only what Genie installed', () => {
        const a = ports({ files: [join(ROOT, V, 'python.exe')] });
        expect(removePythonVersion('3.9.1', a.p)).toMatchObject({ kind: 'refused' });
        expect(removePythonVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.disk.files.has(join(ROOT, V, 'python.exe'))).toBe(false);
    });
});

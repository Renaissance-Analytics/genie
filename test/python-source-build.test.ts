import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PYTHON_RECIPES, pythonReleaseFilesUrl, pythonSourceName, pythonSourceShaFromApi, pythonSourceUrl } from '../src/core/python-versions.js';
import { installPythonVersion, listPythonVersions, managedPython, removePythonVersion, type PythonVersionsPorts } from '../src/main/python-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN PYTHON ON LINUX, BUILT FROM python.org's SOURCE (plan `.ai/plans/genie-2-toolchain-rest.md`, TC4b; the
 * owner's decision 2: no third-party builds). Measured on omarchy-test (2026-10-24, 3.15.1): the tarball's sha256 is the
 * one python.org's release-files API publishes; `configure && make && make install` into Genie's own prefix took ~90 s
 * on 8 CPUs; every stdlib module but tkinter built; venv and pip work; the install runs with the build tree gone. And:
 * `make install` makes `python3`/`pip3` only, and a distribution that keeps headers in -dev packages builds a Python
 * WITHOUT ssl or sqlite3 rather than failing. So Genie:
 *
 *   checks for a C compiler and make BEFORE downloading anything → downloads → checks the sha256 (nothing written
 *   before) → unpacks in staging → configures with `--prefix` = the FINAL directory (a built Python bakes it in) →
 *   make, make install → links `python` and `pip` → checks the modules a person needs, NAMING any that is missing and
 *   the package that provides it → proves it (version, machine, pip) → or deletes every byte of it.
 *
 * Every effect is a fake that counts; argv only, never a shell.
 */

const ROOT = join('/data', 'genie2-toolchain', 'python-versions');
const V = PYTHON_RECIPES[0]!.version;
const DIR = join(ROOT, V);
const TARBALL = new TextEncoder().encode('the official python source tarball');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function api(version: string, hash: string): string {
    return JSON.stringify([
        { name: 'XZ compressed source tarball', url: `https://www.python.org/ftp/python/${version}/Python-${version}.tar.xz`, sha256_sum: 'a'.repeat(64) },
        { name: 'Windows installer (64-bit)', url: `https://www.python.org/ftp/python/${version}/python-${version}-amd64.exe`, sha256_sum: 'b'.repeat(64) },
        { name: 'Gzipped source tarball', url: pythonSourceUrl(version), sha256_sum: hash },
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

function ports(opts: { arch?: 'x64' | 'arm64'; apiHash?: string; noCc?: boolean; noMake?: boolean; configureFails?: boolean; missing?: string; pySays?: string; files?: string[] } = {}) {
    const arch = opts.arch ?? 'x64';
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    const fetchedUrls: string[] = [];
    const p: PythonVersionsPorts = {
        platform: 'linux', arch, root: ROOT, fs: disk.fs, cpus: 4,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            if (bin === 'cc' && args[0] === '--version') return opts.noCc ? Promise.reject(Object.assign(new Error('spawn cc ENOENT'), { code: 'ENOENT' })) : { stdout: 'cc (GCC) 15.2.1', exitCode: 0 };
            if (bin === 'make' && args[0] === '--version') return opts.noMake ? Promise.reject(Object.assign(new Error('spawn make ENOENT'), { code: 'ENOENT' })) : { stdout: 'GNU Make 4.4.1', exitCode: 0 };
            if (bin === 'python3' && args[0] === '--version') return { stdout: 'Python 3.13.7', exitCode: 0 };
            if (bin === 'tar') {
                disk.files.add(join(args[args.indexOf('-C') + 1]!, `Python-${V}`, 'configure'));
                return { stdout: '', exitCode: 0 };
            }
            if (bin === 'env') return opts.configureFails ? { stdout: 'configure: error: no acceptable C compiler found in $PATH', exitCode: 1 } : { stdout: '', exitCode: 0 };
            if (bin === 'make' && args.includes('install')) {
                for (const f of ['bin/python3', 'bin/pip3', 'lib/python3.15/os.py']) disk.files.add(join(DIR, ...f.split('/')));
                return { stdout: '', exitCode: 0 };
            }
            if (bin === 'make') return { stdout: '', exitCode: 0 };
            if (bin === 'ln') { disk.files.add(args[args.length - 1]!); return { stdout: '', exitCode: 0 }; }
            if (bin === join(DIR, 'bin', 'python') && args.join(' ').includes('find_spec')) return { stdout: `missing:${opts.missing ? ` ${opts.missing}` : ''}\n`, exitCode: 0 };
            if (bin === join(DIR, 'bin', 'python')) return { stdout: `${opts.pySays ?? `${V} ${arch === 'x64' ? 'x86_64' : 'aarch64'} 26.2.2`}\n`, exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (u): Promise<Fetched<Uint8Array>> => { fetchedUrls.push(u); return { ok: true, body: TARBALL }; },
        fetchText: async (u): Promise<Fetched<string>> => { fetchedUrls.push(u); return { ok: true, body: api(V, opts.apiHash ?? sha(TARBALL)) }; },
    };
    const leftovers = () => [...disk.files].filter((f) => f.startsWith(ROOT));
    return { p, disk, ran, fetchedUrls, leftovers };
}

describe('what Genie builds', () => {
    it("python.org's gzipped source tarball, with the sha256 its release-files API publishes for EXACTLY that url", () => {
        expect(pythonSourceName('3.15.1')).toBe('Python-3.15.1.tgz');
        expect(pythonSourceUrl('3.15.1')).toBe('https://www.python.org/ftp/python/3.15.1/Python-3.15.1.tgz');
        expect(PYTHON_RECIPES.map((r) => [r.version, r.release])).toEqual([['3.15.1', 1165], ['3.14.9', 1166], ['3.13.17', 1167]]);
        expect(pythonReleaseFilesUrl(1165)).toBe('https://www.python.org/api/v2/downloads/release_file/?release=1165');
        expect(pythonSourceShaFromApi(api('3.15.1', 'c'.repeat(64)), '3.15.1')).toBe('c'.repeat(64));
        expect(pythonSourceShaFromApi(api('3.15.1', 'c'.repeat(64)), '3.14.9')).toBeNull();
        expect(pythonSourceShaFromApi(api('3.15.1', 'nope'), '3.15.1')).toBeNull();
        expect(pythonSourceShaFromApi('<html>', '3.15.1')).toBeNull();
    });
});

describe('building one on Linux', () => {
    for (const arch of ['x64', 'arm64'] as const) {
        it(`${arch}: checked, unpacked, configured INTO its final directory, built, linked, checked and proven`, async () => {
            const a = ports({ arch });
            expect(await installPythonVersion(V, true, a.p)).toEqual({ kind: 'installed', version: V, dir: DIR });
            const src = join(ROOT, `.staging-${V}`, `Python-${V}`);
            const steps = a.ran.filter((c) => !c.startsWith('cc ') && !c.startsWith('make --version') && !c.startsWith('python3 '));
            expect(steps[0]).toMatch(/^tar -xzf \S+Python-3[.]15[.]1[.]tgz -C \S+[.]staging-3[.]15[.]1$/);
            // argv only: `env -C` changes directory without a shell; -q keeps stdout for the errors that matter.
            expect(steps[1]).toBe(`env -C ${src} ./configure -q --prefix=${DIR} --with-ensurepip=install --disable-test-modules`);
            expect(steps[2]).toBe(`make -s -C ${src} -j4`);
            expect(steps[3]).toBe(`make -s -C ${src} install`);
            expect(steps.slice(4, 6)).toEqual([`ln -s python3 ${join(DIR, 'bin', 'python')}`, `ln -s pip3 ${join(DIR, 'bin', 'pip')}`]);
            // The modules check and the proof run the LINK, so `python` itself is proven.
            // Every regex character in the path escaped — on a Windows runner the joined path has backslashes, and an
            // unescaped `\d` in `\data` would be a digit class (unit (windows) on main, 2026-10-25).
            expect(steps[6]).toMatch(new RegExp(`^${join(DIR, 'bin', 'python').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -I -c .*find_spec`));
            expect(steps[7]).toMatch(/ -I -c import sys, platform, ssl, venv, pip/);
            expect(a.disk.files.has(join(DIR, 'bin', 'python'))).toBe(true);
            expect(a.leftovers().filter((f) => f.includes('.staging-') || f.endsWith('.tgz'))).toEqual([]);
        });
    }

    it('no C compiler or no make: refused BEFORE anything is downloaded, naming what to install', async () => {
        for (const missing of [{ noCc: true }, { noMake: true }]) {
            const a = ports(missing);
            const r = await installPythonVersion(V, true, a.p);
            expect(r).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/C compiler and make/) });
            expect(r.kind === 'refused' && r.reason).toMatch(/build-essential|base-devel|gcc make/);
            expect(a.fetchedUrls).toEqual([]);
        }
    });

    it("the sha256 comes from that recipe's release-files API; a mismatch is never written or unpacked", async () => {
        const a = ports({ apiHash: 'f'.repeat(64) });
        expect(await installPythonVersion(V, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 python[.]org publishes/) });
        expect(a.fetchedUrls).toContain(pythonReleaseFilesUrl(1165));
        expect(a.disk.counts.writeBytes).toBe(0);
        expect(a.ran.some((c) => c.startsWith('tar '))).toBe(false);
    });

    it("configure failing is not an install: its own words are said, and nothing of it is left", async () => {
        const a = ports({ configureFails: true });
        const r = await installPythonVersion(V, true, a.p);
        expect(r).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/no acceptable C compiler/) });
        expect(a.leftovers()).toEqual([]);
    });

    it('a module a person needs is missing (headers not installed): NAMED with its package, and nothing is left', async () => {
        const a = ports({ missing: 'ssl sqlite3' });
        const r = await installPythonVersion(V, true, a.p);
        expect(r.kind).toBe('not-installed');
        const reason = r.kind === 'not-installed' ? r.reason : '';
        expect(reason).toMatch(/ssl/);
        expect(reason).toMatch(/sqlite3/);
        expect(reason).toMatch(/libssl-dev/);
        expect(reason).toMatch(/libsqlite3-dev/);
        expect(a.leftovers()).toEqual([]);
    });

    it('a python that reports another version or machine is not an install', async () => {
        for (const pySays of ['3.14.9 x86_64 26.2.2', `${V} aarch64 26.2.2`]) {
            const a = ports({ pySays });
            expect((await installPythonVersion(V, true, a.p)).kind, pySays).toBe('not-installed');
            expect(a.leftovers(), pySays).toEqual([]);
        }
    });
});

describe('the list and removal on Linux', () => {
    it("Genie's built versions (bin/python3 there), the PATH python3, and every recipe offered", async () => {
        const a = ports({ files: [join(ROOT, '3.14.9', 'bin', 'python3'), join(ROOT, '.staging-3.15.1', `Python-${V}`, 'configure')] });
        expect(managedPython(a.p).map((m) => m.version)).toEqual(['3.14.9']);
        const view = await listPythonVersions(a.p);
        expect(view.system).toEqual({ version: '3.13.7' });
        expect(view.installRefused).toBeUndefined();
        expect(view.available).toEqual(PYTHON_RECIPES.map((r) => ({ version: r.version, installed: r.version === '3.14.9' })));
    });

    it('removes only what Genie built', () => {
        const a = ports({ files: [join(DIR, 'bin', 'python3')] });
        expect(removePythonVersion('3.9.1', a.p)).toMatchObject({ kind: 'refused' });
        expect(removePythonVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.leftovers()).toEqual([]);
    });
});

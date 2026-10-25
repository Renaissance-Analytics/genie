import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_LTS_DEFAULT, NODE_RECIPES, managedNodeVersions, nodeArchiveName, nodeBinaryRel, nodeDownloadSources, nodeNpmCliRel, nodeNpmGlobalDir } from '../src/core/node-versions.js';
import { installNodeVersion, listNodeVersions, removeNodeVersion, type NodeVersionsPorts } from '../src/main/node-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN NODE ON EVERY OS (the owner, 2026-10-23: "we better not be using herds node. genie has its own install
 * path"; 2026-10-25: "rest of the toolchain" — plan `.ai/plans/genie-2-toolchain-rest.md`, row TC2b). Windows had it
 * (#1149); macOS and Linux now get the same: the official nodejs.org archive (`.zip` on Windows, `.tar.gz` elsewhere),
 * checked against the SHASUMS256.txt nodejs.org publishes BEFORE a byte of it is written, unpacked through the shared
 * archive installer into `<toolchain>/node-versions/<version>`, and proven — `node -v` names the version asked for and
 * its OWN npm runs — or nothing of it is left. The archive's layout differs by OS (Windows: node.exe and node_modules
 * at the top; elsewhere bin/node and lib/node_modules), and the proof reads each from where it really is.
 */

const ROOT = join('/data', 'genie2-toolchain', 'node-versions');
const V = NODE_LTS_DEFAULT;
type Os = 'win32' | 'linux' | 'darwin';
const ARCHIVE = new TextEncoder().encode(`the official node v${V} archive bytes`);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sums = (file: string, hash: string) => [`${'a'.repeat(64)}  node-v${V}-x64.msi`, `${hash}  ${file}`, `${'b'.repeat(64)}  node-v${V}-aix-ppc64.tar.gz`].join('\n');

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

function ports(opts: { platform?: Os; sumsHash?: string; nodeSays?: string; npmSays?: string; systemNode?: string; files?: string[] } = {}) {
    const platform = opts.platform ?? 'win32';
    const file = nodeArchiveName(V, platform, 'x64');
    const top = file.replace(/\.(zip|tar\.gz)$/, '');
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    let fetched = 0;
    const node = nodeBinaryRel(platform);
    const p: NodeVersionsPorts = {
        platform, arch: 'x64', root: ROOT, fs: disk.fs,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            const unpackTo = bin === 'powershell.exe' ? args.join(' ').match(/-DestinationPath '([^']+)'/)?.[1] : bin === 'tar' ? args[args.indexOf('-C') + 1] : undefined;
            if (unpackTo) {
                // The archive's one top folder, laid out the way that OS's build really is.
                disk.files.add(join(unpackTo, top, node));
                disk.files.add(join(unpackTo, top, nodeNpmCliRel(platform)));
                return { stdout: '', exitCode: 0 };
            }
            if (bin === 'node' && args[0] === '-v') return opts.systemNode ? { stdout: `${opts.systemNode}\n`, exitCode: 0 } : Promise.reject(new Error('not found'));
            if (bin.endsWith(node) && args[0] === '-v') return { stdout: `${opts.nodeSays ?? `v${V}`}\n`, exitCode: 0 };
            if (bin.endsWith(node) && args.some((a) => a.endsWith('npm-cli.js'))) return { stdout: `${opts.npmSays ?? '11.19.1'}\n`, exitCode: opts.npmSays === 'crash' ? 1 : 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (): Promise<Fetched<Uint8Array>> => { fetched += 1; return { ok: true, body: ARCHIVE }; },
        fetchText: async (): Promise<Fetched<string>> => ({ ok: true, body: sums(file, opts.sumsHash ?? sha(ARCHIVE)) }),
    };
    return { p, disk, ran, fetched: () => fetched };
}

describe('what Genie installs', () => {
    it('the default is the current Node 24 LTS, from nodejs.org, checked against its SHASUMS256.txt — per OS', () => {
        expect(NODE_LTS_DEFAULT).toBe('24.22.1');
        expect(NODE_RECIPES.map((r) => r.version)).toContain(NODE_LTS_DEFAULT);
        expect(nodeArchiveName('24.22.1', 'win32', 'x64')).toBe('node-v24.22.1-win-x64.zip');
        expect(nodeArchiveName('24.22.1', 'linux', 'x64')).toBe('node-v24.22.1-linux-x64.tar.gz');
        expect(nodeArchiveName('24.22.1', 'darwin', 'arm64')).toBe('node-v24.22.1-darwin-arm64.tar.gz');
        expect(nodeDownloadSources('24.22.1', 'linux', 'x64')).toEqual({ zipUrl: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz', sumsUrl: 'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt' });
        expect(nodeBinaryRel('win32')).toBe('node.exe');
        expect(nodeBinaryRel('linux')).toBe(join('bin', 'node'));
        expect(nodeNpmCliRel('darwin')).toBe(join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        expect(nodeNpmGlobalDir(ROOT)).toBe(join(ROOT, 'npm-global'));
    });

    it('a managed version is a full version folder with its node in it — nothing else (a staging dir, a note)', () => {
        const entries = ['24.22.1', '.staging-24.22.1', 'npm-global', '22.23.2', 'notes'];
        const withNode = new Set(['24.22.1', '.staging-24.22.1', '22.23.2']);
        expect(managedNodeVersions(entries, (v) => withNode.has(v), (v) => join(ROOT, v)).map((m) => m.version)).toEqual(['24.22.1', '22.23.2']);
    });
});

describe('installing one, on every OS', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
        it(`${platform}: a good archive is unpacked, moved into node-versions/<version>, and PROVEN: node -v names it and its own npm runs`, async () => {
            const a = ports({ platform });
            const r = await installNodeVersion(V, true, a.p);
            expect(r).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
            const node = join(ROOT, V, nodeBinaryRel(platform));
            expect(a.disk.files.has(node)).toBe(true);
            expect(a.ran).toContain(`${node} -v`);
            expect(a.ran.some((c) => c.startsWith(node) && c.includes(join(ROOT, V, nodeNpmCliRel(platform))))).toBe(true);
            expect(a.ran.some((c) => c.startsWith(platform === 'win32' ? 'powershell.exe' : 'tar '))).toBe(true);
            expect([...a.disk.files].some((f) => f.includes('.staging-'))).toBe(false);
        });
    }

    it('nothing without consent, said in words; nothing is downloaded', async () => {
        const a = ports();
        expect(await installNodeVersion(V, false, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(a.fetched()).toBe(0);
    });

    it('an archive whose sha256 is not the published one is never written or unpacked', async () => {
        const a = ports({ platform: 'linux', sumsHash: 'f'.repeat(64) });
        const r = await installNodeVersion(V, true, a.p);
        expect(r).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 nodejs\.org publishes/) });
        expect(a.disk.counts.writeBytes).toBe(0);
        expect(a.ran.some((c) => c.startsWith('tar '))).toBe(false);
    });

    it('a node that reports another version, or whose own npm does not run, is not an install — and nothing of it is left', async () => {
        for (const platform of ['win32', 'linux'] as const) {
            for (const bad of [{ nodeSays: 'v24.19.0' }, { npmSays: 'crash' }]) {
                const a = ports({ platform, ...bad });
                const r = await installNodeVersion(V, true, a.p);
                expect(r.kind, `${platform} ${JSON.stringify(bad)}`).toBe('not-installed');
                expect(a.disk.files.has(join(ROOT, V, nodeBinaryRel(platform))), `${platform} ${JSON.stringify(bad)}`).toBe(false);
            }
        }
    });

    it('already there: nothing is downloaded', async () => {
        const a = ports({ platform: 'linux', files: [join(ROOT, V, nodeBinaryRel('linux'))] });
        expect(await installNodeVersion(V, true, a.p)).toEqual({ kind: 'already-installed', version: V });
        expect(a.fetched()).toBe(0);
    });
});

describe('the list and removal', () => {
    it('lists Genie’s versions, the node on PATH, and what can be installed — on Linux too', async () => {
        const a = ports({ platform: 'linux', files: [join(ROOT, V, nodeBinaryRel('linux'))], systemNode: 'v24.19.0' });
        const view = await listNodeVersions(a.p);
        expect(view.managed.map((m) => m.version)).toEqual([V]);
        expect(view.system).toEqual({ version: '24.19.0' });
        expect(view.available).toEqual(NODE_RECIPES.map((r) => ({ version: r.version, installed: r.version === V })));
        expect(view.installRefused).toBeUndefined();
    });

    it('removes only what Genie installed', () => {
        const a = ports({ platform: 'darwin', files: [join(ROOT, V, nodeBinaryRel('darwin'))] });
        expect(removeNodeVersion('22.0.0', a.p)).toMatchObject({ kind: 'refused' });
        expect(removeNodeVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.disk.files.has(join(ROOT, V, nodeBinaryRel('darwin')))).toBe(false);
    });
});

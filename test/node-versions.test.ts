import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_LTS_DEFAULT, NODE_RECIPES, managedNodeVersions, nodeDownloadSources, nodeNpmGlobalDir, nodeZipName } from '../src/core/node-versions.js';
import { installNodeVersion, listNodeVersions, removeNodeVersion, type NodeVersionsPorts } from '../src/main/node-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN NODE (the owner, 2026-10-23: "we better not be using herds node. genie has its own install path" and
 * "build both, Node 24 LTS default"). Genie 1 kept its Node in its own toolchain folder; Genie 2 only installed Node
 * machine-wide through winget — into `C:\Program Files\nodejs`, which on the owner's machine was Herd's link to a folder
 * holding a v24 node.exe with a broken npm. Genie 2 now manages Node the way it manages PHP: the official nodejs.org zip,
 * checked against the SHASUMS256.txt nodejs.org publishes BEFORE a byte of it is written, unpacked into
 * `<toolchain>/node-versions/<version>`, and proven — `node -v` names the version asked for and its OWN npm runs — or
 * nothing of it is left. Every effect is a fake that counts.
 */

const ROOT = join('/data', 'genie2-toolchain', 'node-versions');
const V = NODE_LTS_DEFAULT;
const FILE = nodeZipName(V);
const ZIP = new TextEncoder().encode(`the official node v${V} win-x64 zip bytes`);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sums = (hash: string) => [`${'a'.repeat(64)}  node-v${V}-x64.msi`, `${hash}  ${FILE}`, `${'b'.repeat(64)}  node-v${V}-linux-x64.tar.xz`].join('\n');

function fakeFs(initial: string[] = []) {
    const files = new Set<string>(initial);
    const counts = { writeBytes: 0, rename: 0, removeTree: 0 };
    const fs: PhpVersionsFs = {
        exists: (p) => files.has(p) || [...files].some((f) => f.startsWith(`${p}/`) || f.startsWith(`${p}\\`)),
        list: (d) => [...new Set([...files].filter((f) => f.startsWith(`${d}/`) || f.startsWith(`${d}\\`)).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: () => {},
        writeText: (p) => { files.add(p); },
        writeBytes: (p) => { counts.writeBytes += 1; files.add(p); },
        rename: (a, b) => { counts.rename += 1; for (const f of [...files]) if (f === a || f.startsWith(`${a}/`) || f.startsWith(`${a}\\`)) { files.delete(f); files.add(b + f.slice(a.length)); } },
        removeTree: (p) => { counts.removeTree += 1; for (const f of [...files]) if (f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}\\`)) files.delete(f); },
    };
    return { fs, files, counts };
}

function ports(opts: { sumsHash?: string; nodeSays?: string; npmSays?: string; systemNode?: string; files?: string[]; platform?: 'win32' | 'linux' } = {}) {
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    let fetched = 0;
    const p: NodeVersionsPorts = {
        platform: opts.platform ?? 'win32', root: ROOT, fs: disk.fs,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            if (bin === 'powershell.exe') {
                // Expand-Archive: the zip's one top folder, holding node.exe and its own npm.
                const staging = args.join(' ').match(/-DestinationPath '([^']+)'/)![1]!;
                disk.files.add(join(staging, `node-v${V}-win-x64`, 'node.exe'));
                disk.files.add(join(staging, `node-v${V}-win-x64`, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
                return { stdout: '', exitCode: 0 };
            }
            if (bin.endsWith('node.exe') && args[0] === '-v') return { stdout: `${opts.nodeSays ?? `v${V}`}\n`, exitCode: 0 };
            if (bin.endsWith('node.exe') && args.some((a) => a.endsWith('npm-cli.js'))) return { stdout: `${opts.npmSays ?? '11.19.1'}\n`, exitCode: opts.npmSays === 'crash' ? 1 : 0 };
            if (bin === 'node' && args[0] === '-v') return opts.systemNode ? { stdout: `${opts.systemNode}\n`, exitCode: 0 } : Promise.reject(new Error('not found'));
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (): Promise<Fetched<Uint8Array>> => { fetched += 1; return { ok: true, body: ZIP }; },
        fetchText: async (): Promise<Fetched<string>> => ({ ok: true, body: sums(opts.sumsHash ?? sha(ZIP)) }),
    };
    return { p, disk, ran, fetched: () => fetched };
}

describe('what Genie installs', () => {
    it('the default is the current Node 24 LTS, from nodejs.org, checked against its SHASUMS256.txt', () => {
        expect(NODE_LTS_DEFAULT).toBe('24.22.1');
        expect(NODE_RECIPES.map((r) => r.version)).toContain(NODE_LTS_DEFAULT);
        expect(nodeZipName('24.22.1')).toBe('node-v24.22.1-win-x64.zip');
        expect(nodeDownloadSources('24.22.1')).toEqual({ zipUrl: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip', sumsUrl: 'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt' });
        expect(nodeNpmGlobalDir(ROOT)).toBe(join(ROOT, 'npm-global'));
    });

    it('a managed version is a full version folder with a node.exe in it — nothing else (a staging dir, a note)', () => {
        const entries = ['24.22.1', '.staging-24.22.1', 'npm-global', '22.23.2', 'notes'];
        const withNode = new Set(['24.22.1', '.staging-24.22.1', '22.23.2']);
        expect(managedNodeVersions(entries, (v) => withNode.has(v), (v) => join(ROOT, v)).map((m) => m.version)).toEqual(['24.22.1', '22.23.2']);
    });
});

describe('installing one', () => {
    it('nothing without consent; nothing on a platform Genie installs none for — each said in words', async () => {
        const a = ports();
        expect(await installNodeVersion(V, false, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(await installNodeVersion(V, true, ports({ platform: 'linux' }).p)).toMatchObject({ kind: 'refused' });
        expect(a.fetched()).toBe(0);
    });

    it('a zip whose sha256 is not the published one is never written or unpacked', async () => {
        const a = ports({ sumsHash: 'f'.repeat(64) });
        const r = await installNodeVersion(V, true, a.p);
        expect(r).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 nodejs\.org publishes/) });
        expect(a.disk.counts.writeBytes).toBe(0);
        expect(a.ran.some((c) => c.startsWith('powershell.exe'))).toBe(false);
    });

    it('a good zip is unpacked, moved into node-versions/<version>, and PROVEN: node -v names it and its own npm runs', async () => {
        const a = ports();
        const r = await installNodeVersion(V, true, a.p);
        expect(r).toEqual({ kind: 'installed', version: V, dir: join(ROOT, V) });
        expect(a.disk.files.has(join(ROOT, V, 'node.exe'))).toBe(true);
        expect(a.ran).toContain(`${join(ROOT, V, 'node.exe')} -v`);
        expect(a.ran.some((c) => c.startsWith(join(ROOT, V, 'node.exe')) && c.includes('npm-cli.js'))).toBe(true);
        // Nothing of the staging is left.
        expect([...a.disk.files].some((f) => f.includes('.staging-'))).toBe(false);
    });

    it('a node that reports another version, or whose own npm does not run, is not an install — and nothing of it is left', async () => {
        for (const bad of [{ nodeSays: 'v24.19.0' }, { npmSays: 'crash' }]) {
            const a = ports(bad);
            const r = await installNodeVersion(V, true, a.p);
            expect(r.kind, JSON.stringify(bad)).toBe('not-installed');
            expect(a.disk.files.has(join(ROOT, V, 'node.exe')), JSON.stringify(bad)).toBe(false);
        }
    });

    it('already there: nothing is downloaded', async () => {
        const a = ports({ files: [join(ROOT, V, 'node.exe')] });
        expect(await installNodeVersion(V, true, a.p)).toEqual({ kind: 'already-installed', version: V });
        expect(a.fetched()).toBe(0);
    });
});

describe('the list and removal', () => {
    it('lists Genie’s versions, the node on PATH, and what can be installed', async () => {
        const a = ports({ files: [join(ROOT, V, 'node.exe')], systemNode: 'v24.19.0' });
        const view = await listNodeVersions(a.p);
        expect(view.managed.map((m) => m.version)).toEqual([V]);
        expect(view.system).toEqual({ version: '24.19.0' });
        expect(view.available).toEqual(NODE_RECIPES.map((r) => ({ version: r.version, installed: r.version === V })));
    });

    it('removes only what Genie installed', () => {
        const a = ports({ files: [join(ROOT, V, 'node.exe')] });
        expect(removeNodeVersion('22.0.0', a.p)).toMatchObject({ kind: 'refused' });
        expect(removeNodeVersion(V, a.p)).toEqual({ kind: 'removed', version: V });
        expect(a.disk.files.has(join(ROOT, V, 'node.exe'))).toBe(false);
    });
});

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NODE_RECIPES, managedNodeVersions, nodeDownloadSources, nodeZipName, parseNodeVersion, type ManagedNode } from '../core/node-versions.js';
import { parseSha256Sums, type PhpPlatform } from '../core/php-versions.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN NODE — list, install, remove — with every effect INJECTED, the same ports as the PHP manager
 * (main/php-versions.ts). A zip whose sha256 is not the one nodejs.org publishes is never written or unpacked; an install
 * is judged by `node -v` naming the version asked for AND its own bundled npm running (the owner's machine had a node
 * whose npm crashed on load — a node that answers is not enough); and a failure leaves nothing behind, because a folder
 * with a node.exe in it would be listed as an install.
 */

export interface NodeVersionsPorts {
    readonly platform: PhpPlatform;
    /** `<toolchain data>/node-versions` — one directory per version, and `npm-global`. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly progress?: (step: string | null) => void;
}

export interface NodeVersionsView {
    /** Genie's own, newest first. */
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string }>;
    /** The node on PATH, or `null` when none answers. */
    readonly system: { readonly version: string } | null;
    /** What this release can install, and whether each is here already. Empty where Genie installs none. */
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
    readonly installRefused?: string;
}

export type NodeInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type NodeRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

const NOT_HERE = 'Genie installs its own Node on Windows for now; on macOS and Linux it uses the Node on your PATH';

/** Where the managed versions live, under Genie 2's toolchain directory. */
export function nodeVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'node-versions');
}

/** The versions Genie manages here — directories whose node.exe is there. */
export function managedNode(ports: Pick<NodeVersionsPorts, 'root' | 'fs'>): ManagedNode[] {
    return managedNodeVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(join(ports.root, v, 'node.exe')), (v) => join(ports.root, v));
}

/** What the Toolchain surface lists: Genie's own versions, the PATH node, and what can be added. */
export async function listNodeVersions(ports: NodeVersionsPorts): Promise<NodeVersionsView> {
    const managed = managedNode(ports);
    let system: NodeVersionsView['system'] = null;
    try {
        const version = parseNodeVersion((await ports.run('node', ['-v'])).stdout);
        if (version) system = { version };
    } catch {
        // no node on PATH
    }
    const have = new Set(managed.map((m) => m.version));
    return {
        managed,
        system,
        available: ports.platform === 'win32' ? NODE_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) : [],
        ...(ports.platform === 'win32' ? {} : { installRefused: NOT_HERE }),
    };
}

/** A PowerShell single-quoted literal: `'` doubled. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * INSTALL ONE VERSION — only on the person's click. Download → check against the PUBLISHED sha256 (nothing touches disk
 * before that) → unpack into a staging directory → move the zip's one top folder into place → prove it. Any failure
 * after the unpack deletes what was written.
 */
export async function installNodeVersion(version: string, consent: boolean, ports: NodeVersionsPorts): Promise<NodeInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Node ${version} was not installed` };
    if (ports.platform !== 'win32') return { kind: 'refused', reason: NOT_HERE };
    if (!NODE_RECIPES.some((r) => r.version === version)) return { kind: 'refused', reason: `Genie has no installer for Node ${version}; this release installs ${NODE_RECIPES.map((r) => r.version).join(', ')}` };
    const dir = join(ports.root, version);
    if (ports.fs.exists(join(dir, 'node.exe'))) return { kind: 'already-installed', version };
    const file = nodeZipName(version);
    const { zipUrl, sumsUrl } = nodeDownloadSources(version);
    const say = (step: string) => ports.progress?.(step);
    try {
        say(`Node ${version}: downloading ${file} from nodejs.org`);
        const got = await ports.fetchBytes(zipUrl);
        if (!got.ok) return { kind: 'not-installed', reason: `${file} could not be downloaded from ${zipUrl} (${got.error}). Nothing was installed` };

        // THE CHECKSUM, before a byte is written.
        say(`Node ${version}: checking ${file} against the sha256 nodejs.org publishes`);
        const sums = await ports.fetchText(sumsUrl);
        if (!sums.ok) return { kind: 'not-installed', reason: `the published checksums (${sumsUrl}) could not be read (${sums.error}), so ${file} was not trusted. Nothing was installed` };
        const expected = parseSha256Sums(sums.body).get(file);
        if (!expected) return { kind: 'not-installed', reason: `${sumsUrl} lists no sha256 for ${file}, so it was not trusted. Nothing was installed` };
        const actual = createHash('sha256').update(got.body).digest('hex');
        if (actual !== expected) return { kind: 'not-installed', reason: `${file} does not match the sha256 nodejs.org publishes (expected ${expected}, got ${actual}); it was discarded unopened. Nothing was installed` };

        return await putInPlace({ version, file, dir, zip: got.body, ports, say });
    } finally {
        ports.progress?.(null);
    }
}

/** The unpack-and-prove half of {@link installNodeVersion}, reached only with a zip whose sha256 matched. */
async function putInPlace(a: { version: string; file: string; dir: string; zip: Uint8Array; ports: NodeVersionsPorts; say: (step: string) => void }): Promise<NodeInstallOutcome> {
    const { version, file, dir, zip, ports, say } = a;
    const staging = join(ports.root, `.staging-${version}`);
    const zipPath = join(ports.root, `.${file}`);
    const clean = () => {
        for (const p of [staging, zipPath, dir]) {
            try { if (ports.fs.exists(p)) ports.fs.removeTree(p); } catch { /* the reason below is what matters */ }
        }
    };
    const fail = (reason: string): NodeInstallOutcome => { clean(); return { kind: 'not-installed', reason: `${reason}. Nothing was installed` }; };
    try {
        if (ports.fs.exists(staging)) ports.fs.removeTree(staging);
        ports.fs.mkdirp(staging);
        ports.fs.writeBytes(zipPath, zip);
        say(`Node ${version}: unpacking`);
        let unpacked: { stdout: string; exitCode: number };
        try {
            unpacked = await ports.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(staging)} -Force`]);
        } catch (error) {
            return fail(`${file} could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (unpacked.exitCode !== 0) return fail(`${file} could not be unpacked (exit ${unpacked.exitCode})${unpacked.stdout.trim() ? `: ${unpacked.stdout.trim().slice(0, 300)}` : ''}`);
        // The zip holds one top folder, `node-v<version>-win-x64`, with node.exe and its own npm inside.
        const top = join(staging, `node-v${version}-win-x64`);
        if (!ports.fs.exists(join(top, 'node.exe'))) return fail(`${file} unpacked, but node.exe is not in it — the zip did not lay out the way Genie expected`);
        ports.fs.removeTree(zipPath);
        ports.fs.rename(top, dir);
        ports.fs.removeTree(staging);

        say(`Node ${version}: checking that it runs`);
        const node = join(dir, 'node.exe');
        let said = '';
        try {
            said = (await ports.run(node, ['-v'])).stdout.trim();
        } catch (error) {
            return fail(`Node ${version} unpacked, but ${node} did not run: ${error instanceof Error ? error.message : String(error)}`);
        }
        const reported = parseNodeVersion(said);
        if (reported !== version) return fail(`Node ${version} was asked for, but ${node} reports ${said.slice(0, 100) || 'nothing'}`);
        // ITS OWN npm, run by its own node — the half the owner's broken install failed.
        let npm: { stdout: string; exitCode: number };
        try {
            npm = await ports.run(node, [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '-v']);
        } catch (error) {
            return fail(`Node ${version} runs, but its npm did not: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (npm.exitCode !== 0) return fail(`Node ${version} runs, but its npm did not (exit ${npm.exitCode})${npm.stdout.trim() ? `: ${npm.stdout.trim().slice(0, 300)}` : ''}`);
        return { kind: 'installed', version, dir };
    } catch (error) {
        return fail(`Node ${version} could not be put in place: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** REMOVE a managed version — refused for anything Genie did not install. */
export function removeNodeVersion(version: string, ports: Pick<NodeVersionsPorts, 'root' | 'fs'>): NodeRemoveOutcome {
    const target = managedNode(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Node ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Node ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(join(target.dir, 'node.exe'))) return { kind: 'refused', reason: `Node ${version} is still there after the delete (a running node holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}

import { join } from 'node:path';
import { NODE_RECIPES, managedNodeVersions, nodeArchiveName, nodeBinaryRel, nodeDownloadSources, nodeNpmCliRel, nodeTopFolder, parseNodeVersion, type ManagedNode, type NodeArch, type NodePlatform } from '../core/node-versions.js';
import { parseSha256Sums } from '../core/php-versions.js';
import { installArchive } from './archive-install.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN NODE — list, install, remove — on every OS (Windows since #1149; macOS and Linux with plan
 * `.ai/plans/genie-2-toolchain-rest.md` row TC2b), through the shared archive installer (main/archive-install.ts). A zip
 * or tarball whose sha256 is not the one nodejs.org publishes is never written or unpacked; an install is judged by
 * `node -v` naming the version asked for AND its own bundled npm running (the owner's machine had a node whose npm
 * crashed on load — a node that answers is not enough); and a failure leaves nothing behind.
 */

export interface NodeVersionsPorts {
    readonly platform: NodePlatform;
    /** The machine's architecture (`process.arch`): which nodejs.org build. */
    readonly arch?: NodeArch;
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
    /** What this release can install, and whether each is here already. */
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
    /** Why nothing can be installed here, when that is so (no longer the case on any supported OS). */
    readonly installRefused?: string;
}

export type NodeInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type NodeRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

/** Where the managed versions live, under Genie 2's toolchain directory. */
export function nodeVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'node-versions');
}

/** The versions Genie manages here — directories whose node (where this OS's build keeps it) is there. */
export function managedNode(ports: Pick<NodeVersionsPorts, 'platform' | 'root' | 'fs'>): ManagedNode[] {
    return managedNodeVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(join(ports.root, v, nodeBinaryRel(ports.platform))), (v) => join(ports.root, v));
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
    return { managed, system, available: NODE_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) };
}

/**
 * INSTALL ONE VERSION — only on the person's click. Download → check against the PUBLISHED sha256 (nothing touches disk
 * before that) → unpack into a staging directory → move the archive's one top folder into place → prove it. Any failure
 * after the unpack deletes what was written (main/archive-install.ts).
 */
export async function installNodeVersion(version: string, consent: boolean, ports: NodeVersionsPorts): Promise<NodeInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Node ${version} was not installed` };
    if (!NODE_RECIPES.some((r) => r.version === version)) return { kind: 'refused', reason: `Genie has no installer for Node ${version}; this release installs ${NODE_RECIPES.map((r) => r.version).join(', ')}` };
    const arch = ports.arch ?? 'x64';
    if (ports.fs.exists(join(ports.root, version, nodeBinaryRel(ports.platform)))) return { kind: 'already-installed', version };
    const file = nodeArchiveName(version, ports.platform, arch);
    const { zipUrl, sumsUrl } = nodeDownloadSources(version, ports.platform, arch);
    return installArchive({
        label: `Node ${version}`, version, file, url: zipUrl, publisher: 'nodejs.org', topFolder: nodeTopFolder(version, ports.platform, arch),
        expectedSha: async () => {
            const sums = await ports.fetchText(sumsUrl);
            if (!sums.ok) return { ok: false, reason: `the published checksums (${sumsUrl}) could not be read (${sums.error})` };
            const sha = parseSha256Sums(sums.body).get(file);
            return sha ? { ok: true, sha } : { ok: false, reason: `${sumsUrl} lists no sha256 for ${file}` };
        },
        prove: async (dir) => {
            const node = join(dir, nodeBinaryRel(ports.platform));
            let said = '';
            try {
                said = (await ports.run(node, ['-v'])).stdout.trim();
            } catch (error) {
                return `Node ${version} unpacked, but ${node} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (parseNodeVersion(said) !== version) return `Node ${version} was asked for, but ${node} reports ${said.slice(0, 100) || 'nothing'}`;
            // ITS OWN npm, run by its own node — the half the owner's broken install failed.
            let npm: { stdout: string; exitCode: number };
            try {
                npm = await ports.run(node, [join(dir, nodeNpmCliRel(ports.platform)), '-v']);
            } catch (error) {
                return `Node ${version} runs, but its npm did not: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (npm.exitCode !== 0) return `Node ${version} runs, but its npm did not (exit ${npm.exitCode})${npm.stdout.trim() ? `: ${npm.stdout.trim().slice(0, 300)}` : ''}`;
            return null;
        },
    }, ports);
}

/** REMOVE a managed version — refused for anything Genie did not install. */
export function removeNodeVersion(version: string, ports: Pick<NodeVersionsPorts, 'platform' | 'root' | 'fs'>): NodeRemoveOutcome {
    const target = managedNode(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Node ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Node ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(join(target.dir, nodeBinaryRel(ports.platform)))) return { kind: 'refused', reason: `Node ${version} is still there after the delete (a running node holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}

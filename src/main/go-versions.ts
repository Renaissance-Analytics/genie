import { join } from 'node:path';
import { GO_DL_INDEX, GO_RECIPES, goArchiveName, goBinaryName, goDownloadUrl, goPlatformTag, goShaFromIndex, parseGoVersion, type GoArch, type GoPlatform } from '../core/go-versions.js';
import { managedVersions, type ManagedPhp } from '../core/php-versions.js';
import { installArchive } from './archive-install.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN GO — list, install, remove (plan `.ai/plans/genie-2-toolchain-rest.md`, TC2a), through the shared
 * archive installer (main/archive-install.ts). An install is judged by `go version` naming the version asked for AND
 * this machine's platform, from the directory Genie put it in — a pid is not proof it ran.
 */

export interface GoVersionsPorts {
    readonly platform: GoPlatform;
    readonly arch: GoArch;
    /** `<toolchain data>/go-versions` — one directory per version. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly progress?: (step: string | null) => void;
}

export interface GoVersionsView {
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string }>;
    /** The go on PATH, or `null` when none answers. */
    readonly system: { readonly version: string } | null;
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
}

export type GoInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type GoRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

/** Where the managed versions live, under Genie 2's toolchain directory. */
export function goVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'go-versions');
}

const binOf = (dir: string, platform: GoPlatform) => join(dir, 'bin', goBinaryName(platform));

/** The versions Genie manages here — a full version directory whose `bin/go` is there. Newest first. */
export function managedGo(ports: Pick<GoVersionsPorts, 'platform' | 'root' | 'fs'>): ManagedPhp[] {
    return managedVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(binOf(join(ports.root, v), ports.platform)), (v) => join(ports.root, v));
}

export async function listGoVersions(ports: GoVersionsPorts): Promise<GoVersionsView> {
    const managed = managedGo(ports);
    let system: GoVersionsView['system'] = null;
    try {
        const said = parseGoVersion((await ports.run('go', ['version'])).stdout);
        if (said) system = { version: said.version };
    } catch {
        // no go on PATH
    }
    const have = new Set(managed.map((m) => m.version));
    return { managed, system, available: GO_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) };
}

/** INSTALL ONE VERSION — only on the person's click; through the shared installer, proven by `go version`. */
export async function installGoVersion(version: string, consent: boolean, ports: GoVersionsPorts): Promise<GoInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Go ${version} was not installed` };
    if (!GO_RECIPES.some((r) => r.version === version)) return { kind: 'refused', reason: `Genie has no installer for Go ${version}; this release installs ${GO_RECIPES.map((r) => r.version).join(', ')}` };
    if (ports.fs.exists(binOf(join(ports.root, version), ports.platform))) return { kind: 'already-installed', version };
    const file = goArchiveName(version, ports.platform, ports.arch);
    const want = goPlatformTag(ports.platform, ports.arch);
    return installArchive({
        label: `Go ${version}`, version, file, url: goDownloadUrl(file), publisher: 'go.dev', topFolder: 'go',
        expectedSha: async () => {
            const index = await ports.fetchText(GO_DL_INDEX);
            if (!index.ok) return { ok: false, reason: `go.dev's release index (${GO_DL_INDEX}) could not be read (${index.error})` };
            const sha = goShaFromIndex(index.body, file);
            return sha ? { ok: true, sha } : { ok: false, reason: `go.dev's release index lists no sha256 for ${file}` };
        },
        prove: async (dir) => {
            const bin = binOf(dir, ports.platform);
            let said = '';
            try {
                said = (await ports.run(bin, ['version'])).stdout.trim();
            } catch (error) {
                return `Go ${version} unpacked, but ${bin} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            const got = parseGoVersion(said);
            if (!got) return `Go ${version} unpacked, but ${bin} did not say a Go version: ${said.slice(0, 200) || 'nothing'}`;
            if (got.version !== version) return `Go ${version} was asked for, but ${bin} reports ${got.version}`;
            if (got.platform !== want) return `Go ${version} for ${want} was asked for, but ${bin} reports ${got.platform}`;
            return null;
        },
    }, ports);
}

/** REMOVE a managed version — refused for anything Genie did not install. */
export function removeGoVersion(version: string, ports: Pick<GoVersionsPorts, 'platform' | 'root' | 'fs'>): GoRemoveOutcome {
    const target = managedGo(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Go ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Go ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(binOf(target.dir, ports.platform))) return { kind: 'refused', reason: `Go ${version} is still there after the delete (something running holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}

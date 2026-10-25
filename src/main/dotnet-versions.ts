import { join } from 'node:path';
import { DOTNET_RECIPES, dotnetArchiveName, dotnetBinaryName, dotnetDownloadUrl, dotnetReleasesUrl, dotnetRid, dotnetShaFromReleases, parseListSdks, type DotnetArch, type DotnetPlatform } from '../core/dotnet-versions.js';
import { managedVersions, type ManagedPhp } from '../core/php-versions.js';
import { installArchive } from './archive-install.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN .NET — list, install, remove (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6a), through the shared archive
 * installer, checked against the sha512 Microsoft publishes. An install is judged by that dotnet's own `--list-sdks`
 * naming the SDK asked for IN the directory Genie put it in. Remove first shuts that version's build servers down:
 * measured, they keep running after a build and hold files inside the SDK.
 */

export interface DotnetVersionsPorts {
    readonly platform: DotnetPlatform;
    readonly arch: DotnetArch;
    /** `<toolchain data>/dotnet-versions` — one directory per SDK version. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly progress?: (step: string | null) => void;
}

export interface DotnetVersionsView {
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string }>;
    /** The dotnet on PATH (its SDK version), or `null` when none answers. */
    readonly system: { readonly version: string } | null;
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
}

export type DotnetInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type DotnetRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

export function dotnetVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'dotnet-versions');
}

const binOf = (dir: string, platform: DotnetPlatform) => join(dir, dotnetBinaryName(platform));
const samePath = (a: string, b: string, platform: DotnetPlatform) => {
    const norm = (p: string) => p.replace(/[\\/]+$/, '');
    return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** The SDK versions Genie manages here — a full version directory whose dotnet is there. Newest first. */
export function managedDotnet(ports: Pick<DotnetVersionsPorts, 'platform' | 'root' | 'fs'>): ManagedPhp[] {
    return managedVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(binOf(join(ports.root, v), ports.platform)), (v) => join(ports.root, v));
}

export async function listDotnetVersions(ports: DotnetVersionsPorts): Promise<DotnetVersionsView> {
    const managed = managedDotnet(ports);
    let system: DotnetVersionsView['system'] = null;
    try {
        const said = await ports.run('dotnet', ['--version']);
        const v = said.exitCode === 0 ? /^(\d+\.\d+\.\d+\S*)\s*$/m.exec(said.stdout.trim())?.[1] : undefined;
        if (v) system = { version: v };
    } catch {
        // no dotnet on PATH
    }
    const have = new Set(managed.map((m) => m.version));
    return { managed, system, available: DOTNET_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) };
}

/** INSTALL ONE SDK — only on the person's click; through the shared installer (sha512), proven by its own --list-sdks. */
export async function installDotnetVersion(version: string, consent: boolean, ports: DotnetVersionsPorts): Promise<DotnetInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; .NET SDK ${version} was not installed` };
    const recipe = DOTNET_RECIPES.find((r) => r.version === version);
    if (!recipe) return { kind: 'refused', reason: `Genie has no installer for .NET SDK ${version}; this release installs ${DOTNET_RECIPES.map((r) => r.version).join(', ')}` };
    if (ports.fs.exists(binOf(join(ports.root, version), ports.platform))) return { kind: 'already-installed', version };
    const rid = dotnetRid(ports.platform, ports.arch);
    const file = dotnetArchiveName(version, rid);
    return installArchive({
        label: `.NET SDK ${version}`, version, file, url: dotnetDownloadUrl(version, file), publisher: 'Microsoft', topFolder: null, hash: 'sha512',
        expectedSha: async () => {
            const url = dotnetReleasesUrl(recipe.channel);
            const listed = await ports.fetchText(url);
            if (!listed.ok) return { ok: false, reason: `Microsoft's release list (${url}) could not be read (${listed.error})` };
            const sha = dotnetShaFromReleases(listed.body, version, rid);
            return sha ? { ok: true, sha } : { ok: false, reason: `Microsoft's release list gives no sha512 for ${file}` };
        },
        prove: async (dir) => {
            const bin = binOf(dir, ports.platform);
            let said = '';
            try {
                said = (await ports.run(bin, ['--list-sdks'])).stdout;
            } catch (error) {
                return `.NET SDK ${version} unpacked, but ${bin} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            const sdks = parseListSdks(said);
            if (sdks.some((s) => s.version === version && samePath(s.path, join(dir, 'sdk'), ports.platform))) return null;
            return `.NET SDK ${version} unpacked, but ${bin} does not list it in ${join(dir, 'sdk')}: ${said.trim().slice(0, 200) || 'it listed nothing'}`;
        },
    }, ports);
}

/** REMOVE a managed SDK — its build servers shut down first (they hold its files); refused for anything Genie did not install. */
export async function removeDotnetVersion(version: string, ports: Pick<DotnetVersionsPorts, 'platform' | 'root' | 'fs' | 'run'>): Promise<DotnetRemoveOutcome> {
    const target = managedDotnet(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `.NET SDK ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        await ports.run(binOf(target.dir, ports.platform), ['build-server', 'shutdown']);
    } catch {
        // nothing running, or it cannot answer: the delete below says whether anything still holds it
    }
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `.NET SDK ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(binOf(target.dir, ports.platform))) return { kind: 'refused', reason: `.NET SDK ${version} is still there after the delete (something running holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}

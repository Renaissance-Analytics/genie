import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { planBrowserInstall, playwrightDirs, parseLockedPlaywright, resolveBrowserSet, worktreeLinkDecision, type BrowserSetResolution, type LockKind } from '../core/playwright-managed.js';
import { platformArgv, type Platform } from '../core/toolchain.js';
import { nodePhpVersionsFs, type PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S PLAYWRIGHT BROWSERS (Tynn #604): installed ONCE into `<toolchain>/playwright/browsers`, for every workspace and
 * worktree. One Playwright CLI per version lives in `<toolchain>/playwright/cli/<version>` (`npm install playwright@<version>`)
 * and installs that version's browsers into the shared folder; Playwright names each revision's folder itself, so a revision
 * two versions share is downloaded once. A manifest (`sets.json`) records which browsers each version has: that is what
 * "never download a version twice" and "the version a project needs is missing" are answered from.
 */

export const DEFAULT_BROWSERS: readonly string[] = ['chromium'];
export const OPTIONAL_BROWSERS: readonly string[] = ['firefox', 'webkit'];

export interface PlaywrightBrowsersFs extends PhpVersionsFs {
    /** Total bytes under a path (0 when absent). */
    size(path: string): number;
}

export interface PlaywrightBrowsersPorts {
    readonly platform: Platform;
    /** `<data>/genie2-toolchain`. */
    readonly toolchainDir: string;
    readonly fs: PlaywrightBrowsersFs;
    readonly run: CommandRunner;
    readonly progress?: (step: string | null) => void;
}

export interface PlaywrightBrowsersView {
    readonly browsersPath: string;
    readonly totalBytes: number;
    readonly sets: ReadonlyArray<{ readonly version: string; readonly browsers: readonly string[]; /** Its browsers are really in the folder (Tynn #846). */ readonly ready: boolean }>;
    /** The stable channel: what Genie installs when nothing else is asked for (Tynn #846). */
    readonly stable: string;
    /** The newest Playwright, when the registry answered. */
    readonly latest: string | null;
    readonly optional: readonly string[];
}

export type PlaywrightInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string; readonly browsers: readonly string[] }
    | { readonly kind: 'installed'; readonly version: string; readonly browsers: readonly string[] }
    | { readonly kind: 'not-installed'; readonly reason: string };

type Manifest = Record<string, string[]>;

export function readManifest(ports: { readonly toolchainDir: string; readonly fs: Pick<PhpVersionsFs, 'readText'> }): Manifest {
    const text = ports.fs.readText?.(playwrightDirs(ports.toolchainDir).manifest) ?? null;
    if (text === null) return {};
    try {
        const parsed = JSON.parse(text) as { sets?: Manifest };
        return parsed.sets && typeof parsed.sets === 'object' ? parsed.sets : {};
    } catch {
        return {};
    }
}

function writeManifest(ports: Pick<PlaywrightBrowsersPorts, 'toolchainDir' | 'fs'>, sets: Manifest): void {
    const dirs = playwrightDirs(ports.toolchainDir);
    ports.fs.mkdirp(dirs.root);
    ports.fs.writeText(dirs.manifest, JSON.stringify({ sets }, null, 2));
}

const VERSION = /^\d+\.\d+\.\d+$/;

async function latestPlaywright(ports: PlaywrightBrowsersPorts): Promise<string | null> {
    try {
        const [binary, args] = platformArgv('npm', ['view', 'playwright', 'version'], ports.platform);
        const r = await ports.run(binary, args);
        const v = r.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
        return r.exitCode === 0 && VERSION.test(v) ? v : null;
    } catch {
        return null;
    }
}

export async function listPlaywrightBrowsers(ports: PlaywrightBrowsersPorts): Promise<PlaywrightBrowsersView> {
    const dirs = playwrightDirs(ports.toolchainDir);
    const manifest = readManifest(ports);
    const sets = Object.keys(manifest).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((version) => ({ version, browsers: manifest[version]!, ready: false /* RED: inert stub */ }));
    return { browsersPath: dirs.browsers, totalBytes: ports.fs.size(dirs.browsers), sets, stable: '' /* RED: inert stub */, latest: await latestPlaywright(ports), optional: OPTIONAL_BROWSERS };
}

/** The versions Genie has browsers for. */
export function installedVersions(ports: { readonly toolchainDir: string; readonly fs: Pick<PhpVersionsFs, 'readText'> }): string[] {
    return Object.keys(readManifest(ports));
}

/** Whether Genie has the browsers a project's Playwright needs. */
export function browserSetFor(version: string, ports: { readonly toolchainDir: string; readonly fs: Pick<PhpVersionsFs, 'readText'> }): BrowserSetResolution {
    return resolveBrowserSet(version, installedVersions(ports));
}

/**
 * Install (or update to) a Playwright version's browsers. `version` null = the newest. Consent is the click. Only the browsers
 * the version does not already have are downloaded; none missing is `already-installed`, with nothing downloaded.
 */
export async function installPlaywrightBrowsers(version: string | null, browsers: readonly string[], consent: boolean, ports: PlaywrightBrowsersPorts): Promise<PlaywrightInstallOutcome> {
    if (!consent) return { kind: 'refused', reason: 'Genie installs nothing without your go-ahead' };
    const wanted = browsers.length > 0 ? browsers : DEFAULT_BROWSERS;
    if (!wanted.every((b) => DEFAULT_BROWSERS.includes(b) || OPTIONAL_BROWSERS.includes(b))) return { kind: 'refused', reason: `Playwright's browsers Genie installs are ${[...DEFAULT_BROWSERS, ...OPTIONAL_BROWSERS].join(', ')}` };
    let target = version;
    if (target === null) {
        ports.progress?.('Asking which Playwright is newest');
        target = await latestPlaywright(ports);
        if (target === null) return { kind: 'not-installed', reason: 'the npm registry did not answer, so the newest Playwright is unknown' };
    }
    if (!VERSION.test(target)) return { kind: 'refused', reason: `${target} is not a Playwright version` };
    const dirs = playwrightDirs(ports.toolchainDir);
    const manifest = readManifest(ports);
    const plan = planBrowserInstall(target, wanted, manifest);
    if (plan.download.length === 0) return { kind: 'already-installed', version: target, browsers: manifest[target] ?? [] };
    const cli = join(dirs.cli(target), 'node_modules', 'playwright', 'cli.js');
    if (!ports.fs.exists(cli)) {
        ports.progress?.(`Installing the Playwright ${target} command line`);
        ports.fs.mkdirp(dirs.cli(target));
        const [binary, args] = platformArgv('npm', ['install', '--prefix', dirs.cli(target), `playwright@${target}`, '--no-audit', '--no-fund', '--no-save'], ports.platform);
        const r = await ports.run(binary, args);
        if (r.exitCode !== 0 || !ports.fs.exists(cli)) return { kind: 'not-installed', reason: `npm could not install playwright@${target}` };
    }
    ports.fs.mkdirp(dirs.browsers);
    ports.progress?.(`Downloading Playwright ${target}'s ${plan.download.join(', ')}`);
    const installed = await ports.run('node', [cli, 'install', ...plan.download], { env: { PLAYWRIGHT_BROWSERS_PATH: dirs.browsers } });
    if (installed.exitCode !== 0) return { kind: 'not-installed', reason: `playwright install ${plan.download.join(' ')} failed (exit ${installed.exitCode})` };
    const next: Manifest = { ...manifest, [target]: [...(manifest[target] ?? []), ...plan.download] };
    writeManifest(ports, next);
    ports.progress?.(null);
    return { kind: 'installed', version: target, browsers: next[target]! };
}

/** The Playwright a project's lockfile pins, or `null`: looks for npm's, then pnpm's, then yarn's. */
export function projectPlaywrightVersion(dir: string, fs: Pick<PhpVersionsFs, 'readText'>): string | null {
    const files: ReadonlyArray<readonly [string, LockKind]> = [['package-lock.json', 'package-lock'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']];
    for (const [name, kind] of files) {
        const text = fs.readText?.(join(dir, name)) ?? null;
        if (text !== null) return parseLockedPlaywright(text, kind);
    }
    return null;
}

const LOCKFILES: readonly string[] = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/** The project's lockfile text (the first one found), for comparing a worktree with its main checkout. */
function lockText(dir: string, fs: Pick<PhpVersionsFs, 'readText'>): string | null {
    for (const name of LOCKFILES) {
        const text = fs.readText?.(join(dir, name)) ?? null;
        if (text !== null) return `${name}\n${text}`;
    }
    return null;
}

export interface WorktreeLinkPorts {
    readonly platform: Platform;
    readonly fs: Pick<PhpVersionsFs, 'exists' | 'readText'>;
    /** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
    readonly link: (target: string, path: string, kind: 'junction' | 'dir') => void;
}

/** Link a worktree's node_modules to the main checkout's, so `@playwright/test` is there with no install. Never when the lockfiles differ. */
export function linkWorktreeModules(mainDir: string, worktreeDir: string, ports: WorktreeLinkPorts): { readonly linked: boolean; readonly reason?: string } {
    const decision = worktreeLinkDecision({
        mainLock: lockText(mainDir, ports.fs),
        worktreeLock: lockText(worktreeDir, ports.fs),
        mainHasNodeModules: ports.fs.exists(join(mainDir, 'node_modules')),
        worktreeHasNodeModules: ports.fs.exists(join(worktreeDir, 'node_modules')),
    });
    if (!decision.link) return { linked: false, ...(decision.reason ? { reason: decision.reason } : {}) };
    ports.link(join(mainDir, 'node_modules'), join(worktreeDir, 'node_modules'), ports.platform === 'win32' ? 'junction' : 'dir');
    return { linked: true };
}

function treeSize(path: string): number {
    let total = 0;
    try {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            total += entry.isDirectory() ? treeSize(child) : entry.isSymbolicLink() ? 0 : statSync(child).size;
        }
    } catch {
        // absent or unreadable: nothing counted
    }
    return total;
}

export function nodePlaywrightFs(): PlaywrightBrowsersFs {
    return { ...nodePhpVersionsFs(), size: treeSize };
}

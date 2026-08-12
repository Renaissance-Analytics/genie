import type { HostToolName } from './toolchain-detect';
import type { InstallStep } from './toolchain-plan';
import { pmPackageFor } from './toolchain-packages';
import type { PackageManager } from './toolchain-packages';

/**
 * PURE. Turn one planned {@link InstallStep} into the concrete command that
 * carries it out — the exact `winget install --id …`, `brew install`,
 * `apt-get install -y`, `npm i -g`, or the URL of an installer to download.
 *
 * This is the dev-server's `argv.ts` split applied to installs: the DECISIONS
 * (what, in what order, at what cost) are the planner's and are already made;
 * this module only MATERIALISES them, so the one thing worth testing — the
 * literal command line — is asserted with no process and no download. Execution
 * is a thin layer over the `CommandRunner` seam and the Phase-4 executor; nothing
 * here runs anything.
 *
 * ## Two shapes, because installs come in two kinds
 *
 * A package-manager or `npm i -g` install is "run this argv" ({@link
 * RunInstallCommand}). A direct install is "fetch this artifact, then run or
 * unpack it" ({@link DownloadInstallCommand}) — the real Windows path when winget
 * lacks a package, and the universal fallback. The two are a discriminated union
 * so a caller must handle the fetch rather than forget it.
 *
 * ## Honest URLs only
 *
 * Where an artifact has a STABLE address (composer's stable phar, Docker
 * Desktop's per-arch installer) the URL is emitted directly. Where it does NOT —
 * git/node/php on Windows ship only versioned assets with no fixed "latest" file
 * — the command carries `url: null` and a {@link DirectSource} the executor
 * resolves the current version against. Fabricating a pinned URL that rots the
 * next release is exactly the kind of bandaid this leaves out.
 */

/** The machine facts a command build depends on. `arch` only matters for the
 *  per-architecture direct downloads (Docker, node). */
export interface AdapterContext {
    os: NodeJS.Platform | string;
    arch?: NodeJS.Architecture | string;
}

interface InstallCommandBase {
    tool: HostToolName;
    /** A human one-liner for the consent list + the wizard row. */
    label: string;
    requiresElevation: boolean;
    requiresRestart: boolean;
}

/** Run a literal argv — package managers and `npm i -g`. */
export interface RunInstallCommand extends InstallCommandBase {
    via: 'run';
    command: string;
    args: string[];
}

/** A source whose latest version must be RESOLVED before a URL exists. */
export type DirectSource = 'git-for-windows' | 'nodejs-dist' | 'php-windows';

/** Fetch an artifact, then run or unpack it. */
export interface DownloadInstallCommand extends InstallCommandBase {
    via: 'download';
    /** The download URL, or `null` when {@link source} must resolve it first. */
    url: string | null;
    /** Set iff `url` is null: how the executor resolves the current version. */
    source?: DirectSource;
    artifact: 'exe' | 'msi' | 'dmg' | 'pkg' | 'zip' | 'phar' | 'script';
    /** Another tool the artifact needs to run (composer.phar needs php). */
    needs?: HostToolName;
    /** For an installer artifact: the args to run it with after download. */
    run?: { args: string[] };
}

export type InstallCommand = RunInstallCommand | DownloadInstallCommand;

/** What a per-method builder returns: the command minus the three fields
 *  {@link buildInstallCommand} injects from the step (tool + the two cost flags).
 *  `label` stays with the builder — it is the tool-specific part. */
type BuiltRun = Omit<RunInstallCommand, 'tool' | 'requiresElevation' | 'requiresRestart'>;
type BuiltDownload = Omit<DownloadInstallCommand, 'tool' | 'requiresElevation' | 'requiresRestart'>;

/** The agent-TUI npm packages. Keyed by tool, since the bin name (`claude`)
 *  differs from both the tool name and the package. Exported as the single
 *  source of truth for both installing (`npm i -g`) and update-checking
 *  (`npm outdated -g`, #242). */
export const NPM_PACKAGES: Partial<Record<HostToolName, string>> = {
    'claude-code': '@anthropic-ai/claude-code',
    codex: '@openai/codex',
};

/**
 * Materialise one step into its command. Pure; never touches the network.
 *
 * Throws only on an impossible input — a `pm` step for a tool the manager has no
 * package for. The planner cannot produce that (it picks `pm` only when a
 * package exists), so a throw here means the two drifted, which is a bug to
 * surface loudly, not a fake id to paper over.
 */
export function buildInstallCommand(step: InstallStep, ctx: AdapterContext): InstallCommand {
    const base = {
        tool: step.tool,
        requiresElevation: step.requiresElevation,
        requiresRestart: step.requiresRestart,
    };
    switch (step.method) {
        case 'pm':
            return { ...base, ...buildPmCommand(step.tool, requirePm(step)) };
        case 'npm-global':
            return { ...base, ...buildNpmGlobalCommand(step.tool) };
        case 'direct':
            return { ...base, ...buildDirectCommand(step.tool, ctx) };
    }
}

function requirePm(step: InstallStep): PackageManager {
    if (!step.packageManager) {
        throw new Error(`toolchain: a pm install of ${step.tool} has no package manager`);
    }
    return step.packageManager;
}

// --- package managers ------------------------------------------------------

function buildPmCommand(tool: HostToolName, pm: PackageManager): BuiltRun {
    const pkg = pmPackageFor(pm, tool);
    if (!pkg) {
        throw new Error(`toolchain: ${pm} has no package for ${tool}`);
    }
    switch (pm) {
        case 'winget':
            return {
                via: 'run',
                command: 'winget',
                args: [
                    'install',
                    '--id',
                    pkg.id,
                    '-e',
                    '--silent',
                    '--accept-source-agreements',
                    '--accept-package-agreements',
                ],
                label: `winget install ${pkg.id}`,
            };
        case 'brew':
            return {
                via: 'run',
                command: 'brew',
                args: pkg.cask ? ['install', '--cask', pkg.id] : ['install', pkg.id],
                label: `brew install ${pkg.cask ? '--cask ' : ''}${pkg.id}`,
            };
        case 'apt':
            // `-y` so it never blocks on a prompt. `apt-get`, not `apt`, because
            // `apt` prints "unstable CLI" on non-interactive use. The index
            // refresh is a separate pass — see `packageManagerRefreshCommand`.
            return {
                via: 'run',
                command: 'apt-get',
                args: ['install', '-y', pkg.id],
                label: `apt-get install ${pkg.id}`,
            };
        case 'dnf':
            return {
                via: 'run',
                command: 'dnf',
                args: ['install', '-y', pkg.id],
                label: `dnf install ${pkg.id}`,
            };
    }
}

/**
 * The index-refresh a manager needs BEFORE an install, or null.
 *
 * Only apt: installing against a stale apt index is the classic "package has no
 * installation candidate" failure, so the executor runs `apt-get update` once
 * before the batch. dnf refreshes metadata on demand, and winget/brew query live
 * — none need a separate pass.
 */
export function packageManagerRefreshCommand(
    pm: PackageManager,
): { command: string; args: string[] } | null {
    return pm === 'apt' ? { command: 'apt-get', args: ['update'] } : null;
}

// --- agent TUIs ------------------------------------------------------------

function buildNpmGlobalCommand(tool: HostToolName): BuiltRun {
    const pkg = NPM_PACKAGES[tool];
    if (!pkg) {
        throw new Error(`toolchain: no npm package for ${tool}`);
    }
    return { via: 'run', command: 'npm', args: ['install', '-g', pkg], label: `npm install -g ${pkg}` };
}

// --- direct downloads ------------------------------------------------------

/** winget/docker use `amd64`/`arm64`; map Node's `arch` onto that vocabulary. */
function dockerArch(arch: string | undefined): 'amd64' | 'arm64' {
    return arch === 'arm64' ? 'arm64' : 'amd64';
}

function buildDirectCommand(tool: HostToolName, ctx: AdapterContext): BuiltDownload {
    if (tool === 'composer') {
        // The stable phar has a fixed URL and is arch-independent; it needs php
        // to run, which the plan ordered before it.
        return {
            via: 'download',
            url: 'https://getcomposer.org/composer-stable.phar',
            artifact: 'phar',
            needs: 'php',
            label: 'download composer (stable phar)',
        };
    }
    if (tool === 'docker') return buildDockerDirect(ctx);

    // git / node / php on Windows ship only versioned assets — no fixed "latest"
    // file exists, so the version is resolved at run time rather than pinned here.
    const source = VERSIONED_SOURCE[tool];
    if (source) {
        return {
            via: 'download',
            url: null,
            source,
            artifact: tool === 'php' ? 'zip' : tool === 'node' ? 'zip' : 'exe',
            label: `download ${tool} (latest, resolved)`,
        };
    }
    // npm direct is node's job (npm ships inside node); anything else direct is
    // not modelled yet — surface it rather than emit a null-url mystery.
    throw new Error(`toolchain: no direct-download recipe for ${tool} on ${ctx.os}`);
}

const VERSIONED_SOURCE: Partial<Record<HostToolName, DirectSource>> = {
    git: 'git-for-windows',
    node: 'nodejs-dist',
    php: 'php-windows',
};

function buildDockerDirect(ctx: AdapterContext): BuiltDownload {
    switch (ctx.os) {
        case 'win32':
            return {
                via: 'download',
                url: `https://desktop.docker.com/win/main/${dockerArch(ctx.arch)}/Docker Desktop Installer.exe`,
                artifact: 'exe',
                run: { args: ['install', '--quiet'] },
                label: 'download Docker Desktop installer',
            };
        case 'darwin':
            return {
                via: 'download',
                url: `https://desktop.docker.com/mac/main/${dockerArch(ctx.arch)}/Docker.dmg`,
                artifact: 'dmg',
                label: 'download Docker Desktop (dmg)',
            };
        default:
            // The official convenience script. A deliberate, consented run — the
            // executor fetches it and runs it with sh under the user's yes.
            return {
                via: 'download',
                url: 'https://get.docker.com',
                artifact: 'script',
                label: 'download Docker install script (get.docker.com)',
            };
    }
}

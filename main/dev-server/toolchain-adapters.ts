import type { HostToolName } from './toolchain-detect';
import type { InstallStep } from './toolchain-plan';
import { pmPackageFor } from './toolchain-packages';
import type { PackageManager } from './toolchain-packages';
import { LANGUAGE_LABELS, recipesFor } from './toolchain-versions';
import type { LanguageTool } from './toolchain-versions';

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

/**
 * CONFIRM a tool an earlier step already installed, instead of installing the
 * same package twice.
 *
 * Emitted for a step the planner marked {@link InstallStep.coveredBy}. It is not
 * a free pass: the effect re-probes the tool, so a covered tool that is somehow
 * NOT there fails — and says which install was supposed to have provided it.
 */
export interface VerifyInstallCommand extends InstallCommandBase {
    via: 'verify';
    /** The step whose install is expected to have brought this tool. */
    coveredBy: HostToolName;
}

/**
 * Install a LANGUAGE through Genie's own per-version installer (genie#212).
 *
 * The wizard used to fetch php/node itself and unpack them into
 * `<userData>/tools/<tool>` — a directory the Toolchain page has never looked
 * in. Two installers, two layouts, and a page that truthfully reported nothing
 * after the wizard had just installed something. This command routes the wizard
 * at the SAME installer the page's "Add a version" uses, so there is one root,
 * one layout, one `php.ini` and one definition of a successful install.
 *
 * The version is a {@link TOOLCHAIN_RECIPES} entry rather than "whatever the
 * vendor index says is newest": the page can only offer versions this release
 * knows it can install, and a wizard that installed something outside that list
 * would produce a row the page could not reason about.
 */
export interface EngineInstallCommand extends InstallCommandBase {
    via: 'engine';
    /** The language — always one {@link engineToolFor} recognised. */
    engine: LanguageTool;
    /** The exact version, from this release's recipe table. */
    version: string;
}

export type InstallCommand =
    | RunInstallCommand
    | DownloadInstallCommand
    | VerifyInstallCommand
    | EngineInstallCommand;

/** The language a host tool IS, when Genie manages versions of it. `npm` is
 *  deliberately absent — it arrives inside node, it is not installed. */
export function engineToolFor(tool: HostToolName): LanguageTool | undefined {
    return tool === 'php' || tool === 'node' ? tool : undefined;
}

/**
 * The engine install for a tool on this machine, or undefined when Genie has no
 * recipe here — php on macOS/Linux, where no relocatable official build exists.
 * Those keep their previous route rather than being offered a download that
 * cannot work.
 */
function buildEngineCommand(
    tool: HostToolName,
    ctx: AdapterContext,
): Omit<EngineInstallCommand, 'tool' | 'requiresElevation' | 'requiresRestart'> | undefined {
    const engine = engineToolFor(tool);
    if (!engine) return undefined;
    const newest = recipesFor(engine, { os: ctx.os, ...(ctx.arch ? { arch: ctx.arch } : {}) })[0];
    if (!newest) return undefined;
    return {
        via: 'engine',
        engine,
        version: newest.version,
        label: `install ${LANGUAGE_LABELS[engine]} ${newest.version} into Genie's toolchain`,
    };
}

/**
 * Install a missing tool, or UPDATE an already-present one (Toolchain Manager,
 * #242 P2). Only package-manager commands differ — `install` on a present winget
 * or brew package is a no-op, so an update must use the manager's `upgrade` verb;
 * npm-global and direct downloads already fetch the latest, so their update IS
 * their install.
 */
export type InstallIntent = 'install' | 'update';

/**
 * Is acting on this tool an INSTALL or an UPDATE?
 *
 * Decided from what detection actually found, because the two are different
 * commands and the wrong one fails: `winget upgrade --id <pkg>` on a machine
 * that does not have the package errors out. The Toolchain page ran everything
 * as an update, which was invisible only while it had no Install button to
 * offer — the moment it grew one (genie#212) an absent tool would have been
 * "updated" and reported as broken.
 */
export function installIntentFor(
    tool: HostToolName,
    present: readonly HostToolName[],
): InstallIntent {
    return present.includes(tool) ? 'update' : 'install';
}

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
export function buildInstallCommand(
    step: InstallStep,
    ctx: AdapterContext,
    intent: InstallIntent = 'install',
): InstallCommand {
    const base = {
        tool: step.tool,
        requiresElevation: step.requiresElevation,
        requiresRestart: step.requiresRestart,
    };
    // One package, one install: a step an earlier one already covers is confirmed,
    // not re-run (genie#209).
    if (step.coveredBy) {
        return {
            ...base,
            via: 'verify',
            coveredBy: step.coveredBy,
            label: `${step.tool} (installed with ${step.coveredBy})`,
        };
    }
    // A language Genie has a recipe for goes through Genie's own per-version
    // installer WHATEVER the planner picked, and that override is the point of
    // genie#212: a brew- or winget-installed node lands somewhere Genie does not
    // own, so the page can only ever list it as unmanaged and no site can pin to
    // it. One installer, one root, on every platform.
    const engine = buildEngineCommand(step.tool, ctx);
    if (engine) return { ...base, ...engine };

    switch (step.method) {
        case 'pm':
            return { ...base, ...buildPmCommand(step.tool, requirePm(step), intent) };
        // npm-global (`npm i -g`) and direct downloads already resolve the latest,
        // so update and install are the same command.
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

function buildPmCommand(tool: HostToolName, pm: PackageManager, intent: InstallIntent): BuiltRun {
    const pkg = pmPackageFor(pm, tool);
    if (!pkg) {
        throw new Error(`toolchain: ${pm} has no package for ${tool}`);
    }
    const updating = intent === 'update';
    switch (pm) {
        case 'winget': {
            // `upgrade` is the same shape as `install`, just the verb — both take
            // the id and the non-interactive flags; `install` on a present package
            // would not move its version.
            const verb = updating ? 'upgrade' : 'install';
            return {
                via: 'run',
                command: 'winget',
                args: [
                    verb,
                    '--id',
                    pkg.id,
                    '-e',
                    '--silent',
                    '--accept-source-agreements',
                    '--accept-package-agreements',
                ],
                label: `winget ${verb} ${pkg.id}`,
            };
        }
        case 'brew': {
            const verb = updating ? 'upgrade' : 'install';
            return {
                via: 'run',
                command: 'brew',
                args: pkg.cask ? [verb, '--cask', pkg.id] : [verb, pkg.id],
                label: `brew ${verb} ${pkg.cask ? '--cask ' : ''}${pkg.id}`,
            };
        }
        case 'apt':
            // `-y` so it never blocks on a prompt. `apt-get`, not `apt`, because
            // `apt` prints "unstable CLI" on non-interactive use. The index
            // refresh is a separate pass — see `packageManagerRefreshCommand`.
            // `--only-upgrade` updates a package ONLY if it is installed — the
            // right semantics for a manager row that exists because the tool is
            // already here (never silently re-add a user's removed package).
            return {
                via: 'run',
                command: 'apt-get',
                args: updating ? ['install', '-y', '--only-upgrade', pkg.id] : ['install', '-y', pkg.id],
                label: `apt-get install ${updating ? '--only-upgrade ' : ''}${pkg.id}`,
            };
        case 'dnf':
            return {
                via: 'run',
                command: 'dnf',
                args: updating ? ['upgrade', '-y', pkg.id] : ['install', '-y', pkg.id],
                label: `dnf ${updating ? 'upgrade' : 'install'} ${pkg.id}`,
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
    if (tool === 'vcredist') {
        // Microsoft's permanent short link: no version to resolve, nothing that
        // rots, and the only route on a Windows box without winget. The silent
        // switches are the vendor's own; `/norestart` because the DLLs are usable
        // immediately and a surprise reboot is worse than none.
        return {
            via: 'download',
            url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
            artifact: 'exe',
            run: { args: ['/install', '/quiet', '/norestart'] },
            label: 'download the Visual C++ runtime (required by PHP)',
        };
    }
    if (tool === 'docker') return buildDockerDirect(ctx);

    // git on Windows ships only versioned assets — no fixed "latest" file
    // exists, so the version is resolved at run time rather than pinned here.
    const source = VERSIONED_SOURCE[tool];
    if (source) {
        return {
            via: 'download',
            url: null,
            source,
            artifact: 'exe',
            label: `download ${tool} (latest, resolved)`,
        };
    }
    // npm direct is node's job (npm ships inside node); anything else direct is
    // not modelled yet — surface it rather than emit a null-url mystery.
    throw new Error(`toolchain: no direct-download recipe for ${tool} on ${ctx.os}`);
}

/**
 * Tools whose download URL must be RESOLVED against a vendor index.
 *
 * node and php used to be here. They are not any more, and their absence is the
 * fix for genie#212: a language Genie manages versions of is installed by
 * {@link buildEngineCommand} into `<userData>/toolchain/<tool>/<version>` — the
 * one root the Toolchain page reads. Resolving "whatever the vendor calls latest
 * today" and unpacking it somewhere else is what made the wizard's installs
 * invisible to the page, so that path is gone rather than left as a fallback
 * something could quietly route back through.
 */
const VERSIONED_SOURCE: Partial<Record<HostToolName, DirectSource>> = {
    git: 'git-for-windows',
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

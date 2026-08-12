import { DEFAULT_TOOLCHAIN } from './toolchain-detect';
import type { HostToolName, ToolchainReport } from './toolchain-detect';

/**
 * PURE. "Given what this machine HAS, what should be installed, in what order,
 * and how?"
 *
 * This is the decision layer of the zero-setup toolchain (Tynn #240, Phase 1),
 * and it is deliberately shaped like `argv.ts` in the dev server: the decisions
 * with teeth are separated from the shell that carries them out, so they are
 * assertable with no process, no download and no OS. The concrete commands — the
 * exact `winget install --id …`, the MSI URL, the `brew` line — are the
 * per-platform ADAPTERS' job (Phase 2, #683); this module decides only the
 * things a wrong answer to which would matter:
 *
 *   - **what** to install — never a tool that is already present, because
 *     clobbering a user's own php or node is the one thing the whole detect-first
 *     design exists to avoid;
 *   - **the order** — a dependency before its dependents (node before the agent
 *     TUIs it hosts, php before composer), git early, and **docker last** because
 *     docker is the step that wants elevation and, on Windows, a reboot;
 *   - **the method** — the chosen package manager where it can do the job, a
 *     direct download where it cannot (composer under winget is the load-bearing
 *     example), and `npm i -g` for the agent TUIs regardless;
 *   - **the cost** — whether a step needs elevation (UAC/sudo) or a machine
 *     restart, carried forward so consent (Phase 3) can SHOW it. A UAC prompt or
 *     a required reboot must never be a surprise.
 *
 * It never runs anything. The output is a plan an executor and a wizard read.
 */

/** A package manager the plan can drive. Availability (which of these EXIST on
 *  the machine) is Phase 3's question; this module is TOLD which one to use. */
export type PackageManager = 'winget' | 'brew' | 'apt' | 'dnf';

/**
 * How a tool gets installed.
 *   - `pm`         via {@link PackageManager} (winget/brew/apt/dnf);
 *   - `direct`     a downloaded installer/script + PATH edit (the real Windows
 *                  path when winget lacks a package, and the universal fallback);
 *   - `npm-global` `npm i -g` — the agent TUIs, once npm exists.
 */
export type InstallMethod = 'pm' | 'direct' | 'npm-global';

/** One planned install. No argv/url yet — the adapter fills those in Phase 2;
 *  what is fixed here are the decisions the adapter must honour. */
export interface InstallStep {
    tool: HostToolName;
    method: InstallMethod;
    /** Set iff {@link method} === 'pm'. */
    packageManager?: PackageManager;
    /** Needs elevated privileges — a UAC prompt on Windows, sudo on Linux. */
    requiresElevation: boolean;
    /** Needs a machine RESTART to complete (Windows Docker + WSL2). Distinct
     *  from a shell restart for PATH, which is Phase 7's concern. */
    requiresRestart: boolean;
    /** Tools that must be present first. The install order already satisfies
     *  these; they are carried so the executor can treat an already-present
     *  prerequisite as met and skip a dependent whose prerequisite failed. */
    dependsOn: HostToolName[];
}

/**
 * The canonical install order.
 *
 * Chosen so the sequence itself satisfies every dependency — git first (nothing
 * needs it, everything benefits), node then npm (the agent TUIs are `npm i -g`),
 * php then composer (composer is a php script), the agent TUIs next, and docker
 * LAST because it is the elevation/reboot step and there is no reason to make the
 * cheap installs wait behind it. The planner sorts the missing set by this order
 * rather than by whatever order the caller `wanted`.
 */
export const INSTALL_ORDER: readonly HostToolName[] = [
    'git',
    'node',
    'npm',
    'php',
    'composer',
    'claude-code',
    'codex',
    'docker',
];

/** The agent TUIs — installed with `npm i -g`, never by a system PM. */
const NPM_GLOBAL_TOOLS: ReadonlySet<HostToolName> = new Set(['claude-code', 'codex']);

/**
 * Which tools each package manager can install itself.
 *
 * A tool absent from a PM's set falls back to a direct download. The one that
 * bites in practice is **composer under winget**: there is no first-class winget
 * package for it, so Windows installs composer with its own php-driven installer
 * even when the rest of the toolchain came from winget. brew/apt/dnf all ship
 * composer, so only winget carries the gap.
 */
const PM_CAPABILITIES: Record<PackageManager, ReadonlySet<HostToolName>> = {
    winget: new Set(['git', 'node', 'npm', 'php', 'docker']),
    brew: new Set(['git', 'node', 'npm', 'php', 'composer', 'docker']),
    apt: new Set(['git', 'node', 'npm', 'php', 'composer', 'docker']),
    dnf: new Set(['git', 'node', 'npm', 'php', 'composer', 'docker']),
};

/** Each tool's prerequisite tools. Absent → no prerequisite. */
const DEPENDS_ON: Partial<Record<HostToolName, HostToolName[]>> = {
    npm: ['node'],
    composer: ['php'],
    'claude-code': ['npm'],
    codex: ['npm'],
};

export interface PlanToolchainOptions {
    /** The Phase-0 detection report — its `present` set is what gets skipped. */
    detected: ToolchainReport;
    os: NodeJS.Platform | string;
    /** The package manager to prefer, or `direct` to download everything. */
    pmChoice: PackageManager | 'direct';
    /** Which tools to consider. Defaults to the full {@link DEFAULT_TOOLCHAIN};
     *  narrow it to plan a subset. */
    wanted?: readonly HostToolName[];
}

/**
 * The install plan: the missing subset of `wanted`, ordered by
 * {@link INSTALL_ORDER}, each with its method and cost decided.
 *
 * Pure and total — an empty result (everything present) is the ordinary success,
 * not an error.
 */
export function planToolchainInstall(opts: PlanToolchainOptions): InstallStep[] {
    const present = new Set(opts.detected.present);
    const wanted = new Set(opts.wanted ?? DEFAULT_TOOLCHAIN);

    return INSTALL_ORDER.filter((tool) => wanted.has(tool) && !present.has(tool)).map((tool) =>
        buildStep(tool, opts.os, opts.pmChoice),
    );
}

function buildStep(
    tool: HostToolName,
    os: NodeJS.Platform | string,
    pmChoice: PackageManager | 'direct',
): InstallStep {
    const method = methodFor(tool, pmChoice);
    return {
        tool,
        method,
        ...(method === 'pm' ? { packageManager: pmChoice as PackageManager } : {}),
        requiresElevation: elevationFor(tool, os, method),
        requiresRestart: restartFor(tool, os),
        dependsOn: DEPENDS_ON[tool] ?? [],
    };
}

/** PM where it can do the job; the agent TUIs always via npm; direct otherwise. */
function methodFor(tool: HostToolName, pmChoice: PackageManager | 'direct'): InstallMethod {
    if (NPM_GLOBAL_TOOLS.has(tool)) return 'npm-global';
    if (pmChoice !== 'direct' && PM_CAPABILITIES[pmChoice].has(tool)) return 'pm';
    return 'direct';
}

/**
 * Whether a step needs elevated privileges.
 *
 *   - **docker** always — a system-wide engine + (on Windows) WSL2;
 *   - a **linux package-manager** install always — `sudo apt`/`sudo dnf`;
 *   - a **Windows direct** installer usually — an MSI writing under Program Files
 *     triggers UAC.
 *
 * Everything else is left unelevated: a mac Homebrew install lands in a
 * user-owned prefix, a Windows winget install can take `--scope user`, and an
 * `npm i -g` writes to the user's own global prefix. A first-order rule — the
 * wizard still surfaces whatever prompt an installer actually raises — but an
 * honest one about the steps that reliably DO need a prompt.
 */
function elevationFor(tool: HostToolName, os: NodeJS.Platform | string, method: InstallMethod): boolean {
    if (tool === 'docker') return true;
    if (method === 'pm' && os === 'linux') return true;
    if (method === 'direct' && os === 'win32') return true;
    return false;
}

/** Only Windows Docker forces a reboot (WSL2). Docker Desktop on mac and Docker
 *  Engine on Linux come up without one, and nothing else here needs a restart. */
function restartFor(tool: HostToolName, os: NodeJS.Platform | string): boolean {
    return tool === 'docker' && os === 'win32';
}

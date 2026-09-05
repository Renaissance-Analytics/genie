import { DEFAULT_TOOLCHAIN } from './toolchain-detect';
import type { HostToolName, ToolchainReport } from './toolchain-detect';
import { pmCanInstall, pmPackageFor } from './toolchain-packages';
import { AGENT_CLI_IDS } from '../agents/agent-cli-catalog';
import type { PackageManager } from './toolchain-packages';

// The package-manager identity lives in one place (`toolchain-packages.ts`) so
// the planner's method choice and the adapter's concrete command can never
// disagree about what a manager can install. Re-exported for callers that used
// to import it from here.
export type { PackageManager } from './toolchain-packages';

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
    /**
     * An EARLIER step in this same plan whose install already brings this tool —
     * both resolve to one package for the chosen manager (winget/brew ship npm
     * INSIDE node, so `npm` and `node` are both `OpenJS.NodeJS.LTS`).
     *
     * The step stays in the plan: the user asked for the tool and the wizard
     * shows a row per tool. Only its EXECUTION is shared — the executor confirms
     * the tool rather than installing the same package a second time. Running it
     * twice is what made winget answer "existing package already installed" with
     * a non-zero exit, fail npm, and skip both agent TUIs (genie#209).
     */
    coveredBy?: HostToolName;
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
    // php's Windows runtime prerequisite — before php, because php cannot start
    // without it (genie#209).
    'vcredist',
    'php',
    'composer',
    // Every agent CLI, DERIVED — after npm (they are all `npm i -g`) and before
    // docker (the elevation/reboot step, which nothing cheap should wait behind).
    // Written out, this said `claude-code, codex`, and a catalogued CLI missing
    // from it would have been filtered straight out of every plan: the planner
    // walks this list, so absence here is not a wrong order, it is a tool that
    // silently cannot be installed at all.
    ...AGENT_CLI_IDS,
    'docker',
];

/** The agent CLIs — installed with `npm i -g`, never by a system PM. Derived, so
 *  a new CLI cannot fall through to a `direct` download with no recipe. */
const NPM_GLOBAL_TOOLS: ReadonlySet<HostToolName> = new Set<HostToolName>(AGENT_CLI_IDS);

/** Each tool's prerequisite tools. Absent → no prerequisite. Every agent CLI
 *  needs npm, for the same reason and by the same derivation. */
const DEPENDS_ON: Partial<Record<HostToolName, HostToolName[]>> = {
    npm: ['node'],
    composer: ['php'],
    ...Object.fromEntries(AGENT_CLI_IDS.map((id) => [id, ['npm']])),
};

/**
 * Prerequisites, for THIS platform.
 *
 * php's Visual C++ runtime is the only platform-specific one, and it has to be
 * platform-specific rather than a static entry: a `dependsOn` naming a tool that
 * is neither present nor planned makes the executor SKIP its dependent, so a
 * blanket `php: ['vcredist']` would refuse to install php on every mac and Linux
 * machine.
 */
function dependsOnFor(tool: HostToolName, os: NodeJS.Platform | string): HostToolName[] {
    if (tool === 'php' && os === 'win32') return ['vcredist'];
    return DEPENDS_ON[tool] ?? [];
}

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

    const steps = INSTALL_ORDER.filter((tool) => wanted.has(tool) && !present.has(tool)).map((tool) =>
        buildStep(tool, opts.os, opts.pmChoice),
    );
    return markSharedPackages(steps, opts.pmChoice);
}

/**
 * Mark every step whose package an EARLIER step already installs.
 *
 * Pure, and decided here rather than at execution time because it is knowable
 * before anything runs: it is a fact about the chosen manager's package table.
 * Only the FIRST step naming a package installs it; the rest are covered by it.
 * The cask flag is part of the identity — brew's `docker` formula and `docker`
 * cask are two different things that happen to share a name.
 */
function markSharedPackages(
    steps: InstallStep[],
    pmChoice: PackageManager | 'direct',
): InstallStep[] {
    if (pmChoice === 'direct') return steps;
    const installedBy = new Map<string, HostToolName>();
    return steps.map((step) => {
        const pkg = step.method === 'pm' ? pmPackageFor(pmChoice, step.tool) : undefined;
        if (!pkg) return step;
        const key = `${pkg.cask ? 'cask:' : ''}${pkg.id}`;
        const owner = installedBy.get(key);
        if (owner === undefined) {
            installedBy.set(key, step.tool);
            return step;
        }
        return { ...step, coveredBy: owner };
    });
}

/**
 * The single-tool UPDATE step for the Toolchain Manager (#242 P2).
 *
 * Unlike {@link planToolchainInstall} this targets a tool that is already
 * PRESENT — bringing it to latest — so it never consults a present-set (which
 * would filter it out). The method and cost are exactly what an install of that
 * tool would choose for this OS + package manager; the adapter's `update` intent
 * turns a `pm` step into an upgrade rather than an install.
 */
export function planToolUpdate(
    tool: HostToolName,
    os: NodeJS.Platform | string,
    pmChoice: PackageManager | 'direct',
): InstallStep {
    return buildStep(tool, os, pmChoice);
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
        dependsOn: dependsOnFor(tool, os),
    };
}

/** PM where it can do the job; the agent TUIs always via npm; direct otherwise. */
function methodFor(tool: HostToolName, pmChoice: PackageManager | 'direct'): InstallMethod {
    if (NPM_GLOBAL_TOOLS.has(tool)) return 'npm-global';
    if (pmChoice !== 'direct' && pmCanInstall(pmChoice, tool)) return 'pm';
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
    // The VC++ runtime writes System32 whichever way it is installed — winget
    // included, which is the one case the `pm` rule below would let through.
    if (tool === 'vcredist') return true;
    if (method === 'pm' && os === 'linux') return true;
    if (method === 'direct' && os === 'win32') return true;
    return false;
}

/** Only Windows Docker forces a reboot (WSL2). Docker Desktop on mac and Docker
 *  Engine on Linux come up without one, and nothing else here needs a restart. */
function restartFor(tool: HostToolName, os: NodeJS.Platform | string): boolean {
    return tool === 'docker' && os === 'win32';
}

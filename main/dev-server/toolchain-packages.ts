import type { HostToolName } from './toolchain-detect';

/**
 * PURE. The ONE table of "which package manager can install which tool, and by
 * what package name."
 *
 * This exists as its own module for a single reason: two places need this fact
 * and they must never disagree. The PLANNER (`toolchain-plan.ts`) chooses the
 * `pm` method only for a tool a package manager can actually install; the
 * ADAPTER (`toolchain-adapters.ts`) then has to produce the concrete
 * `winget install --id …` for exactly that set. If the planner's idea of "winget
 * can do php" and the adapter's list of winget packages ever drifted apart, the
 * plan would emit a `pm` step the adapter could not build — a gap that only
 * shows up on the one Windows machine without Herd. Deriving BOTH from this map
 * makes that class of bug unrepresentable.
 *
 * ## The gaps are deliberate
 *
 * `winget` has no first-class **php** or **composer** package, so they are absent
 * here — which is precisely what routes them to the direct-download path on
 * Windows (the real path there; Herd's php is detected and reused when present).
 * brew/apt/dnf ship all of them, so only winget carries the hole.
 */

/** A package manager the toolchain installer can drive. */
export type PackageManager = 'winget' | 'brew' | 'apt' | 'dnf';

export interface PmPackage {
    /** The identifier this package manager installs the tool by. */
    id: string;
    /** brew ONLY: a cask (a GUI app like Docker Desktop) rather than a formula. */
    cask?: boolean;
}

/**
 * Per-manager package identity for each installable tool.
 *
 * `npm` maps to the SAME package as `node` on winget/brew because npm ships
 * inside node there. The PLANNER reads this table to mark the second of two
 * steps that name one package as covered by the first (`InstallStep.coveredBy`),
 * so the package installs once — installing it twice is what made winget answer
 * "existing package already installed" with a non-zero exit and fail npm
 * (genie#209). apt/dnf expose a real standalone `npm`, so they name it directly.
 * The agent TUIs (`claude-code`, `codex`) are absent from every manager: they
 * install via `npm i -g`, never a system PM (see `NPM_PACKAGES` in the adapter).
 */
export const PM_PACKAGES: Record<PackageManager, Partial<Record<HostToolName, PmPackage>>> = {
    winget: {
        git: { id: 'Git.Git' },
        node: { id: 'OpenJS.NodeJS.LTS' },
        npm: { id: 'OpenJS.NodeJS.LTS' },
        docker: { id: 'Docker.DockerDesktop' },
        // php + composer: no reliable winget package → direct download.
    },
    brew: {
        git: { id: 'git' },
        node: { id: 'node' },
        npm: { id: 'node' },
        php: { id: 'php' },
        composer: { id: 'composer' },
        docker: { id: 'docker', cask: true },
    },
    apt: {
        git: { id: 'git' },
        node: { id: 'nodejs' },
        npm: { id: 'npm' },
        php: { id: 'php-cli' },
        composer: { id: 'composer' },
        docker: { id: 'docker.io' },
    },
    dnf: {
        git: { id: 'git' },
        node: { id: 'nodejs' },
        npm: { id: 'npm' },
        php: { id: 'php-cli' },
        composer: { id: 'composer' },
        docker: { id: 'docker' },
    },
};

/** Can this package manager install this tool? The planner's `pm`-vs-`direct`
 *  decision reduces to exactly this question. */
export function pmCanInstall(pm: PackageManager, tool: HostToolName): boolean {
    return PM_PACKAGES[pm][tool] !== undefined;
}

/** The package to install, or undefined when this manager cannot. */
export function pmPackageFor(pm: PackageManager, tool: HostToolName): PmPackage | undefined {
    return PM_PACKAGES[pm][tool];
}

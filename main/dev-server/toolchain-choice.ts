import type { CommandRunner } from './container-runtime';
import { parseToolVersion } from './toolchain-detect';
import type { HostToolName } from './toolchain-detect';
import type { InstallMethod, InstallStep } from './toolchain-plan';
import type { PackageManager } from './toolchain-packages';

/**
 * PURE (choice) and seamed (availability). Phase 3 of #240 — decide WHICH
 * package manager to offer, and turn a plan into the object a user consents to.
 *
 * The UI on top of this is deliberately thin: a picker that preselects
 * `recommended` and a consent panel that renders `summarizeInstallPlan`. Every
 * decision that matters — is winget even here, does this plan need a reboot —
 * is made here where it can be tested without a renderer.
 */

// --- which managers are available ------------------------------------------

/** The managers worth probing on each platform. A machine is not asked about a
 *  manager that cannot exist there (no brew probe on Windows). */
const PM_CANDIDATES: Record<string, PackageManager[]> = {
    win32: ['winget'],
    darwin: ['brew'],
    // apt first: when a box improbably has both, Debian/Ubuntu's is the one a
    // user is more likely to expect, and the choice must be deterministic.
    linux: ['apt', 'dnf'],
};

/** The bin each manager answers to. `apt` is driven as `apt-get` (its `apt`
 *  front-end warns on non-interactive use). */
const PM_BIN: Record<PackageManager, string> = {
    winget: 'winget',
    brew: 'brew',
    apt: 'apt-get',
    dnf: 'dnf',
};

export interface PackageManagerProbe {
    pm: PackageManager;
    available: boolean;
    version?: string;
}

export interface PackageManagerChoices {
    os: string;
    /** Managers that exist here, in candidate (preference) order. */
    available: PackageManager[];
    /** The manager to preselect, or undefined when there is none. */
    recommended?: PackageManager;
    /**
     * What to hand `planToolchainInstall` as `pmChoice` unless the user
     * overrides — the recommended manager, or `direct` when none exists.
     * `direct` is always a valid floor: the universal download fallback.
     */
    defaultChoice: PackageManager | 'direct';
    probes: PackageManagerProbe[];
}

export interface AvailablePmOptions {
    runner: CommandRunner;
    os?: NodeJS.Platform | string;
    /** Override the bin for one manager (a non-PATH install). */
    binFor?: (pm: PackageManager) => string;
}

/**
 * Ask the machine which of its platform's package managers actually respond.
 *
 * Never throws — an absent manager is the ordinary state that routes to
 * `direct`, exactly as an absent tool is in {@link import('./toolchain-detect')}.
 */
export async function availablePackageManagers(
    opts: AvailablePmOptions,
): Promise<PackageManagerChoices> {
    const os = String(opts.os ?? process.platform);
    const candidates = PM_CANDIDATES[os] ?? [];

    const probes: PackageManagerProbe[] = [];
    for (const pm of candidates) {
        probes.push(await probePackageManager(pm, opts.runner, opts.binFor?.(pm)));
    }

    const available = probes.filter((p) => p.available).map((p) => p.pm);
    const recommended = available[0];
    return {
        os,
        available,
        ...(recommended ? { recommended } : {}),
        defaultChoice: recommended ?? 'direct',
        probes,
    };
}

async function probePackageManager(
    pm: PackageManager,
    runner: CommandRunner,
    bin: string = PM_BIN[pm],
): Promise<PackageManagerProbe> {
    try {
        const res = await runner.run(bin, ['--version']);
        const available = res.code === 0 && !!res.stdout.trim();
        if (!available) return { pm, available: false };
        const version = parseToolVersion(res.stdout);
        return { pm, available: true, ...(version ? { version } : {}) };
    } catch {
        return { pm, available: false };
    }
}

// --- consent ---------------------------------------------------------------

/** One row of the consent panel. */
export interface ConsentLine {
    tool: HostToolName;
    method: InstallMethod;
    packageManager?: PackageManager;
    requiresElevation: boolean;
    requiresRestart: boolean;
}

/**
 * The reviewable object a user approves BEFORE anything runs.
 *
 * It carries not just the list but the two costs that must never be a surprise —
 * whether the run will raise an elevation prompt, and whether it will demand a
 * reboot — each with the tools responsible, so the panel can say WHY rather than
 * just flip a flag.
 */
export interface ConsentSummary {
    count: number;
    installs: ConsentLine[];
    requiresElevation: boolean;
    requiresRestart: boolean;
    /** Tools whose install needs elevation — the "why" behind the flag. */
    elevated: HostToolName[];
    /** Tools whose install needs a machine restart. */
    restarts: HostToolName[];
}

/** Fold a plan into its consent summary. Pure — the same plan always summarises
 *  the same way, which is what lets the panel be a render of this and nothing more. */
export function summarizeInstallPlan(steps: InstallStep[]): ConsentSummary {
    const installs: ConsentLine[] = steps.map((s) => ({
        tool: s.tool,
        method: s.method,
        ...(s.packageManager ? { packageManager: s.packageManager } : {}),
        requiresElevation: s.requiresElevation,
        requiresRestart: s.requiresRestart,
    }));
    const elevated = steps.filter((s) => s.requiresElevation).map((s) => s.tool);
    const restarts = steps.filter((s) => s.requiresRestart).map((s) => s.tool);
    return {
        count: installs.length,
        installs,
        requiresElevation: elevated.length > 0,
        requiresRestart: restarts.length > 0,
        elevated,
        restarts,
    };
}

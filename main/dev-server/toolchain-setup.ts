import type { CommandRunner } from './container-runtime';
import { detectToolchain, DEFAULT_TOOLCHAIN } from './toolchain-detect';
import type { HostToolName, ToolchainReport } from './toolchain-detect';
import { availablePackageManagers } from './toolchain-choice';
import type { ConsentSummary, PackageManagerChoices } from './toolchain-choice';
import { planToolchainInstall } from './toolchain-plan';
import type { InstallStep } from './toolchain-plan';
import { summarizeInstallPlan } from './toolchain-choice';
import type { PackageManager } from './toolchain-packages';

/**
 * The composition FACADE of the zero-setup toolchain (Tynn #240).
 *
 * Everything below this is a decision unit — detect, availablePackageManagers,
 * planToolchainInstall, summarizeInstallPlan — and this ties them into the ONE
 * question the first-run wizard opens with: *what does this machine have, what
 * will Genie install, and what will it cost?* It reads only (it installs
 * nothing), and it inherits the never-throws contract of the units it composes,
 * so a wizard can render its result without a try/catch.
 *
 * The install half is deliberately NOT here — `runInstallPlan`
 * (`toolchain-install.ts`) already is it, gated on the consent this inspection
 * produces. Keeping "look" and "run" apart is what lets the UI show the plan and
 * wait for a yes before anything happens.
 */

export interface InspectToolchainOptions {
    runner: CommandRunner;
    os?: NodeJS.Platform | string;
    /** For the direct-download URLs the plan may reference later. */
    arch?: NodeJS.Architecture | string;
    /** Which tools to consider — defaults to the full {@link DEFAULT_TOOLCHAIN}. */
    wanted?: readonly HostToolName[];
    /** Force a package-manager (or `direct`). Omit to use the detected
     *  recommendation (or `direct` when the machine has no manager). */
    pmChoice?: PackageManager | 'direct';
}

/** The full picture the wizard renders: what is here, what could install it,
 *  the plan for the missing set, and the consent object to approve. */
export interface ToolchainInspection {
    os: string;
    arch?: string;
    /** Detection — every wanted tool present/missing with a version. */
    report: ToolchainReport;
    /** Which package managers exist + the recommended default. */
    packageManagers: PackageManagerChoices;
    /** The manager (or `direct`) the plan below was built with. */
    pmChoice: PackageManager | 'direct';
    /** Ordered installs for the missing set. Empty ⇒ nothing to do. */
    plan: InstallStep[];
    /** The reviewable object a user approves before {@link plan} runs. */
    consent: ConsentSummary;
}

/**
 * Inspect the machine and produce a plan + consent, installing nothing.
 *
 * Detection and manager-availability are probed CONCURRENTLY — they are
 * independent reads over the same runner, and the wizard's first paint waits on
 * both. The chosen manager is the caller's override, else the detected
 * recommendation, else `direct` (the universal fallback), and the plan is built
 * with it.
 */
export async function inspectToolchain(opts: InspectToolchainOptions): Promise<ToolchainInspection> {
    const os = String(opts.os ?? process.platform);
    const wanted = opts.wanted ?? DEFAULT_TOOLCHAIN;

    const [report, packageManagers] = await Promise.all([
        detectToolchain({ runner: opts.runner, platform: os, wanted }),
        availablePackageManagers({ runner: opts.runner, os }),
    ]);

    const pmChoice = opts.pmChoice ?? packageManagers.defaultChoice;
    const plan = planToolchainInstall({ detected: report, os, pmChoice, wanted });
    const consent = summarizeInstallPlan(plan);

    return {
        os,
        ...(opts.arch ? { arch: String(opts.arch) } : {}),
        report,
        packageManagers,
        pmChoice,
        plan,
        consent,
    };
}

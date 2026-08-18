import type { CommandRunner } from './container-runtime';
import { defaultToolchainFor, detectToolchain, DEFAULT_TOOLCHAIN } from './toolchain-detect';
import type { FileExists, HostToolName, ToolchainReport } from './toolchain-detect';
import { fileExistsSeam } from './seams';
import { availablePackageManagers } from './toolchain-choice';
import type { ConsentSummary, PackageManagerChoices } from './toolchain-choice';
import { planToolchainInstall } from './toolchain-plan';
import type { InstallStep } from './toolchain-plan';
import { summarizeInstallPlan } from './toolchain-choice';
import type { PackageManager } from './toolchain-packages';
import { createLatestFor } from './toolchain-latest';
import { detectToolUpdates } from './toolchain-updates';
import type { OriginContext } from './tool-install-origin';
import type { ToolUpdate } from './toolchain-updates';

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
    /** Override the filesystem check a LIBRARY probe needs (tests inject one). */
    fileExists?: FileExists;
    /** Override the Windows system root a library probe looks under. */
    systemRoot?: string;
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
    // The SETUP default, not the manage-page one: on Windows it also carries the
    // VC++ runtime php cannot start without (genie#209).
    const wanted = opts.wanted ?? defaultToolchainFor(os);

    const [report, packageManagers] = await Promise.all([
        detectToolchain({
            runner: opts.runner,
            platform: os,
            wanted,
            fileExists: opts.fileExists ?? fileExistsSeam,
            ...(opts.systemRoot ?? process.env.SystemRoot
                ? { systemRoot: opts.systemRoot ?? String(process.env.SystemRoot) }
                : {}),
        }),
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

export interface DetectUpdatesOptions {
    runner: CommandRunner;
    os?: NodeJS.Platform | string;
    wanted?: readonly HostToolName[];
    /** Resolve a bin name to the binary PATH would run — what lets each row say
     *  who installed the tool and where (genie#213). */
    resolvePath?: (bin: string) => Promise<string | undefined>;
    /** Home + Genie's toolchain root, for classifying those paths. Without it
     *  the rows simply carry no origin. */
    origin?: OriginContext;
}

/**
 * Scan the installed toolchain for available updates — the Toolchain Manager's
 * "what's out of date?" read (#242).
 *
 * Composes the pieces: detect what's installed + which manager exists (both
 * cheap reads over the same runner), then fold the detection report through the
 * real {@link createLatestFor} — which queries that manager's outdated list ONCE
 * — into a per-tool update report. Only installed tools appear; a machine with a
 * manager that isn't reachable, or nothing installed, scans to an empty report
 * rather than an error (the never-throws contract, all the way up).
 */
export async function detectToolchainUpdates(opts: DetectUpdatesOptions): Promise<ToolUpdate[]> {
    const os = String(opts.os ?? process.platform);
    const wanted = opts.wanted ?? DEFAULT_TOOLCHAIN;

    const [report, packageManagers] = await Promise.all([
        detectToolchain({
            runner: opts.runner,
            platform: os,
            wanted,
            ...(opts.resolvePath ? { resolvePath: opts.resolvePath } : {}),
        }),
        availablePackageManagers({ runner: opts.runner, os }),
    ]);

    const latestFor = createLatestFor({
        runner: opts.runner,
        ...(packageManagers.recommended ? { pm: packageManagers.recommended } : {}),
    });
    return detectToolUpdates(report, latestFor, opts.origin);
}

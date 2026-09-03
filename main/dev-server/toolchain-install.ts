import type { HostToolName } from './toolchain-detect';
import type { InstallStep } from './toolchain-plan';
import { buildInstallCommand } from './toolchain-adapters';
import type { AdapterContext, InstallCommand, InstallIntent } from './toolchain-adapters';

/**
 * The install EXECUTOR core — pure orchestration over a single injected effect.
 *
 * Everything here is a decision, and decisions are what deserve tests: run the
 * consented plan in order; refuse to run at all without consent; skip a tool
 * whose prerequisite failed rather than let it fail confusingly on its own; and
 * report whether a reboot is now pending. The one impure thing — actually
 * running `winget`, downloading an installer, raising a UAC prompt — is the
 * {@link PerformInstall} effect, faked in these tests and real in the wizard's
 * main-process wiring (#686). Splitting it this way is what lets the hard part
 * (the ordering + dependency logic) be proven without a machine that can install
 * anything.
 *
 * Contract, same as the rest of #240: NEVER throws. A failed step — even an
 * effect that rejects — is a per-tool `failed`, and the run carries on to the
 * steps that do not depend on it.
 */

export type StepStatus = 'succeeded' | 'failed' | 'skipped';

/** What the effect reports for one command. Never rejects by contract, but the
 *  executor defends against one that does. */
export interface StepOutcome {
    ok: boolean;
    /** Redacted failure detail, when `ok` is false. */
    error?: string;
    /** The version the effect verified after installing, when it could. */
    version?: string;
    /**
     * What the post-install PROBE established — three states, deliberately.
     *
     * `true`   the probe ran and found the tool.
     * `false`  the probe ran and did NOT find it. The step still succeeded (see
     *          `performRun`: gating on the probe is genie#209), but nothing has
     *          confirmed the install, and a run that says "all set" off the back
     *          of it is reporting a success it has not verified.
     * absent   there was no verifier to ask. That is no evidence about the tool
     *          and must never be reported as if the tool were missing.
     */
    verified?: boolean;
}

/** The single impure seam: carry out ONE materialised command. */
export type PerformInstall = (command: InstallCommand) => Promise<StepOutcome>;

export interface StepResult {
    tool: HostToolName;
    status: StepStatus;
    error?: string;
    version?: string;
    /** What the post-install probe established — see {@link StepOutcome.verified}.
     *  A `succeeded` step with `verified: false` is an install NOTHING has
     *  confirmed; whoever reports the run has to say so rather than call it done. */
    verified?: boolean;
}

/** Streamed as the run proceeds, so a wizard row can go live. `start` fires
 *  before the effect runs; `done` carries the settled status. A SKIPPED tool
 *  emits only `done` — nothing ran for it. */
export interface InstallProgress {
    tool: HostToolName;
    phase: 'start' | 'done';
    status?: StepStatus;
}

export interface InstallRunResult {
    /** True iff EVERY step succeeded — a skip or a failure makes the run not-ok. */
    ok: boolean;
    results: StepResult[];
    /** Set when the run did nothing because consent was withheld. */
    refused?: 'not-approved';
    /** True when a step that requires a machine restart actually installed. */
    restartRequired: boolean;
    /** Tools skipped because a prerequisite was not satisfied. */
    skipped: HostToolName[];
}

export interface RunInstallPlanOptions {
    /** The consented plan, already ordered by the planner. */
    steps: InstallStep[];
    ctx: AdapterContext;
    perform: PerformInstall;
    /** The consent gate — nothing runs unless this is true. */
    approved: boolean;
    /** Tools already present, so their dependents' prerequisites are satisfied
     *  without a step for them. */
    present?: HostToolName[];
    /** Install a missing tool (default) or UPDATE a present one (#242 P2) — only
     *  changes the package-manager verb the adapter emits. */
    intent?: InstallIntent;
    onProgress?: (p: InstallProgress) => void;
}

/**
 * Run a consented plan. Pure but for {@link RunInstallPlanOptions.perform}.
 *
 * A tool becomes "satisfied" — able to satisfy a dependent — only by being
 * already present or by installing successfully here; a failed or skipped tool
 * does not, so its dependents skip in turn. Because the planner orders every
 * prerequisite before its dependents, one forward pass is enough.
 */
export async function runInstallPlan(opts: RunInstallPlanOptions): Promise<InstallRunResult> {
    if (!opts.approved) {
        return { ok: false, refused: 'not-approved', results: [], restartRequired: false, skipped: [] };
    }

    const satisfied = new Set<HostToolName>(opts.present ?? []);
    const results: StepResult[] = [];
    const skipped: HostToolName[] = [];
    let restartRequired = false;

    for (const planned of opts.steps) {
        // Coverage is only ever a shortcut past work that ALREADY succeeded. If
        // the covering step did not, this step goes back to its real command
        // rather than confirming a tool nothing installed.
        const step =
            planned.coveredBy && !satisfied.has(planned.coveredBy)
                ? withoutCoverage(planned)
                : planned;
        const unmet = step.dependsOn.some((dep) => !satisfied.has(dep));
        if (unmet) {
            skipped.push(step.tool);
            results.push({ tool: step.tool, status: 'skipped' });
            opts.onProgress?.({ tool: step.tool, phase: 'done', status: 'skipped' });
            continue;
        }

        opts.onProgress?.({ tool: step.tool, phase: 'start' });
        const outcome = await performStep(step, opts.ctx, opts.perform, opts.intent ?? 'install');
        const status: StepStatus = outcome.ok ? 'succeeded' : 'failed';
        results.push({
            tool: step.tool,
            status,
            ...(outcome.error ? { error: outcome.error } : {}),
            ...(outcome.version ? { version: outcome.version } : {}),
            // Carried, never acted on. The line below is the genie#209 guard: a
            // tool the probe could not see is STILL satisfied, because the probe
            // is blind to a `.cmd` shim and to a PATH entry that only a new
            // terminal has. What `verified` changes is what the run can honestly
            // SAY afterwards, not which steps run.
            ...(outcome.verified === undefined ? {} : { verified: outcome.verified }),
        });
        if (outcome.ok) {
            satisfied.add(step.tool);
            if (step.requiresRestart) restartRequired = true;
        }
        opts.onProgress?.({ tool: step.tool, phase: 'done', status });
    }

    return {
        ok: results.every((r) => r.status === 'succeeded'),
        results,
        restartRequired,
        skipped,
    };
}

/** The step as it would have been planned with nothing to lean on. Rebuilt
 *  without the key rather than set to undefined, so the shape stays exact. */
function withoutCoverage(step: InstallStep): InstallStep {
    const { coveredBy: _coveredBy, ...rest } = step;
    return rest;
}

/** Materialise + perform one step, turning any throw — from the adapter or a
 *  misbehaving effect — into a failed outcome rather than a crash. */
async function performStep(
    step: InstallStep,
    ctx: AdapterContext,
    perform: PerformInstall,
    intent: InstallIntent,
): Promise<StepOutcome> {
    let command: InstallCommand;
    try {
        command = buildInstallCommand(step, ctx, intent);
    } catch (e) {
        return { ok: false, error: `could not build install command: ${String(e)}` };
    }
    try {
        return await perform(command);
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

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
}

/** The single impure seam: carry out ONE materialised command. */
export type PerformInstall = (command: InstallCommand) => Promise<StepOutcome>;

export interface StepResult {
    tool: HostToolName;
    status: StepStatus;
    error?: string;
    version?: string;
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

    for (const step of opts.steps) {
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

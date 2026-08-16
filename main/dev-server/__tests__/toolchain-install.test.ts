import { describe, expect, it } from 'vitest';
import type { HostToolName, HostToolProbe, ToolchainReport } from '../toolchain-detect';
import { DEFAULT_TOOLCHAIN } from '../toolchain-detect';
import { planToolchainInstall } from '../toolchain-plan';
import type { InstallStep } from '../toolchain-plan';
import type { InstallCommand } from '../toolchain-adapters';
import { runInstallPlan } from '../toolchain-install';
import type { InstallProgress, StepOutcome } from '../toolchain-install';

/**
 * The executor CORE is pure orchestration over one injected effect. Everything
 * that is a DECISION — the order, the consent gate, skipping a dependent whose
 * prerequisite failed, whether a reboot is now pending — lives here and is tested
 * with a fake `perform`; the impure part (actually running winget / downloading
 * an installer / prompting for elevation) is the single seam behind it, tested on
 * CI. The contract mirrors the rest of #240: a failed install is a per-tool
 * result, never a thrown exception that takes the whole run down.
 */

const OK: StepOutcome = { ok: true };
const FAIL: StepOutcome = { ok: false, error: 'exit 1' };

const step = (over: Partial<InstallStep> & Pick<InstallStep, 'tool'>): InstallStep => ({
    method: 'pm',
    packageManager: 'winget',
    requiresElevation: false,
    requiresRestart: false,
    dependsOn: [],
    ...over,
});

/** A `perform` that returns a fixed outcome per tool (default OK), recording
 *  which commands it was actually asked to run. */
function performing(outcomes: Partial<Record<HostToolName, StepOutcome>> = {}) {
    const ran: InstallCommand[] = [];
    const perform = async (command: InstallCommand): Promise<StepOutcome> => {
        ran.push(command);
        return outcomes[command.tool] ?? OK;
    };
    return { perform, ran };
}

const WIN = { os: 'win32' as const };

describe('runInstallPlan — orchestration', () => {
    it('runs every step in order and reports each tool succeeded', async () => {
        const { perform, ran } = performing();
        const result = await runInstallPlan({
            steps: [step({ tool: 'git' }), step({ tool: 'node' }), step({ tool: 'docker' })],
            ctx: WIN,
            approved: true,
            perform,
        });
        expect(result.ok).toBe(true);
        expect(result.results.map((r) => [r.tool, r.status])).toEqual([
            ['git', 'succeeded'],
            ['node', 'succeeded'],
            ['docker', 'succeeded'],
        ]);
        expect(ran.map((c) => c.tool)).toEqual(['git', 'node', 'docker']);
    });

    it('refuses to run anything without consent', async () => {
        const { perform, ran } = performing();
        const result = await runInstallPlan({
            steps: [step({ tool: 'git' })],
            ctx: WIN,
            approved: false,
            perform,
        });
        expect(result.ok).toBe(false);
        expect(result.refused).toBe('not-approved');
        expect(ran).toEqual([]);
        expect(result.results).toEqual([]);
    });

    it('emits a start then a done event for each tool that runs', async () => {
        const events: InstallProgress[] = [];
        await runInstallPlan({
            steps: [step({ tool: 'git' }), step({ tool: 'node' })],
            ctx: WIN,
            approved: true,
            perform: performing().perform,
            onProgress: (p) => events.push(p),
        });
        expect(events).toEqual([
            { tool: 'git', phase: 'start' },
            { tool: 'git', phase: 'done', status: 'succeeded' },
            { tool: 'node', phase: 'start' },
            { tool: 'node', phase: 'done', status: 'succeeded' },
        ]);
    });

    it('materialises each step into its real command before performing it', async () => {
        const { perform, ran } = performing();
        await runInstallPlan({
            steps: [step({ tool: 'git', method: 'pm', packageManager: 'winget' })],
            ctx: WIN,
            approved: true,
            perform,
        });
        expect(ran[0]).toMatchObject({ via: 'run', command: 'winget' });
        expect((ran[0] as { args: string[] }).args).toContain('Git.Git');
    });

    it('carries a version the effect read back onto the result', async () => {
        const result = await runInstallPlan({
            steps: [step({ tool: 'git' })],
            ctx: WIN,
            approved: true,
            perform: async () => ({ ok: true, version: '2.45.0' }),
        });
        expect(result.results[0].version).toBe('2.45.0');
    });
});

describe('runInstallPlan — dependencies', () => {
    it('skips a dependent whose prerequisite failed, but runs independent steps', async () => {
        const { perform, ran } = performing({ node: FAIL });
        const result = await runInstallPlan({
            steps: [
                step({ tool: 'git' }),
                step({ tool: 'node' }),
                step({ tool: 'npm', dependsOn: ['node'] }),
                step({ tool: 'claude-code', method: 'npm-global', packageManager: undefined, dependsOn: ['npm'] }),
                step({ tool: 'docker' }),
            ],
            ctx: WIN,
            approved: true,
            perform,
        });
        const byTool = Object.fromEntries(result.results.map((r) => [r.tool, r.status]));
        expect(byTool).toEqual({
            git: 'succeeded',
            node: 'failed',
            npm: 'skipped',
            'claude-code': 'skipped',
            docker: 'succeeded',
        });
        expect(result.skipped).toEqual(['npm', 'claude-code']);
        expect(result.ok).toBe(false);
        // The skipped tools were never handed to the effect.
        expect(ran.map((c) => c.tool)).toEqual(['git', 'node', 'docker']);
    });

    it('treats an already-present prerequisite as satisfied', async () => {
        const { perform, ran } = performing();
        const result = await runInstallPlan({
            steps: [step({ tool: 'codex', method: 'npm-global', packageManager: undefined, dependsOn: ['npm'] })],
            ctx: WIN,
            approved: true,
            present: ['npm'],
            perform,
        });
        expect(result.results[0].status).toBe('succeeded');
        expect(ran.map((c) => c.tool)).toEqual(['codex']);
    });

    it('skips a dependent when its prerequisite is neither present nor in the plan', async () => {
        const { perform, ran } = performing();
        const result = await runInstallPlan({
            steps: [step({ tool: 'codex', method: 'npm-global', packageManager: undefined, dependsOn: ['npm'] })],
            ctx: WIN,
            approved: true,
            present: [],
            perform,
        });
        expect(result.results[0].status).toBe('skipped');
        expect(ran).toEqual([]);
    });
});

/**
 * The clean-Windows-machine regression (genie#209).
 *
 * winget has no standalone npm — node and npm are both `OpenJS.NodeJS.LTS` — so
 * the plan for a fresh machine contains two steps that resolve to ONE package.
 * Installing it twice is what made winget answer "existing package already
 * installed" with a non-zero exit, fail the npm step, and skip both agent TUIs.
 *
 * Built from the REAL planner rather than hand-written steps: the bug lived in
 * the gap BETWEEN planning and executing, so a test that fakes the plan cannot
 * see it.
 */
describe('runInstallPlan — a shared package installs exactly once', () => {
    const freshWindows = (): ToolchainReport => ({
        platform: 'win32',
        probes: DEFAULT_TOOLCHAIN.map((name): HostToolProbe => ({ name, installed: false })),
        present: [],
        missing: [...DEFAULT_TOOLCHAIN],
    });

    it('runs OpenJS.NodeJS.LTS once for node+npm, and still reports npm succeeded', async () => {
        const { perform, ran } = performing();
        const steps = planToolchainInstall({
            detected: freshWindows(),
            os: 'win32',
            pmChoice: 'winget',
            wanted: ['node', 'npm', 'claude-code'],
        });

        const result = await runInstallPlan({ steps, ctx: WIN, approved: true, perform });

        const wingetRuns = ran.filter(
            (c) => c.via === 'run' && c.args.includes('OpenJS.NodeJS.LTS'),
        );
        expect(wingetRuns).toHaveLength(1);
        expect(wingetRuns[0].tool).toBe('node');

        // npm is still a reported row, and it did not fail — which is what kept
        // claude-code from being skipped.
        expect(result.results.map((r) => [r.tool, r.status])).toEqual([
            ['node', 'succeeded'],
            ['npm', 'succeeded'],
            ['claude-code', 'succeeded'],
        ]);
        expect(result.skipped).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it('asks the effect to CONFIRM the covered tool rather than install it again', async () => {
        const { perform, ran } = performing();
        const steps = planToolchainInstall({
            detected: freshWindows(),
            os: 'win32',
            pmChoice: 'winget',
            wanted: ['node', 'npm'],
        });
        await runInstallPlan({ steps, ctx: WIN, approved: true, perform });

        const npmCommand = ran.find((c) => c.tool === 'npm')!;
        expect(npmCommand.via).toBe('verify');
        if (npmCommand.via === 'verify') expect(npmCommand.coveredBy).toBe('node');
    });

    it('never marks a covered tool done off a FAILED install', async () => {
        const { perform, ran } = performing({ node: FAIL });
        const steps = planToolchainInstall({
            detected: freshWindows(),
            os: 'win32',
            pmChoice: 'winget',
            wanted: ['node', 'npm'],
        });
        const result = await runInstallPlan({ steps, ctx: WIN, approved: true, perform });
        // npm depends on node, so it skips — but crucially it is NOT confirmed.
        expect(result.results.map((r) => [r.tool, r.status])).toEqual([
            ['node', 'failed'],
            ['npm', 'skipped'],
        ]);
        expect(ran.every((c) => c.via !== 'verify')).toBe(true);
    });

    it('falls back to the real install when the coverer is neither satisfied nor a prerequisite', async () => {
        // Defensive: coverage is only ever a shortcut past work that ALREADY
        // happened. With no dependency to skip on, an unsatisfied coverer must
        // put the step back on the real command rather than confirm thin air.
        const { perform, ran } = performing();
        const result = await runInstallPlan({
            steps: [step({ tool: 'npm', coveredBy: 'node' })],
            ctx: WIN,
            approved: true,
            perform,
        });
        expect(ran[0].via).toBe('run');
        expect(result.results[0].status).toBe('succeeded');
    });
});

describe('runInstallPlan — restart', () => {
    it('flags a restart only when a step that NEEDS one actually succeeded', async () => {
        const done = await runInstallPlan({
            steps: [step({ tool: 'docker', requiresRestart: true })],
            ctx: WIN,
            approved: true,
            perform: performing().perform,
        });
        expect(done.restartRequired).toBe(true);

        const failed = await runInstallPlan({
            steps: [step({ tool: 'docker', requiresRestart: true })],
            ctx: WIN,
            approved: true,
            perform: performing({ docker: FAIL }).perform,
        });
        // Docker did not install, so no reboot is pending.
        expect(failed.restartRequired).toBe(false);
    });
});

describe('runInstallPlan — resilience', () => {
    it('never throws when the effect rejects — the tool just fails', async () => {
        const result = await runInstallPlan({
            steps: [step({ tool: 'git' }), step({ tool: 'node' })],
            ctx: WIN,
            approved: true,
            perform: async (c) => {
                if (c.tool === 'git') throw new Error('boom');
                return OK;
            },
        });
        expect(result.results.map((r) => [r.tool, r.status])).toEqual([
            ['git', 'failed'],
            ['node', 'succeeded'],
        ]);
        expect(result.ok).toBe(false);
    });
});

/**
 * The Toolchain Manager (#242 P2) runs a single-tool UPDATE through this same
 * executor, passing intent:'update' so the materialised command upgrades a
 * present tool rather than installing it. Default (no intent) stays 'install'.
 */
describe('runInstallPlan — update intent', () => {
    it('threads intent:update into the materialised command (winget upgrade)', async () => {
        const { perform, ran } = performing();
        await runInstallPlan({
            steps: [step({ tool: 'git', method: 'pm', packageManager: 'winget' })],
            ctx: WIN,
            approved: true,
            perform,
            intent: 'update',
        });
        const cmd = ran[0];
        expect(cmd.via).toBe('run');
        if (cmd.via === 'run') expect(cmd.args[0]).toBe('upgrade');
    });

    it('defaults to an install command when no intent is given', async () => {
        const { perform, ran } = performing();
        await runInstallPlan({
            steps: [step({ tool: 'git', method: 'pm', packageManager: 'winget' })],
            ctx: WIN,
            approved: true,
            perform,
        });
        const cmd = ran[0];
        if (cmd.via === 'run') expect(cmd.args[0]).toBe('install');
    });
});

/**
 * A prerequisite that fails must not leave php failing for a mystery reason
 * (genie#209). The VC++ runtime is modelled as a dependency, so the executor's
 * existing skip logic carries it — which is the point of modelling it that way
 * rather than burying it in the php installer.
 */
describe('runInstallPlan — a failed VC++ runtime skips php', () => {
    it('skips php, and composer after it, when the runtime could not install', async () => {
        const { perform, ran } = performing({ vcredist: FAIL });
        const result = await runInstallPlan({
            steps: [
                step({ tool: 'vcredist' }),
                step({ tool: 'php', method: 'direct', packageManager: undefined, dependsOn: ['vcredist'] }),
                step({ tool: 'composer', method: 'direct', packageManager: undefined, dependsOn: ['php'] }),
                step({ tool: 'git' }),
            ],
            ctx: WIN,
            approved: true,
            perform,
        });
        expect(result.results.map((r) => [r.tool, r.status])).toEqual([
            ['vcredist', 'failed'],
            ['php', 'skipped'],
            ['composer', 'skipped'],
            ['git', 'succeeded'],
        ]);
        // php was never attempted — no half-installed PHP that cannot start.
        expect(ran.map((c) => c.tool)).toEqual(['vcredist', 'git']);
    });

    it('installs php when the runtime was already present', async () => {
        const { perform } = performing();
        const result = await runInstallPlan({
            steps: [step({ tool: 'php', method: 'direct', packageManager: undefined, dependsOn: ['vcredist'] })],
            ctx: WIN,
            approved: true,
            present: ['vcredist'],
            perform,
        });
        expect(result.results[0].status).toBe('succeeded');
    });
});

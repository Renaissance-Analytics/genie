import { describe, expect, it } from 'vitest';
import type { HostToolName } from '../toolchain-detect';
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliUpdateDue, runStartupUpdates, startupTasks, STARTUP_UPDATES_LIMIT_MS, type StartupProgress, type StartupTaskPorts, type StartupUpdatePorts, type StartupUpdateTask } from '../src/core/startup-updates.js';
import type { ProviderHealth } from '../src/core/provider-health.js';

/**
 * DUE UPDATES AT HOST START, BEFORE ANYTHING ELSE (Tynn #1067, owner 2026-11-26: "the genie should be handling cli upgrades
 * automatically on startup before any other processes start happening"). genie-host applies the provider CLI updates and the
 * PHP patch updates that are due, says each step to any window, and has a time limit: past it the host starts as usual and
 * says so. Pure: the tasks, the clock and the progress are ports.
 */

afterEach(() => { vi.useRealTimers(); });

const health = (over: Partial<ProviderHealth> = {}): ProviderHealth => ({ provider: 'claude', ok: true, installed: true, signedIn: true, version: '2.1.0 (Claude Code)', program: '/home/t/.local/bin/claude', fault: null, words: null, checkedAt: 1, ...over });

describe('which CLI update is due', () => {
    it('due only when the installed version is OLDER than the latest; equal, newer, unknown or not installed → not due', () => {
        expect(cliUpdateDue(health(), '2.2.0')).toBe(true);
        expect(cliUpdateDue(health({ version: '2.2.0 (Claude Code)' }), '2.2.0')).toBe(false);
        expect(cliUpdateDue(health({ version: '2.3.0' }), '2.2.0')).toBe(false);
        expect(cliUpdateDue(health(), null)).toBe(false);
        expect(cliUpdateDue(health({ version: null }), '2.2.0')).toBe(false);
        expect(cliUpdateDue(health({ installed: false }), '2.2.0')).toBe(false);
        expect(cliUpdateDue(null, '2.2.0')).toBe(false);
        // codex prints `codex-cli 0.40.0`
        expect(cliUpdateDue(health({ provider: 'codex', version: 'codex-cli 0.40.0' }), '0.41.0')).toBe(true);
    });
});

describe('the tasks a start runs', () => {
    const base = (over: Partial<StartupTaskPorts> = {}): StartupTaskPorts => ({
        providers: [{ provider: 'claude', label: 'Claude Code', npmPackage: '@anthropic-ai/claude-code' }, { provider: 'codex', label: 'Codex', npmPackage: '@openai/codex' }],
        check: async (p) => (p === 'claude' ? health() : health({ provider: 'codex', version: 'codex-cli 0.41.0' })),
        latest: async (pkg) => (pkg === '@anthropic-ai/claude-code' ? '2.2.0' : '0.41.0'),
        update: async () => ({ kind: 'repaired', from: '2.1.0', to: '2.2.0' }),
        ...over,
    });

    it('one task per CLI that is due (Claude Code here; Codex is current), named with its versions; then PHP when the hook is there', async () => {
        const applied: string[] = [];
        const tasks = await startupTasks(base({ php: async () => { applied.push('php'); return { updated: ['8.4.14'], failed: [] }; } }));
        expect(tasks.map((t) => t.label)).toEqual(['Updating Claude Code 2.1.0 → 2.2.0', 'Applying PHP security updates']);
        expect(await tasks[1]!.run(() => {})).toBe('PHP updated: 8.4.14');
        expect(applied).toEqual(['php']);
    });

    it('no PHP hook in this build: no PHP task (the CLI tasks are unchanged)', async () => {
        expect((await startupTasks(base())).map((t) => t.label)).toEqual(['Updating Claude Code 2.1.0 → 2.2.0']);
    });

    it('a CLI task that does not take is a failure in words; a check or a latest that throws makes no task (never blocks the start)', async () => {
        const tasks = await startupTasks(base({ update: async () => ({ kind: 'unchanged', installed: '2.1.0', reason: 'claude update exited 1' }) }));
        await expect(tasks[0]!.run(() => {})).rejects.toThrow('claude update exited 1');
        const none = await startupTasks(base({ check: async () => { throw new Error('no claude'); }, latest: async () => { throw new Error('offline'); } }));
        expect(none).toEqual([]);
    });

    it('PHP failures are said, version by version', async () => {
        const tasks = await startupTasks(base({ latest: async () => null, php: async () => ({ updated: [], failed: [{ version: '8.3.20', reason: 'checksum mismatch' }] }) }));
        await expect(tasks[0]!.run(() => {})).rejects.toThrow('8.3.20: checksum mismatch');
    });
});

function rig(tasks: StartupUpdateTask[]) {
    const logs: string[] = [];
    const progress: Array<StartupProgress | null> = [];
    let now = 1_000;
    const ports: StartupUpdatePorts = {
        tasks: async () => tasks,
        progress: (p) => { progress.push(p); },
        log: (line) => { logs.push(line); },
        now: () => now,
    };
    return { ports, logs, progress, advance: (ms: number) => { now += ms; } };
}

describe('running them', () => {
    it('each task in order, its steps said, a failure not stopping the next; progress ends cleared; begin and done logged', async () => {
        const order: string[] = [];
        const r = rig([
            { label: 'Updating Claude Code 2.1.0 → 2.2.0', run: async (say) => { order.push('claude'); say('Running Claude Code’s installer'); return 'Claude Code 2.1.0 → 2.2.0'; } },
            { label: 'Updating Codex 0.40.0 → 0.41.0', run: async () => { order.push('codex'); throw new Error('installer exited 1'); } },
            { label: 'Applying PHP security updates', run: async () => { order.push('php'); return 'PHP updated: 8.4.14'; } },
        ]);
        const report = await runStartupUpdates(r.ports, 60_000);
        expect(order).toEqual(['claude', 'codex', 'php']);
        expect(report).toMatchObject({ timedOut: null, ran: [{ label: 'Updating Claude Code 2.1.0 → 2.2.0', words: 'Claude Code 2.1.0 → 2.2.0' }, { label: 'Applying PHP security updates' }], failed: [{ label: 'Updating Codex 0.40.0 → 0.41.0', reason: 'installer exited 1' }] });
        expect(r.progress.map((p) => p?.step ?? null)).toEqual(['Checking for tool updates', 'Updating Claude Code 2.1.0 → 2.2.0', 'Updating Claude Code 2.1.0 → 2.2.0: Running Claude Code’s installer', 'Updating Codex 0.40.0 → 0.41.0', 'Applying PHP security updates', null]);
        expect(r.progress[0]).toMatchObject({ startedAt: 1_000, limitMs: 60_000 });
        expect(r.logs[0]).toBe('startup updates: begin limit=60s');
        expect(r.logs).toContain('startup update failed: Updating Codex 0.40.0 → 0.41.0: installer exited 1');
        expect(r.logs.at(-1)).toMatch(/^startup updates: done ms=\d+ ran=2 failed=1$/);
    });

    it('nothing due: done at once, with nothing run', async () => {
        const r = rig([]);
        const report = await runStartupUpdates(r.ports);
        expect(report).toMatchObject({ ran: [], failed: [], timedOut: null });
        expect(r.logs.at(-1)).toMatch(/^startup updates: done ms=\d+ ran=0 failed=0$/);
        expect(r.progress.at(-1)).toBeNull();
    });

    it('THE TIME LIMIT: a task that never ends does not hold the host; at the limit it resolves, says so and clears progress; its late end is logged', async () => {
        vi.useFakeTimers();
        let finish!: (words: string) => void;
        // It says a step of its own first: the limit still names the TASK, not that step (the host row, 2026-11-26).
        const r = rig([{ label: 'Updating Claude Code 2.1.0 → 2.2.0', run: (say) => { say('Running Claude Code’s installer'); return new Promise<string>((ok) => { finish = ok; }); } }]);
        let settled = false;
        const pending = runStartupUpdates(r.ports, 30_000).then((report) => { settled = true; return report; });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const report = await pending;
        expect(report.timedOut).toBe('Updating Claude Code 2.1.0 → 2.2.0');
        expect(r.logs).toContain('startup updates: time limit 30s reached during "Updating Claude Code 2.1.0 → 2.2.0"; starting as usual');
        expect(r.progress.at(-1)).toBeNull();
        const count = r.progress.length;
        finish('Claude Code 2.1.0 → 2.2.0');
        await vi.advanceTimersByTimeAsync(0);
        // After the limit nothing is said to the windows any more; the late end goes to the log only.
        expect(r.progress.length).toBe(count);
        expect(r.logs.at(-1)).toBe('startup updates: after the limit: Updating Claude Code 2.1.0 → 2.2.0: Claude Code 2.1.0 → 2.2.0');
    });

    it('finding what is due counts against the limit too (an offline check that hangs)', async () => {
        vi.useFakeTimers();
        const r = rig([]);
        const ports: StartupUpdatePorts = { ...r.ports, tasks: () => new Promise(() => {}) };
        const pending = runStartupUpdates(ports, 5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        expect((await pending).timedOut).toBe('Checking for tool updates');
    });

    it('the default limit is three minutes', () => {
        expect(STARTUP_UPDATES_LIMIT_MS).toBe(180_000);
    });
});

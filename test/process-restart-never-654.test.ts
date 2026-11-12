import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { processTools } from '../src/main/mcp-tools-processes.js';
import { ProcessBook } from '../src/main/process-book.js';
import { ProcessBookReplica, ProcessesService } from '../src/main/processes-host.js';
import type { ProcessSpec, ProcessStatus, RestartPolicy } from '../src/main/process-supervisor.js';

/**
 * Tynn #654 / #706: an upgrade reran a completed RED job and a running gate, both restart:never,
 * and the RED job's `tee` truncated its evidence. Use the real persisted book and host/window
 * list, with a supervisor stub whose ONLY launch side effect is overwriting a disposable log.
 * No shell, pty, Electron, real process or provider is started by these tests.
 */
const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function supervisor(logFile: string) {
    const started: ProcessSpec[] = [];
    const statuses = new Map<string, ProcessStatus>();
    const listeners = new Set<(status: ProcessStatus) => void>();
    const set = (status: ProcessStatus) => {
        statuses.set(status.id, status);
        for (const listener of listeners) listener(status);
        return status;
    };
    return {
        started,
        start(spec: ProcessSpec): ProcessStatus {
            started.push(spec);
            // This is the destructive effect the real job's `tee` had on every launch.
            writeFileSync(logFile, `run ${started.length}: ${spec.name}\n`);
            return set({ id: spec.id, workspaceId: spec.workspaceId, name: spec.name, state: 'running', pid: 1234, exitCode: null, restarts: 0, since: 10 });
        },
        stop(id: string): boolean {
            const status = statuses.get(id);
            if (!status) return false;
            set({ ...status, state: 'stopped', pid: null });
            return true;
        },
        forget: (id: string) => statuses.delete(id),
        list: (workspaceId?: string) => [...statuses.values()].filter((s) => workspaceId === undefined || s.workspaceId === workspaceId),
        onChange(listener: (status: ProcessStatus) => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        finish(id: string, exitCode: number): void {
            set({ ...statuses.get(id)!, state: 'exited', pid: null, exitCode });
        },
    };
}

async function rig(restart: RestartPolicy = 'never') {
    const home = await mkdtemp(join(tmpdir(), 'genie-654-'));
    dirs.push(home);
    const logFile = join(home, 'last-run.log');
    const before = supervisor(logFile);
    const first = await ProcessBook.open(home, { supervisor: before, envFor: () => ({}), asleep: () => false });
    const process = await first.create({ workspaceId: 'ws', workspacePath: home, name: 'one-shot gate', command: 'gate', restart });
    let safe = false;
    let asleep = false;
    const after = supervisor(logFile);
    const open = () => ProcessBook.open(home, { supervisor: after, envFor: () => ({ CURRENT_ENV: 'yes' }), asleep: () => asleep, safeMode: () => safe, now: () => 20 });
    return { home, logFile, before, first, process, after, open, safe: (value: boolean) => { safe = value; }, asleep: (value: boolean) => { asleep = value; } };
}

describe('restart:never across a host launch (Tynn #654)', () => {
    it.each(['running at quit', 'completed successfully', 'completed with failure'] as const)('%s: never launches again, stays listed and leaves the last log byte-for-byte intact', async (state) => {
        const r = await rig();
        expect(r.before.started).toHaveLength(1); // Positive control: the first explicit add DID launch.
        if (state !== 'running at quit') r.before.finish(r.process.id, state === 'completed successfully' ? 0 : 1);
        const evidence = Buffer.from('original RED evidence\nassertion failed\n');
        writeFileSync(r.logFile, evidence);
        const keptBefore = await readFile(join(r.home, 'runtime', 'processes.json'), 'utf8');
        // A new book with a fresh supervisor is the host's upgrade/relaunch path.
        const book = await r.open();
        const result = book.restore();
        expect(r.after.started).toEqual([]);
        expect(result.started).toEqual([]);
        expect(book.list('ws')).toEqual([expect.objectContaining({ id: r.process.id, state: 'stopped', pid: null, durable: true, reason: expect.stringMatching(/stopped by restart/i) })]);
        expect(await readFile(r.logFile)).toEqual(evidence);
        expect(await readFile(join(r.home, 'runtime', 'processes.json'), 'utf8')).toBe(keptBefore);
        // A second launch must make the same decision, not consume a one-time suppression.
        (await r.open()).restore();
        expect(r.after.started).toEqual([]);
        expect(await readFile(r.logFile)).toEqual(evidence);
    });

    it.each(['on-failure', 'always'] as const)('%s retains its existing launch behaviour and reads the current environment', async (restart) => {
        const r = await rig(restart);
        const book = await r.open();
        expect(book.restore().started).toEqual([r.process.id]);
        expect(r.after.started).toEqual([expect.objectContaining({ id: r.process.id, restart, env: { CURRENT_ENV: 'yes' } })]);
        expect(book.list('ws')[0]).toMatchObject({ state: 'running' });
    });

    it.each(['never', 'on-failure', 'always'] as const)('%s stopped explicitly stays stopped without attributing the stop to a restart', async (restart) => {
        const r = await rig(restart);
        await r.first.stop(r.process.id);
        const book = await r.open();
        book.restore();
        expect(r.after.started).toEqual([]);
        expect(book.list('ws')[0]).toMatchObject({ state: 'stopped' });
        expect(book.list('ws')[0]?.reason).toBeUndefined();
    });

    it('the explicit Start and Restart actions still run a never process and clear the restart explanation', async () => {
        const r = await rig();
        const book = await r.open();
        book.restore();
        expect(book.list('ws')[0]?.reason).toMatch(/stopped by restart/i);
        expect(await book.start(r.process.id)).toMatchObject({ state: 'running' });
        expect(book.list('ws')[0]?.reason).toBeUndefined();
        expect(await book.restart(r.process.id)).toMatchObject({ state: 'running' });
        expect(r.after.started).toHaveLength(2);
    });

    it('safe-mode recovery cannot reclassify never as a resumable held process', async () => {
        const r = await rig();
        r.safe(true);
        const book = await r.open();
        const result = book.restore();
        expect(r.after.started).toEqual([]);
        // genie-host hands heldBack ids to the safe-mode banner, whose Resume would start them.
        expect(result.heldBack).not.toContain(r.process.id);
        expect(book.list('ws')[0]?.reason).toMatch(/stopped by restart/i);
        r.safe(false);
        book.restore();
        expect(r.after.started).toEqual([]);
    });

    it('a hibernated never process stays stopped when its workspace is woken', async () => {
        const r = await rig();
        r.asleep(true);
        const book = await r.open();
        book.restore();
        expect(book.list('ws')).toEqual([]);
        r.asleep(false);
        book.visibilityChanged();
        expect(book.list('ws')[0]).toMatchObject({ state: 'stopped', reason: expect.stringMatching(/stopped by restart/i) });
        expect(r.after.started).toEqual([]);
    });

    it('the host replica and processes tool expose stopped-by-restart without launching anything', async () => {
        const r = await rig();
        const book = await r.open();
        book.restore();
        const service = new ProcessesService({ book, supervisor: r.after });
        const replica = new ProcessBookReplica((method, args) => service.call(method, args));
        replica.rebase(service.dump());
        const [tool] = processTools({
            resolveCaller: () => ({ agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'ws', workspacePath: r.home }),
            approve: async () => 'denied',
            processes: { book: replica, logs: () => null },
        });
        const response = await tool!.handler({ action: 'list', terminalId: 'test' }, { server: 'genie', tool: 'processes', headers: {} });
        expect(response.isError).toBe(false);
        expect(JSON.parse(response.text).processes).toEqual([expect.objectContaining({ id: r.process.id, state: 'stopped', kept: true, reason: expect.stringMatching(/stopped by restart/i) })]);
        expect(replica.list('ws')).toEqual(book.list('ws'));
        expect(r.after.started).toEqual([]);
    });
});

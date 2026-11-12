import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeServiceExec } from '../src/main/service-exec.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SupervisorService } from '../src/main/supervisor-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { ServiceExec } from '../src/main/mcp-tools-hosting.js';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));

// Exercise the real executor/event wiring; no OS process, provider, Docker or window is started.
const SECRET = ['fixture', 'credential', '633'].join('-');
class Command extends EventEmitter {
    pid = 4_633;
    stdout = new PassThrough();
    stderr = new PassThrough();
    kill = vi.fn(() => { queueMicrotask(() => this.emit('close', null)); return true; });
}
const commands: Command[] = [];
const pending: Array<ReturnType<ServiceExec>> = [];
beforeEach(() => {
    commands.length = 0; pending.length = 0;
    vi.mocked(spawn).mockReset().mockImplementation(() => {
        const child = new Command(); child.pid += commands.length; commands.push(child);
        return child as unknown as ReturnType<typeof spawn>;
    });
});
afterEach(async () => {
    for (const child of commands) child.emit('close', 0);
    await Promise.allSettled(pending);
    vi.restoreAllMocks();
});

describe('service command observation failures never orphan the actual command (#633)', () => {
    // The injected tree's read/reap and fake child's close need only microtasks, never a real timeout.
    const settleMicrotasks = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

    it('ends the existing child if its visible entry could not be created, without printing observer error data', async () => {
        const w = rig();
        vi.spyOn(w.supervisor, 'trackExternal').mockImplementation(() => { throw new Error(`fixture observer failed ${SECRET}`); });
        const result = w.start();
        await settleMicrotasks();
        expect(commands[0]!.kill).toHaveBeenCalledTimes(1);
        const answer = await result;
        expect(answer.aborted).toBe(true);
        expect(answer.output).toContain('Genie could not publish all command activity.');
        expect(answer.output).not.toContain(SECRET);
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('ends the existing child if sanitized live publication fails; the observer never receives the secret', async () => {
        const w = rig();
        const output = vi.fn((_data: string) => { throw new Error(`fixture output failed ${SECRET}`); });
        vi.spyOn(w.supervisor, 'trackExternal').mockReturnValue({ output, finish: () => {} });
        const result = w.start(); commands[0]!.stdout.write(`${SECRET}\n`);
        await settleMicrotasks();
        expect(commands[0]!.kill).toHaveBeenCalledTimes(1);
        expect(output.mock.calls[0]?.[0]).toBe('********\n');
        const answer = await result;
        expect(answer.aborted).toBe(true); expect(answer.output).not.toContain(SECRET);
        expect(answer.output).toContain('Genie could not publish all command activity.');
    });

    it('settles once and reports an observer completion failure without printing its error data', async () => {
        const w = rig();
        const finish = vi.fn(() => { throw new Error(`fixture completion failed ${SECRET}`); });
        vi.spyOn(w.supervisor, 'trackExternal').mockReturnValue({ output: () => {}, finish });
        const result = w.start(); commands[0]!.emit('close', 0); commands[0]!.emit('close', 0);
        const answer = await result;
        expect(finish).toHaveBeenCalledTimes(1); expect(answer.exitCode).toBe(0);
        expect(answer.output).toContain('Genie could not publish all command activity.');
        expect(answer.output).not.toContain(SECRET);
    });

    it('CONTROL: a healthy observer does not cancel the command and retains its output/result', async () => {
        const w = rig(); const result = w.start(); commands[0]!.stdout.write('ordinary output\n');
        await settleMicrotasks();
        expect(commands[0]!.kill).not.toHaveBeenCalled();
        expect(w.supervisor.log('command-one')).toBe('ordinary output');
        commands[0]!.emit('close', 0);
        expect(await result).toMatchObject({ exitCode: 0, output: 'ordinary output\n' });
    });

    it('CONTROL: an optional absent observation port still masks metadata-bearing execution without cancelling it', async () => {
        const w = rig();
        const execute = makeServiceExec({ snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) });
        const result = execute(w.input); pending.push(result);
        commands[0]!.stdout.write(`${SECRET}\n`); commands[0]!.emit('close', 0);
        expect(await result).toMatchObject({ exitCode: 0, output: '********\n' });
        expect(commands[0]!.kill).not.toHaveBeenCalled(); expect(w.supervisor.list()).toEqual([]);
    });
});

function rig() {
    const open = vi.fn(() => { throw new Error('observation must never start a second shell'); });
    const pty: PtyPort = { open, write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
    const supervisor = new ProcessSupervisor(pty);
    const service = new SupervisorService(supervisor);
    const tree: ProcessTree = { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) };
    const execute = makeServiceExec(tree, supervisor);
    const input: Parameters<ServiceExec>[0] = {
        command: 'php artisan test', cwd: '/fixture', env: {}, timeoutMs: 10_000,
        run: { id: 'command-one', workspaceId: 'work', agentId: 'fixture-agent', name: 'fixture · services exec', secrets: [SECRET] },
    };
    const start = (overrides: Partial<Parameters<ServiceExec>[0]> = {}) => {
        const promise = execute({ ...input, ...overrides }); pending.push(promise); return promise;
    };
    return { supervisor, service, input, start, open };
}

describe('actual service executor publishes one transient command (#633)', () => {
    it('lists the command while it runs, with its exact pid, workspace and result identity', async () => {
        const w = rig(); const result = w.start();
        expect(w.supervisor.list('work')).toMatchObject([{ id: 'command-one', pid: 4_633, state: 'running', commandRun: true }]);
        expect(w.supervisor.list('other')).toEqual([]);
        expect(w.supervisor.command('command-one')).toBe('php artisan test');
        expect(spawn).toHaveBeenCalledTimes(1); expect(w.open).not.toHaveBeenCalled();
        commands[0]!.emit('close', 0);
        expect(await result).toMatchObject({ processId: 'command-one', exitCode: 0 });
    });

    it('publishes stdout/stderr live through the real masker before command completion', async () => {
        const w = rig(); const events: string[] = [];
        w.service.onEvent((event) => { if (event.kind === 'output') events.push(event.data); });
        const result = w.start();
        commands[0]!.stdout.write(`before ${SECRET.slice(0, 9)}`);
        expect(w.supervisor.log('command-one')).toBe('before ');
        commands[0]!.stderr.write(`${SECRET.slice(9)} after\n`);
        expect(events.join('')).toBe('before ******** after\n');
        expect(w.service.dump().logs['command-one']).toBe('before ******** after');
        commands[0]!.emit('close', 0); await result;
        expect(w.supervisor.status('command-one')).toMatchObject({ state: 'exited', exitCode: 0, pid: null });
    });

    it('Processes Stop invokes the existing command abort/reap path exactly once', async () => {
        const w = rig(); const result = w.start();
        expect(w.supervisor.stop('command-one')).toBe(true);
        w.supervisor.stop('command-one');
        expect(await result).toMatchObject({ aborted: true });
        expect(commands[0]!.kill).toHaveBeenCalledTimes(1);
        expect(w.supervisor.status('command-one')).toMatchObject({ state: 'stopped', pid: null });
        expect(w.open).not.toHaveBeenCalled();
    });

    it('the original client abort also ends the observed command', async () => {
        const w = rig(); const controller = new AbortController();
        const result = w.start({ signal: controller.signal });
        controller.abort();
        expect(await result).toMatchObject({ aborted: true });
        expect(w.supervisor.status('command-one')).toMatchObject({ state: 'stopped', pid: null });
    });

    it('failure retains a sanitized log and never offers an executor restart', async () => {
        const w = rig(); const result = w.start();
        commands[0]!.stderr.write(`failed ${SECRET}\n`); commands[0]!.emit('close', 2);
        await result;
        expect(w.supervisor.status('command-one')).toMatchObject({ state: 'failed', exitCode: 2, pid: null });
        expect(w.supervisor.log('command-one')).toBe('failed ********');
        expect(w.supervisor.restart('command-one')).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('a synchronous spawn error still leaves a failed visible run with a masked explanation', async () => {
        const w = rig(); vi.mocked(spawn).mockImplementationOnce(() => { throw new Error(`fixture failure ${SECRET}`); });
        await w.start();
        expect(w.supervisor.status('command-one')).toMatchObject({ state: 'failed', pid: null });
        expect(w.supervisor.log('command-one')).toContain('fixture failure ********');
    });

    it('an error followed by close records completion only once', async () => {
        const w = rig(); const statuses: string[] = [];
        w.supervisor.onChange((status) => { statuses.push(status.state); });
        const result = w.start();
        commands[0]!.emit('error', new Error('fixture failure')); commands[0]!.emit('close', 1);
        await result;
        expect(statuses).toEqual(['running', 'failed']);
    });

    it('two identical commands have distinct runs, and Stop never cancels the other one', async () => {
        const w = rig(); const first = w.start();
        const second = w.start({ run: { ...w.input.run!, id: 'command-two', workspaceId: 'other' } });
        expect(w.supervisor.list()).toHaveLength(2);
        w.supervisor.stop('command-one'); await first;
        expect(commands[1]!.kill).not.toHaveBeenCalled();
        expect(w.supervisor.status('command-two')).toMatchObject({ state: 'running' });
        commands[1]!.emit('close', 0); await second;
    });

    it('CONTROL: an already aborted client starts no process and creates no visible run', async () => {
        const w = rig(); const controller = new AbortController(); controller.abort();
        expect(await w.start({ signal: controller.signal })).toMatchObject({ aborted: true });
        expect(spawn).not.toHaveBeenCalled(); expect(w.supervisor.list()).toEqual([]);
    });

    it('CONTROL: callers without run metadata retain the existing executor behavior', async () => {
        const w = rig(); const { run: _run, ...legacy } = w.input;
        const execute = makeServiceExec({ snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, w.supervisor);
        const result = execute(legacy); pending.push(result);
        commands[0]!.stdout.write('legacy output\n'); commands[0]!.emit('close', 0);
        expect(await result).toMatchObject({ exitCode: 0, output: 'legacy output\n' });
        expect(spawn).toHaveBeenCalledTimes(1); expect(w.supervisor.list()).toEqual([]);
    });
});

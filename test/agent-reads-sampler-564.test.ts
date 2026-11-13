import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunIdentity, SampleRequest } from '../scripts/agent-reads-acquire.mjs';

interface Report { identity?: RunIdentity; samplerPid?: number; finished?: boolean; cleanup?: { complete?: boolean }; failures?: string[] }
// Import the actual executable with OS/CDP ports mocked. No real home, Electron, socket, process or provider is used.
const io = vi.hoisted(() => ({
    identity: vi.fn(), write: vi.fn(), exec: vi.fn(), launch: vi.fn(), attach: vi.fn(), makeHome: vi.fn(),
    alive: vi.fn(), gone: vi.fn(), killHard: vi.fn(), hostPid: vi.fn(), finish: vi.fn(), check: vi.fn(),
    failures: [] as string[], order: [] as string[], reports: [] as { value: Report; goneCalls: number }[],
}));
vi.mock('node:fs', () => ({ writeFileSync: io.write }));
vi.mock('node:child_process', () => ({ execFileSync: io.exec }));
vi.mock('../scripts/agent-reads-process.mjs', () => ({ readMeasurementIdentity: io.identity }));
vi.mock('../scripts/crash-cdp-lib.mjs', () => ({
    WIN: process.platform === 'win32', alive: io.alive, attach: io.attach, check: io.check,
    cleanQuit: vi.fn(async () => 'ok'), failures: io.failures, finish: io.finish, gone: io.gone,
    hostPid: io.hostPid, killHard: io.killHard, launch: io.launch, makeHome: io.makeHome,
    readOr: vi.fn(() => ''), refuseOffTestMachines: vi.fn(), sleep: vi.fn(async () => {}),
    step: vi.fn(), until: vi.fn(),
}));

const root = join(tmpdir(), 'agent-reads-sampler-fixture');
const output = join(root, 'report.json');
const identity: RunIdentity = { build: 'a'.repeat(40), vmId: 'fixture-vm', platform: process.platform, runId: 'fixture-run' };
const request: SampleRequest = { identity, mode: 'door', pairIndex: 0 };
const originalArgv = [...process.argv];
let live: Set<number>;
let stuck: number | undefined;
let throws: number | undefined;

beforeEach(() => {
    vi.resetModules();
    for (const mock of [io.identity, io.write, io.exec, io.launch, io.attach, io.makeHome, io.alive, io.gone, io.killHard, io.hostPid, io.finish, io.check]) mock.mockReset();
    io.failures.length = 0; io.order.length = 0; io.reports.length = 0;
    live = new Set([101, 202]); stuck = undefined; throws = undefined;
    const stop = (pid: number) => {
        io.order.push(`stop:${pid}`);
        if (pid === throws) throw new Error('owned process termination failed');
        if (pid !== stuck) live.delete(pid);
    };
    io.identity.mockReturnValue({ ...identity });
    io.makeHome.mockReturnValue({ root, genie: join(root, 'home/.genie'), lifecycle: join(root, 'lifecycle.log'), env: {} });
    io.hostPid.mockReturnValue(202);
    io.launch.mockReturnValue({ child: { pid: 101 } });
    io.attach.mockResolvedValue({ windowPid: 101, cdp: { evaluate: vi.fn(async (expression: string) => expression.includes('Promise.all(') ? { workspaces: ['fixture-workspace'] } : true), closed: vi.fn(async () => true) }, inspector: { closed: vi.fn(async () => true) } });
    io.alive.mockImplementation((pid: number) => live.has(pid));
    io.gone.mockImplementation(async (pid: number) => { io.order.push(`gone:${pid}`); return !live.has(pid); });
    io.killHard.mockImplementation(stop);
    io.exec.mockImplementation((file: string, args: string[]) => {
        if (file !== 'taskkill') throw new Error(`unexpected fixture command: ${file}`);
        stop(Number(args[args.indexOf('/PID') + 1])); return '';
    });
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0) return live.has(Math.abs(pid));
        stop(Math.abs(pid)); return true;
    });
    io.write.mockImplementation((file: string, content: string) => {
        if (file === output) { io.order.push('report'); io.reports.push({ value: JSON.parse(content) as Report, goneCalls: io.gone.mock.calls.length }); }
    });
    io.check.mockImplementation((ok: boolean, label: string) => { if (!ok) io.failures.push(label); return ok; });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no listener in fixture')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('AGENT_READS_REQUEST', JSON.stringify(request));
    vi.stubEnv('AGENT_READS_PROBE_ONLY', '1'); // Stop after startup reads; the test concerns ownership, not timed workloads.
    process.argv = [process.execPath, 'agent-reads-measure.mjs', '--mode=door', `--out=${output}`];
});
afterEach(() => { process.argv = [...originalArgv]; vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function runSampler() {
    const completed = new Promise<number>((resolve) => {
        // Match the shared finish's best-effort cleanup behavior, without deleting files or calling process.exit.
        io.finish.mockImplementation((_name: string, _home: unknown, cleanups: (() => Promise<void>)[]) => async (code: number) => {
            for (const cleanup of cleanups) { try { await cleanup(); } catch { /* matches the shared helper */ } }
            resolve(code);
        });
    });
    await import('../scripts/agent-reads-measure.mjs');
    const code = await completed;
    return { code, report: io.reports.at(-1)?.value };
}

describe('actual sampler identity and owned cleanup (Tynn #564)', () => {
    it('uses independently read identity, with only the run nonce supplied by its request', async () => {
        const result = await runSampler();
        expect(io.identity).toHaveBeenCalledWith(identity.runId);
        expect(result.report?.identity).toEqual(identity);
    });

    it.each(['build', 'vmId', 'platform', 'runId'] as const)('refuses a mismatched actual %s before creating a home or launching', async (field) => {
        io.identity.mockReturnValue({ ...identity, [field]: 'different' });
        await expect(runSampler()).rejects.toThrow(/identity|build|vm|platform|run/i);
        expect(io.makeHome).not.toHaveBeenCalled(); expect(io.launch).not.toHaveBeenCalled();
    });

    it('records its actual sampler PID', async () => {
        const result = await runSampler();
        expect(result.report?.samplerPid).toBe(process.pid);
    });

    it('writes a successful receipt only after confirming both owned process exits', async () => {
        const result = await runSampler();
        expect(result.report?.cleanup?.complete).toBe(true);
        expect(io.gone).toHaveBeenCalledWith(101, expect.any(Number));
        expect(io.gone).toHaveBeenCalledWith(202, expect.any(Number));
        expect(io.reports.at(-1)?.goneCalls).toBeGreaterThanOrEqual(2);
        expect(result.code).toBe(0);
    });

    it('reports incomplete cleanup and fails if an owned host stays alive', async () => {
        stuck = 202;
        const result = await runSampler();
        expect(result.report?.cleanup?.complete).toBe(false);
        expect(result.code).not.toBe(0);
    });

    it('still cleans the window if stopping the host throws, and fails honestly', async () => {
        throws = 202;
        const result = await runSampler();
        expect(io.order).toContain('stop:101');
        expect(result.report?.cleanup?.complete).toBe(false);
        expect(result.code).not.toBe(0);
    });

    it('does not claim complete cleanup when the launched app has no identifiable host', async () => {
        io.hostPid.mockReturnValue(null);
        const result = await runSampler();
        expect(result.report?.cleanup?.complete).toBe(false);
        expect(result.code).not.toBe(0);
    });

    it('never treats its own sampler PID as an owned host to terminate', async () => {
        io.hostPid.mockReturnValue(process.pid); live.add(process.pid);
        const result = await runSampler();
        expect(io.order).not.toContain(`stop:${process.pid}`);
        expect(result.report?.cleanup?.complete).toBe(false);
        expect(result.code).not.toBe(0);
    });

    it('confirms already stopped owned processes without killing them again', async () => {
        live.clear();
        const result = await runSampler();
        expect(result.report?.cleanup?.complete).toBe(true);
        expect(io.order.filter((event) => event.startsWith('stop:'))).toEqual([]);
    });

    it('cleans its launched app and host after an attach failure, keeping the sample unfinished', async () => {
        io.attach.mockRejectedValue(new Error('fixture attach failed'));
        const result = await runSampler();
        expect(result.report?.cleanup?.complete).toBe(true);
        expect(result.report?.finished).toBe(false);
        expect(result.code).not.toBe(0);
    });
});

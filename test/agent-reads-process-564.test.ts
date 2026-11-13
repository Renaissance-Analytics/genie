import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SampleRequest } from '../scripts/agent-reads-acquire.mjs';

// Mock the Node boundary that the real adapter must use, rather than providing a fake runSample implementation.
// No child, Electron, filesystem write or process kill happens in these tests.
const io = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn(), readFile: vi.fn(), hostname: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: io.spawn, execFileSync: io.execFileSync }));
vi.mock('node:fs/promises', () => ({ readFile: io.readFile }));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), hostname: io.hostname }));
import { readMeasurementIdentity, runMeasurementProcess } from '../scripts/agent-reads-process.mjs';

const build = 'a'.repeat(40);
const samplerPid = 424242;
const request: SampleRequest = { identity: { build, vmId: 'fixture-vm', platform: process.platform, runId: 'fixture-run' }, pairIndex: 0, mode: 'ipc' };
const cwd = resolve(tmpdir(), 'agent-reads-fixture');
const out = join(cwd, 'pair-0-ipc; this-is-data.json');
const report = () => ({ ...structuredClone(request), samplerPid, finished: true, failures: [], cleanup: { complete: true } });
let child: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };

beforeEach(() => {
    io.spawn.mockReset(); io.execFileSync.mockReset(); io.readFile.mockReset(); io.hostname.mockReset();
    child = Object.assign(new EventEmitter(), { pid: samplerPid, kill: vi.fn(() => true) });
    child.on('error', () => {}); // An inert RED adapter must fail the rejection assertion, not throw EventEmitter's error.
    io.spawn.mockReturnValue(child); io.execFileSync.mockReturnValue(`${build}\n`);
    io.hostname.mockReturnValue('fixture-vm'); io.readFile.mockResolvedValue(JSON.stringify(report()));
    vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function closed(code = 0) {
    const result = runMeasurementProcess({ request, cwd, out });
    child.emit('close', code, null);
    return result;
}

describe('real paired measurement process adapter (Tynn #564)', () => {
    it('reads the actual checkout, VM and platform independently instead of trusting requested identity', () => {
        expect(readMeasurementIdentity('fresh-run')).toEqual({ build, vmId: 'fixture-vm', platform: process.platform, runId: 'fresh-run' });
        expect(io.execFileSync).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], expect.objectContaining({ encoding: 'utf8' }));
        expect(io.hostname).toHaveBeenCalledTimes(1);
    });

    it('spawns the real sampler without a shell, waits for exit, and reads only its output', async () => {
        let settled = false;
        const pending = runMeasurementProcess({ request, cwd, out });
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve(); await Promise.resolve();
        const beforeExit = settled;
        child.emit('close', 0, null);
        const value = await pending;
        expect(beforeExit).toBe(false);
        expect(io.spawn).toHaveBeenCalledTimes(1);
        expect(io.spawn).toHaveBeenCalledWith(process.execPath, [resolve(cwd, 'scripts/agent-reads-measure.mjs'), '--mode=ipc', `--out=${out}`], expect.objectContaining({
            cwd, shell: false, stdio: ['ignore', 'inherit', 'inherit'],
            env: expect.objectContaining({ AGENT_READS_REQUEST: JSON.stringify(request) }),
        }));
        expect(io.readFile).toHaveBeenCalledWith(out, 'utf8');
        expect(value).toEqual(report());
    });

    it('rejects a nonzero exit even when a successful-looking result file exists', async () => {
        await expect(closed(7)).rejects.toThrow(/exit|code/i);
        expect(io.readFile).not.toHaveBeenCalled();
    });

    it('launches the explicitly scoped M4-only sampler without turning it into a full measurement', async () => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), scope: 'm4-diagnostic' }));
        const pending = runMeasurementProcess({ request, cwd, out, scope: 'm4-diagnostic' });
        child.emit('close', 0, null);
        const value = await pending;
        expect(io.spawn.mock.calls[0]?.[1]).toContain('--scope=m4-diagnostic');
        expect(value.scope).toBe('m4-diagnostic');
    });

    it('rejects diagnostic evidence when a full measurement was requested', async () => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), scope: 'm4-diagnostic' }));
        await expect(closed()).rejects.toThrow(/scope|diagnostic|full/i);
    });

    it('rejects full-measurement evidence when the M4-only scope was requested', async () => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), scope: 'full' }));
        const pending = runMeasurementProcess({ request, cwd, out, scope: 'm4-diagnostic' });
        child.emit('close', 0, null);
        await expect(pending).rejects.toThrow(/scope|diagnostic|full/i);
    });

    it('rejects a missing result instead of making up an observation', async () => {
        io.readFile.mockRejectedValue(new Error('sample result missing'));
        await expect(closed()).rejects.toThrow(/missing|result/i);
    });

    it('rejects an invalid result file', async () => {
        io.readFile.mockResolvedValue('not JSON');
        await expect(closed()).rejects.toThrow();
    });

    it('rejects an unfinished sample', async () => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), finished: false }));
        await expect(closed()).rejects.toThrow(/unfinished|complete/i);
    });

    it('rejects a sample when the child has not confirmed cleanup', async () => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), cleanup: { complete: false } }));
        await expect(closed()).rejects.toThrow(/cleanup|process/i);
    });

    it('rejects a sample that recorded a failed check even when its exit code is zero', async () => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), failures: ['the window PID did not match'] }));
        await expect(closed()).rejects.toThrow(/fail|check/i);
    });

    it('rejects a stale result from a different sampler PID', async () => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), samplerPid: samplerPid + 1 }));
        await expect(closed()).rejects.toThrow(/pid|process|sampler/i);
    });

    it.each(['build', 'vmId', 'platform', 'runId'] as const)('rejects a different %s from the actual child result', async (field) => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), identity: { ...request.identity, [field]: 'different' } }));
        await expect(closed()).rejects.toThrow(/identity|build|vm|platform|run/i);
    });

    it.each(['mode', 'pairIndex'] as const)('rejects a result for another %s', async (field) => {
        io.readFile.mockResolvedValue(JSON.stringify({ ...report(), [field]: field === 'mode' ? 'door' : 1 }));
        await expect(closed()).rejects.toThrow(/mode|pair|request/i);
    });

    it('bounds a stuck sampler and ends only the process tree it launched', async () => {
        vi.useFakeTimers();
        const pending = runMeasurementProcess({ request, cwd, out, timeoutMs: 100 }).then(
            (value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }),
        );
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await pending;
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toMatch(/deadline|timed out|timeout/i);
        if (process.platform === 'win32') {
            expect(io.execFileSync).toHaveBeenCalledWith('taskkill', expect.arrayContaining(['/PID', String(samplerPid), '/T', '/F']), expect.any(Object));
        } else expect(process.kill).toHaveBeenCalledWith(-samplerPid, 'SIGKILL');
        expect(io.readFile).not.toHaveBeenCalled();
    });

    it('rejects a spawn failure without reading an old result file', async () => {
        const pending = runMeasurementProcess({ request, cwd, out });
        child.emit('error', new Error('sampler spawn failed'));
        await expect(pending).rejects.toThrow(/spawn failed/i);
        expect(io.readFile).not.toHaveBeenCalled();
    });
});

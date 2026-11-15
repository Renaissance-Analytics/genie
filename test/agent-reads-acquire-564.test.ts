import { describe, expect, it, vi } from 'vitest';
import { acquirePairedRuns, type AcquisitionReport, type SampleRequest } from '../scripts/agent-reads-acquire.mjs';

// Only orchestration ports are controlled. No Electron, timers, filesystem or real measurement is run by these tests.
const sample = (request: SampleRequest) => ({ ...request, identity: { ...request.identity }, finished: true });
function fixture() {
    const identity = { build: 'a'.repeat(40), vmId: 'fixture-vm', platform: 'win32', runId: 'fixture-run' };
    const snapshots: AcquisitionReport[] = [];
    const runSample = vi.fn(async (request: SampleRequest) => sample(request));
    const checkpoint = vi.fn(async (report: AcquisitionReport) => { snapshots.push(report); });
    return { identity, snapshots, runSample, checkpoint, options: { identity, runSample, checkpoint } };
}

describe('paired acquisition for the real measurement job (Tynn #564)', () => {
    it('awaits six sequential acquisitions in alternating order and binds the three pairs', async () => {
        const f = fixture(); let active = 0, maximum = 0;
        f.runSample.mockImplementation(async (request) => {
            active += 1; maximum = Math.max(maximum, active);
            await Promise.resolve(); active -= 1;
            return sample(request);
        });
        const result = await acquirePairedRuns(f.options);
        expect(f.runSample.mock.calls.map(([r]) => [r.pairIndex, r.mode])).toEqual([
            [0, 'ipc'], [0, 'door'], [1, 'door'], [1, 'ipc'], [2, 'ipc'], [2, 'door'],
        ]);
        expect(maximum).toBe(1);
        expect(result.pairs.map((p) => p.order)).toEqual([['ipc', 'door'], ['door', 'ipc'], ['ipc', 'door']]);
        expect(result.pairs.every((p) => p.ipc?.mode === 'ipc' && p.door?.mode === 'door')).toBe(true);
        expect(f.runSample.mock.calls.every(([r]) => JSON.stringify(r.identity) === JSON.stringify(f.identity))).toBe(true);
    });

    it('acquires the revision candidate with its actual mode while retaining logical door ordering', async () => {
        const f = fixture();
        const result = await acquirePairedRuns({ ...f.options, candidateMode: 'door-revision' });
        expect(f.runSample.mock.calls.filter(([r]) => r.mode !== 'ipc').map(([r]) => r.mode)).toEqual([
            'door-revision', 'door-revision', 'door-revision',
        ]);
        expect(result.candidateMode).toBe('door-revision');
        expect(result.pairs.map((p) => p.door?.mode)).toEqual(['door-revision', 'door-revision', 'door-revision']);
        expect(result.pairs[1]?.order).toEqual(['door', 'ipc']);
    });

    it('checkpoints each acquired sample and does not mutate the previously saved reports', async () => {
        const f = fixture(); await acquirePairedRuns(f.options);
        expect(f.snapshots.map((r) => r.pairs.reduce((n, p) => n + Number(p.ipc !== undefined) + Number(p.door !== undefined), 0)))
            .toEqual([1, 2, 3, 4, 5, 6]);
        expect(f.snapshots[0]?.pairs[0]?.door).toBeUndefined();
        expect(f.snapshots.at(-1)?.pairs).toHaveLength(3);
    });

    it('refuses fewer than three pairs before acquiring anything', async () => {
        const f = fixture();
        await expect(acquirePairedRuns({ ...f.options, pairCount: 2 })).rejects.toThrow(/three|3/i);
        expect(f.runSample).not.toHaveBeenCalled(); expect(f.checkpoint).not.toHaveBeenCalled();
    });

    it.each(['build', 'vmId', 'platform', 'runId'] as const)('stops when a sample reports a different %s', async (field) => {
        const f = fixture();
        f.runSample.mockImplementation(async (request) => ({ ...sample(request), identity: { ...request.identity, [field]: 'other' } }));
        await expect(acquirePairedRuns(f.options)).rejects.toThrow(/identity|build|vm|platform|run/i);
        expect(f.runSample).toHaveBeenCalledTimes(1);
        expect(f.checkpoint).not.toHaveBeenCalled();
    });

    it('refuses an unfinished acquisition instead of supplying a successful pair', async () => {
        const f = fixture(); f.runSample.mockImplementation(async (request) => ({ ...sample(request), finished: false }));
        await expect(acquirePairedRuns(f.options)).rejects.toThrow(/unfinished|complete/i);
        expect(f.runSample).toHaveBeenCalledTimes(1); expect(f.checkpoint).not.toHaveBeenCalled();
    });

    it('stops after a checkpoint failure instead of acquiring more samples without saved evidence', async () => {
        const f = fixture(); f.checkpoint.mockRejectedValue(new Error('checkpoint unavailable'));
        await expect(acquirePairedRuns(f.options)).rejects.toThrow('checkpoint unavailable');
        expect(f.runSample).toHaveBeenCalledTimes(1);
    });
});

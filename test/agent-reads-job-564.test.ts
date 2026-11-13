import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcquisitionReport, SampleRequest } from '../scripts/agent-reads-acquire.mjs';
import type { CompareRow } from '../scripts/agent-reads-compare.mjs';

interface Evidence { pairs?: AcquisitionReport['pairs']; candidateMode?: string; rows?: CompareRow[]; pass?: boolean }
const io = vi.hoisted(() => ({
    mkdir: vi.fn(), write: vi.fn(), identity: vi.fn(), sample: vi.fn(), uuid: vi.fn(), guard: vi.fn(),
    writes: [] as { file: string; value: Evidence }[],
}));
vi.mock('node:fs/promises', () => ({ mkdir: io.mkdir, writeFile: io.write }));
vi.mock('node:crypto', () => ({ randomUUID: io.uuid }));
vi.mock('../scripts/agent-reads-process.mjs', () => ({ readMeasurementIdentity: io.identity, runMeasurementProcess: io.sample }));
vi.mock('../scripts/crash-cdp-lib.mjs', () => ({ refuseOffTestMachines: io.guard }));
import { runPairedMeasurement } from '../scripts/agent-reads-paired.mjs';

const outDir = join(tmpdir(), 'paired-564-fixture');
const identity = { build: 'a'.repeat(40), vmId: 'fixture-vm', platform: process.platform, runId: 'fixture-run' };
function sample(request: SampleRequest) {
    const value = request.mode === 'ipc' ? 100 : 105;
    const control = request.mode === 'ipc' ? 100 : 300;
    return { ...request, finished: true, samplerPid: 424242, cleanup: { complete: true }, failures: [],
        m4_5000: { ms: value, maxGapMs: 50 }, m4_20000: { ms: value, maxGapMs: 50 },
        m5: { windowCpuMs: value, hostCpuMs: value, maxGapMs: 50, heapBeforeBytes: 100, heapAfterGcBytes: 110, gc: true },
        m6: { readMs: value, maxGapMs: 50 },
        measureControls: { m4_5000: { metric: 'ms', value: control }, m4_20000: { metric: 'ms', value: control },
            m5: { metric: 'windowCpuMs', value: control }, m6: { metric: 'readMs', value: control } },
    };
}
beforeEach(() => {
    for (const mock of [io.mkdir, io.write, io.identity, io.sample, io.uuid, io.guard]) mock.mockReset();
    io.writes.length = 0;
    io.mkdir.mockResolvedValue(undefined); io.uuid.mockReturnValue(identity.runId);
    io.identity.mockImplementation((runId: string) => ({ ...identity, runId }));
    io.sample.mockImplementation(async ({ request }: { request: SampleRequest }) => sample(request));
    io.write.mockImplementation(async (file: string, content: string) => { io.writes.push({ file, value: JSON.parse(content) as Evidence }); });
});
const verdicts = () => io.writes.filter((entry) => entry.file.endsWith('-verdict.json'));

describe('executable paired parent job (Tynn #564)', () => {
    it('runs three alternated pairs for inline and revision on one measured identity with unique sample files', async () => {
        const result = await runPairedMeasurement({ outDir });
        expect(result.pass).toBe(true);
        expect(io.guard).toHaveBeenCalledWith('agent-reads-paired');
        expect(io.mkdir).toHaveBeenCalledWith(outDir, { recursive: false });
        expect(io.uuid).toHaveBeenCalledTimes(1);
        expect(io.identity).toHaveBeenCalledWith(identity.runId);
        const calls = io.sample.mock.calls.map(([options]) => options as { request: SampleRequest; out: string });
        expect(calls.map(({ request }) => [request.pairIndex, request.mode])).toEqual([
            [0, 'ipc'], [0, 'door'], [1, 'door'], [1, 'ipc'], [2, 'ipc'], [2, 'door'],
            [0, 'ipc'], [0, 'door-revision'], [1, 'door-revision'], [1, 'ipc'], [2, 'ipc'], [2, 'door-revision'],
        ]);
        expect(calls.every(({ request }) => JSON.stringify(request.identity) === JSON.stringify(identity))).toBe(true);
        expect(new Set(calls.map(({ out }) => out)).size).toBe(12);
        expect(verdicts()).toHaveLength(2);
        expect(verdicts().every(({ value }) => value.rows?.length && value.rows.every((row) => row.pass))).toBe(true);
    });

    it('persists each acquired observation, including partial pairs, without rewriting old in-memory evidence', async () => {
        await runPairedMeasurement({ outDir });
        const checkpoints = io.writes.filter(({ value }) => Array.isArray(value.pairs));
        expect(checkpoints.map(({ value }) => value.pairs?.reduce((count, pair) => count + Number(Boolean(pair.ipc)) + Number(Boolean(pair.door)), 0)))
            .toEqual([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]);
        expect(checkpoints[0]?.value.pairs?.[0]?.door).toBeUndefined();
    });

    it('refuses an existing output directory instead of mixing a prior run into this one', async () => {
        io.mkdir.mockRejectedValue(new Error('output already exists'));
        await expect(runPairedMeasurement({ outDir })).rejects.toThrow(/exist/i);
        expect(io.sample).not.toHaveBeenCalled();
    });

    it('stops after a failed sampler instead of starting another process', async () => {
        io.sample.mockRejectedValue(new Error('sampler cleanup failed'));
        await expect(runPairedMeasurement({ outDir })).rejects.toThrow(/cleanup failed/);
        expect(io.sample).toHaveBeenCalledTimes(1);
    });

    it('stops when a checkpoint cannot be saved', async () => {
        io.write.mockRejectedValue(new Error('checkpoint unavailable'));
        await expect(runPairedMeasurement({ outDir })).rejects.toThrow(/checkpoint unavailable/);
        expect(io.sample).toHaveBeenCalledTimes(1);
    });

    it('persists a failed bound and stops before measuring the revision candidate', async () => {
        io.sample.mockImplementation(async ({ request }: { request: SampleRequest }) => {
            const observation = sample(request);
            if (request.mode === 'door') observation.m4_5000.ms = 201;
            return observation;
        });
        const result = await runPairedMeasurement({ outDir });
        expect(result.pass).toBe(false); expect(io.sample).toHaveBeenCalledTimes(6);
        expect(verdicts()).toHaveLength(1);
        expect(verdicts()[0]?.value.rows?.find((row) => row.row === 'm4_5000.ms')?.pass).toBe(false);
    });

    it('fails missing observations through the actual paired comparator', async () => {
        io.sample.mockImplementation(async ({ request }: { request: SampleRequest }) => {
            const observation = sample(request);
            return request.mode === 'door' ? { ...observation, m4_20000: undefined } : observation;
        });
        const result = await runPairedMeasurement({ outDir });
        expect(result.pass).toBe(false); expect(io.sample).toHaveBeenCalledTimes(6);
        expect(verdicts()[0]?.value.rows?.find((row) => row.row === 'm4_20000.ms')?.pass).toBe(false);
    });

    it('judges revision separately after the inline verdict passes', async () => {
        io.sample.mockImplementation(async ({ request }: { request: SampleRequest }) => {
            const observation = sample(request);
            if (request.mode === 'door-revision') observation.m6.readMs = 1_000;
            return observation;
        });
        const result = await runPairedMeasurement({ outDir });
        expect(result.pass).toBe(false); expect(io.sample).toHaveBeenCalledTimes(12);
        expect(verdicts().map(({ value }) => value.rows?.every((row) => row.pass))).toEqual([true, false]);
    });

    it('refuses a non-test machine before creating output or starting anything', async () => {
        io.guard.mockImplementation(() => { throw new Error('test machine only'); });
        await expect(runPairedMeasurement({ outDir })).rejects.toThrow(/test machine/);
        expect(io.mkdir).not.toHaveBeenCalled(); expect(io.sample).not.toHaveBeenCalled();
    });
});

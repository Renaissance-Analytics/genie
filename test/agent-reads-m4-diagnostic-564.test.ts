import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcquisitionReport, SampleRequest } from '../scripts/agent-reads-acquire.mjs';

const io = vi.hoisted(() => ({
    mkdir: vi.fn(), write: vi.fn(), identity: vi.fn(), sample: vi.fn(), uuid: vi.fn(), guard: vi.fn(),
    writes: [] as { file: string; value: { report?: AcquisitionReport; pairs?: AcquisitionReport['pairs'] } }[],
}));
vi.mock('node:fs/promises', () => ({ mkdir: io.mkdir, writeFile: io.write }));
vi.mock('node:crypto', () => ({ randomUUID: io.uuid }));
vi.mock('../scripts/agent-reads-process.mjs', () => ({ readMeasurementIdentity: io.identity, runMeasurementProcess: io.sample }));
vi.mock('../scripts/crash-cdp-lib.mjs', () => ({ refuseOffTestMachines: io.guard }));
import { runM4Diagnostic } from '../scripts/agent-reads-m4-diagnostic.mjs';

const outDir = join(tmpdir(), 'm4-diagnostic-564-fixture');
const identity = { build: 'a'.repeat(40), vmId: 'fixture-vm', platform: process.platform, runId: 'fixture-run' };
function sample(request: SampleRequest) {
    const ms = request.mode === 'ipc' ? 20 : 25; // Deliberately over1.2: diagnostics must keep every predeclared pair.
    const ordinary = { ms, maxGapMs: 10, runs: Array.from({ length: 5 }, () => ({ ms, maxGapMs: 10 })) };
    const stages = { producerMs: 2, decodeMs: 3, rebuildMs: 1, totalMs: 10 };
    return { ...request, scope: 'm4-diagnostic', finished: true, cleanup: { complete: true }, failures: [],
        m4_5000: structuredClone(ordinary), m4_20000: structuredClone(ordinary),
        m4Stages: { m4_5000: { ...stages }, m4_20000: { ...stages } },
    };
}
beforeEach(() => {
    for (const mock of [io.mkdir, io.write, io.identity, io.sample, io.uuid, io.guard]) mock.mockReset();
    io.writes.length = 0;
    io.mkdir.mockResolvedValue(undefined); io.uuid.mockReturnValue(identity.runId);
    io.identity.mockImplementation((runId: string) => ({ ...identity, runId }));
    io.sample.mockImplementation(async ({ request }: { request: SampleRequest }) => sample(request));
    io.write.mockImplementation(async (file: string, content: string) => { io.writes.push({ file, value: JSON.parse(content) }); });
});

describe('fixed M4-only diagnostic job (Tynn #564)', () => {
    it('acquires exactly12 alternating pairs with6of each order, one identity and24unique files', async () => {
        const result = await runM4Diagnostic({ outDir });
        expect(result.finished).toBe(true);
        expect(io.guard).toHaveBeenCalledWith('agent-reads-m4-diagnostic');
        expect(io.mkdir).toHaveBeenCalledWith(outDir, { recursive: false });
        const calls = io.sample.mock.calls.map(([options]) => options as { request: SampleRequest; scope: string; out: string });
        expect(calls).toHaveLength(24);
        expect(calls.map(({ request }) => [request.pairIndex, request.mode])).toEqual(
            Array.from({ length: 12 }, (_, pairIndex) => (pairIndex % 2 === 0 ? ['ipc', 'door'] : ['door', 'ipc']).map((mode) => [pairIndex, mode])).flat(),
        );
        expect(calls.every(({ request, scope }) => scope === 'm4-diagnostic' && JSON.stringify(request.identity) === JSON.stringify(identity))).toBe(true);
        expect(new Set(calls.map(({ out }) => out)).size).toBe(24);
        expect(io.uuid).toHaveBeenCalledTimes(1);
    });

    it('keeps all12pairs when every candidate ratio exceeds the existing acceptance bound', async () => {
        await runM4Diagnostic({ outDir });
        expect(io.sample).toHaveBeenCalledTimes(24);
        const report = io.writes.findLast(({ value }) => value.report)?.value.report;
        expect(report?.pairs).toHaveLength(12);
        expect(report?.pairs.every((pair) => Number((pair.door?.m4_5000 as { ms: number }).ms) === 25)).toBe(true);
    });

    it('checkpoints all24observations without dropping partial pairs or later changing earlier evidence', async () => {
        await runM4Diagnostic({ outDir });
        const checkpoints = io.writes.filter(({ value }) => Array.isArray(value.pairs));
        expect(checkpoints.map(({ value }) => value.pairs?.reduce((n, pair) => n + Number(Boolean(pair.ipc)) + Number(Boolean(pair.door)), 0)))
            .toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
        expect(checkpoints[0]?.value.pairs?.[0]?.door).toBeUndefined();
    });

    it.each(['ordinary', 'stage'] as const)('refuses incomplete %s evidence instead of inventing or accepting it', async (missing) => {
        io.sample.mockImplementation(async ({ request }: { request: SampleRequest }) => {
            const value = sample(request);
            return missing === 'ordinary' ? { ...value, m4_5000: { ...value.m4_5000, runs: [] } } : { ...value, m4Stages: undefined };
        });
        await expect(runM4Diagnostic({ outDir })).rejects.toThrow(/ordinary|five|5|stage|diagnostic/i);
    });

    it('refuses an existing evidence directory', async () => {
        io.mkdir.mockRejectedValue(new Error('output already exists'));
        await expect(runM4Diagnostic({ outDir })).rejects.toThrow(/exist/i);
        expect(io.sample).not.toHaveBeenCalled();
    });

    it('refuses the owner desktop before storage or process work', async () => {
        io.guard.mockImplementation(() => { throw new Error('test machine only'); });
        await expect(runM4Diagnostic({ outDir })).rejects.toThrow(/test machine/i);
        expect(io.mkdir).not.toHaveBeenCalled(); expect(io.sample).not.toHaveBeenCalled();
    });

    it('CONTROL: the diagnostic result never claims acceptance or a passing full-suite verdict', async () => {
        const result = await runM4Diagnostic({ outDir });
        expect(result.kind).toBe('m4-diagnostic');
        expect(result.acceptance).toBe(false);
        expect(result).not.toHaveProperty('pass');
    });
});

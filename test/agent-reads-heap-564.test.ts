import { describe, expect, it, vi } from 'vitest';
import { createHeapSampler, type HeapFrame } from '../scripts/agent-reads-heap.mjs';

// The actual crash-cdp-lib.Cdp.send envelope shape, with deterministic replies and clock; no browser/timer is started.
function fixture() {
    let at = 1_000;
    const heaps = [100, 150, 160, 110];
    const send = vi.fn(async (method: string): Promise<HeapFrame> => method === 'HeapProfiler.collectGarbage'
        ? { result: {} } : { result: { usedSize: heaps.shift()! } });
    const sampler = createHeapSampler({ send }, () => at);
    return { send, sampler, time: (elapsedMs: number) => { at = 1_000 + elapsedMs; } };
}

describe('real CDP heap acquisition for M5 (Tynn #564)', () => {
    it('collects before the baseline and after the run, with timed raw samples in between', async () => {
        const f = fixture(); await f.sampler.start();
        f.time(15_000); await f.sampler.sample();
        f.time(30_000); await f.sampler.sample();
        f.time(60_000); const result = await f.sampler.finish();
        expect(f.send.mock.calls.map(([method]) => method)).toEqual([
            'HeapProfiler.collectGarbage', 'Runtime.getHeapUsage',
            'Runtime.getHeapUsage', 'Runtime.getHeapUsage',
            'HeapProfiler.collectGarbage', 'Runtime.getHeapUsage',
        ]);
        expect(result).toEqual({ heapBeforeBytes: 100, heapAfterGcBytes: 110, gc: true, heapSeries: [
            { phase: 'baseline', elapsedMs: 0, usedBytes: 100 },
            { phase: 'stream', elapsedMs: 15_000, usedBytes: 150 },
            { phase: 'stream', elapsedMs: 30_000, usedBytes: 160 },
            { phase: 'after-gc', elapsedMs: 60_000, usedBytes: 110 },
        ] });
    });

    it('a raw time-series read does not force GC during the performance interval', async () => {
        const f = fixture(); await f.sampler.start(); f.send.mockClear();
        f.time(15_000); await f.sampler.sample();
        expect(f.send.mock.calls.map(([method]) => method)).toEqual(['Runtime.getHeapUsage']);
    });

    it('refuses a protocol-level GC error rather than declaring a collected baseline', async () => {
        const f = fixture(); f.send.mockResolvedValueOnce({ error: { message: 'GC refused' } });
        await expect(f.sampler.start()).rejects.toThrow(/GC refused/);
        expect(f.send).toHaveBeenCalledTimes(1);
    });

    it('refuses a protocol-level heap error even though send itself resolves', async () => {
        const f = fixture();
        f.send.mockResolvedValueOnce({ result: {} }).mockResolvedValueOnce({ error: { message: 'heap refused' } });
        await expect(f.sampler.start()).rejects.toThrow(/heap refused/);
    });

    it.each([undefined, Number.NaN, -1])('refuses invalid usedSize %s instead of inventing a heap baseline', async (usedSize) => {
        const f = fixture();
        f.send.mockResolvedValueOnce({ result: {} }).mockResolvedValueOnce({ result: usedSize === undefined ? {} : { usedSize } });
        await expect(f.sampler.start()).rejects.toThrow(/heap/i);
    });

    it('cannot finish without a measured baseline', async () => {
        const f = fixture();
        await expect(f.sampler.finish()).rejects.toThrow(/baseline|start/i);
        expect(f.send).not.toHaveBeenCalled();
    });

    it('cannot report successful post-run GC when its acknowledgement is an error', async () => {
        const f = fixture(); await f.sampler.start();
        f.send.mockResolvedValueOnce({ error: { message: 'final GC refused' } });
        await expect(f.sampler.finish()).rejects.toThrow(/final GC refused/);
    });

    it('cannot fabricate a second post-run report by finishing again', async () => {
        const f = fixture(); await f.sampler.start(); await f.sampler.finish(); f.send.mockClear();
        await expect(f.sampler.finish()).rejects.toThrow(/finished|complete|closed/i);
        expect(f.send).not.toHaveBeenCalled();
    });
});

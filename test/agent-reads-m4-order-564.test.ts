import { describe, expect, it, vi } from 'vitest';
import { measureM4Block } from '../scripts/agent-reads-m4-block.mjs';

// These ports become the real unchanged ledgerProbe/control and separately instrumented extra open in the sampler.
function rig() {
    const order: string[] = [], runs = [10, 80, 12, 11, 13].map((ms) => ({ ms, maxGapMs: ms + 1 }));
    let index = 0;
    const ports = {
        openOrdinary: vi.fn(async () => { order.push('ordinary'); return runs[index++]!; }),
        sleep: vi.fn(async (ms: number) => { order.push(`sleep ${ms}`); }),
        openControl: vi.fn(async () => { order.push('control'); return { ms: 50, maxGapMs: 51 }; }),
        openStages: vi.fn(async () => { order.push('extra diagnostic'); return { producerMs: 2, decodeMs: 3, rebuildMs: 4, totalMs: 999 }; }),
    };
    return { ports, order, runs };
}
describe('ordinary M4 opens precede separate stage acquisition (Tynn #564)', () => {
    it('keeps all five ordinary opens and their500ms spacing before controls and any extra stage open', async () => {
        const r = rig(); await measureM4Block(r.ports);
        expect(r.order).toEqual([...Array.from({ length: 5 }, () => ['ordinary', 'sleep 500']).flat(), 'control', 'extra diagnostic']);
        expect(r.ports.openOrdinary.mock.calls.every((args) => args.length === 0)).toBe(true);
    });

    it('never includes the control or slow extra open in ordinary medians, gaps or raw samples', async () => {
        const r = rig(); const result = await measureM4Block(r.ports);
        expect(result.ordinary).toEqual({ ms: 12, maxGapMs: 81, runs: r.runs });
        expect(result.control).toEqual({ ms: 50, maxGapMs: 51 });
        expect(result.stages).toEqual({ producerMs: 2, decodeMs: 3, rebuildMs: 4, totalMs: 999 });
    });

    it('does not proceed to extra opens after an ordinary acquisition failed', async () => {
        const r = rig(); r.ports.openOrdinary.mockRejectedValueOnce(new Error('ordinary acquisition failed'));
        await expect(measureM4Block(r.ports)).rejects.toThrow('ordinary acquisition failed');
        expect(r.ports.openControl).not.toHaveBeenCalled(); expect(r.ports.openStages).not.toHaveBeenCalled();
    });

    it('refuses missing stage measurements rather than substituting ordinary timings', async () => {
        const r = rig(); r.ports.openStages.mockResolvedValue({ producerMs: 2 } as never);
        await expect(measureM4Block(r.ports)).rejects.toThrow(/stage|diagnostic/i);
    });
});

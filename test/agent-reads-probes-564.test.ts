import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { busyWorkProbe, ledgerProbe, snapshotProbe } from '../scripts/agent-reads-probes.mjs';

// Execute the actual page expression against a deterministic page/clock. Count clock reads so fabricated elapsed values
// cannot impersonate a physical work loop. These expressions get no Node/process/filesystem globals.
function fixture() {
    let clock = 0, reads = 0;
    const off = vi.fn();
    const subscribeAgent = vi.fn((_id: string, callback: (detail: { rows: number[] }) => void) => {
        queueMicrotask(() => { clock += 10; callback({ rows: [0, 1, 2, 3] }); });
        return off;
    });
    const snapshot = vi.fn(async () => { clock += 5; return {}; });
    const context = {
        __touched: false,
        window: { __gauge: { reset: () => {}, max: () => 0 }, genieTest: { subscribeAgent, snapshot } },
        performance: { now: () => { reads += 1; clock += 1; return clock; } },
        setTimeout: (callback: () => void, ms: number) => { if (ms < 100_000) queueMicrotask(callback); return 1; },
        clearTimeout: () => {}, requestAnimationFrame: (callback: () => void) => queueMicrotask(callback),
    };
    return { context, off, subscribeAgent, snapshot, reads: () => reads,
        run: (expression: string) => runInNewContext(expression, context, { timeout: 1_000 }) };
}

describe('physical control page probes (Tynn #564)', () => {
    it('the normal ledger probe subscribes to and times the actual first full detail', async () => {
        const f = fixture(); const result = await f.run(ledgerProbe('agent-fixture', 4));
        expect(f.subscribeAgent).toHaveBeenCalledWith('agent-fixture', expect.any(Function));
        expect(result.ms).toBeGreaterThanOrEqual(10); expect(f.off).toHaveBeenCalledTimes(1);
    });

    it('injected ledger work consumes the page clock inside the measured operation', async () => {
        const normal = fixture(), injected = fixture();
        const base = await normal.run(ledgerProbe('agent-fixture', 4));
        const control = await injected.run(ledgerProbe('agent-fixture', 4, 50));
        expect(control.ms).toBeGreaterThan(base.ms + 40);
        expect(injected.reads()).toBeGreaterThan(normal.reads() + 40);
    });

    it('the normal snapshot probe awaits the actual bridge read', async () => {
        const f = fixture(); const ms = await f.run(snapshotProbe());
        expect(f.snapshot).toHaveBeenCalledTimes(1); expect(ms).toBeGreaterThanOrEqual(5);
    });

    it('injected snapshot work changes both elapsed time and observed physical work', async () => {
        const normal = fixture(), injected = fixture();
        const base = await normal.run(snapshotProbe()), control = await injected.run(snapshotProbe(50));
        expect(control).toBeGreaterThan(base + 40);
        expect(injected.reads()).toBeGreaterThan(normal.reads() + 40);
    });

    it('the CPU control executes work in the page instead of returning its requested budget', () => {
        const f = fixture(); const ms = f.run(busyWorkProbe(50));
        expect(ms).toBeGreaterThanOrEqual(50); expect(f.reads()).toBeGreaterThan(40);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 60_001])('refuses invalid or unbounded injected-work budget %s', (ms) => {
        expect(() => busyWorkProbe(ms)).toThrow(/work|budget|delay/i);
    });

    it('an agent ID remains data in the executable expression', async () => {
        const f = fixture(), id = "agent');globalThis.__touched=true;//";
        await f.run(ledgerProbe(id, 4));
        expect(f.subscribeAgent).toHaveBeenCalledWith(id, expect.any(Function));
        expect(f.context.__touched).toBe(false);
    });
});

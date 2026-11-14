import { describe, expect, it } from 'vitest';
import { compareRuns } from '../scripts/agent-reads-compare.mjs';

/** The bars the coordinator set for family 9a's VM rows (Tynn #564): within 1.2x of IPC, longest window gap at most 200 ms. */
const run = (over: Record<string, Record<string, number>> = {}) => ({
    m4_5000: { ms: 100, maxGapMs: 50, ...over.m4_5000 },
    m4_20000: { ms: 400, maxGapMs: 90, ...over.m4_20000 },
    m5: { windowCpuMs: 1000, hostCpuMs: 1000, maxGapMs: 40, updatesPerSec: 18, ...over.m5 },
    m6: { readMs: 20, maxGapMs: 30, pushesPerSec: 15, ...over.m6 },
    control: { blockedGapMs: 130, ...over.control },
});
const failed = (a: object, b: object) => compareRuns(a as never, b as never).filter((r: { pass: boolean }) => !r.pass).map((r: { row: string }) => r.row);

describe('the VM rows', () => {
    it('a candidate level with the baseline passes every row', () => { expect(failed(run(), run())).toEqual([]); });
    it('exactly 1.2x passes', () => { expect(failed(run(), run({ m4_5000: { ms: 120 } }))).toEqual([]); });
    it('over 1.2x on time fails that row', () => { expect(failed(run(), run({ m4_20000: { ms: 481 } }))).toEqual(['m4_20000.ms']); });
    it('over 1.2x on CPU fails', () => { expect(failed(run(), run({ m5: { hostCpuMs: 1300 } }))).toEqual(['m5.hostCpuMs']); });
    it('a gap over 200 ms fails, even when the baseline had one as bad', () => {
        expect(failed(run({ m5: { maxGapMs: 250 } }), run({ m5: { maxGapMs: 201 } }))).toEqual(['m5.maxGapMs']);
    });
    it('a gap of exactly 200 ms passes', () => { expect(failed(run(), run({ m6: { maxGapMs: 200 } }))).toEqual([]); });
    it('a missing number is a failure, never a pass', () => {
        const broken = run();
        delete (broken.m6 as Record<string, number>).readMs;
        expect(failed(run(), broken)).toEqual(['m6.readMs']);
    });
    it('a run whose gauge could not see a deliberate block proves nothing, and fails', () => {
        expect(failed(run(), run({ control: { blockedGapMs: 12 } }))).toEqual(['control.blockedGapMs']);
    });
});

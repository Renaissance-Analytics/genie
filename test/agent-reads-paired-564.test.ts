import { describe, expect, it } from 'vitest';
import { comparePairedRuns, compareRuns } from '../scripts/agent-reads-compare.mjs';

// Numeric verdict first (Tynn's 2026-11-13 ruling). Real VM pairing, per-measure injected-delay
// controls and acquisition of post-GC samples need their own script/wiring proof afterwards.
const sample = () => ({
    m4_5000: { ms: 100, maxGapMs: 50 },
    m4_20000: { ms: 400, maxGapMs: 90 },
    m5: { windowCpuMs: 1_000, hostCpuMs: 1_000, maxGapMs: 40,
        heapBeforeBytes: 1_000_000, heapAfterGcBytes: 1_100_000, gc: true },
    m6: { readMs: 20, maxGapMs: 30 },
    control: { blockedGapMs: 130 },
});
const report = () => ({ pairs: Array.from({ length: 3 }, (_, i) => ({
    order: i % 2 === 0 ? ['ipc', 'door'] : ['door', 'ipc'],
    ipc: sample(), door: sample(),
})) });
const row = (data: unknown, name: string) => comparePairedRuns(data).find((r) => r.row === name);

describe('the approved paired measurement verdict (Tynn #564)', () => {
    it('three complete alternated pairs produce all required numeric verdict rows', () => {
        const rows = comparePairedRuns(report());
        expect(rows.map((r) => r.row)).toEqual([
            'pairs.count', 'pairs.order',
            'm4_5000.ms', 'm4_20000.ms', 'm5.windowCpuMs', 'm5.hostCpuMs', 'm6.readMs',
            'm4_5000.maxGapMs', 'm4_20000.maxGapMs', 'm5.maxGapMs', 'm6.maxGapMs',
            'm5.heapAfterGc',
        ]);
        expect(rows.every((r) => r.pass)).toBe(true);
    });

    it('uses median of paired ratios, so one slow pair cannot turn a passing median into a failure', () => {
        const data = report();
        const ipc = [1, 10, 100], door = [0.1, 1_000, 110];
        data.pairs.forEach((p, i) => { p.ipc.m4_5000.ms = ipc[i]!; p.door.m4_5000.ms = door[i]!; });
        // Median ratios = 1.1, but ratio of medians = 110 / 10 = 11 (wrong verdict).
        expect(row(data, 'm4_5000.ms')).toMatchObject({ pass: true, value: 1.1, limit: 1.2 });
    });

    it('uses median of paired ratios, so unrelated fast samples cannot hide two slow pairs', () => {
        const data = report();
        const ipc = [100, 1, 10], door = [1, 2, 20];
        data.pairs.forEach((p, i) => { p.ipc.m5.hostCpuMs = ipc[i]!; p.door.m5.hostCpuMs = door[i]!; });
        // Median ratios = 2, but ratio of medians = 2 / 10 = 0.2 (wrong verdict).
        expect(row(data, 'm5.hostCpuMs')).toMatchObject({ pass: false, value: 2, limit: 1.2 });
    });

    it('refuses fewer than three pairs even if their numbers are good', () => {
        const data = report(); data.pairs.pop();
        expect(row(data, 'pairs.count')).toMatchObject({ pass: false });
    });

    it('refuses an unalternated sequence even if its numbers are good', () => {
        const data = report(); data.pairs[1]!.order = ['ipc', 'door'];
        expect(row(data, 'pairs.order')).toMatchObject({ pass: false });
    });

    it('fails a metric with a missing sample instead of dropping that pair from the median', () => {
        const data = report();
        Reflect.deleteProperty(data.pairs[1]!.door.m6, 'readMs');
        expect(row(data, 'm6.readMs')).toMatchObject({ pass: false });
    });

    it('fails a nonpositive baseline instead of manufacturing a finite ratio', () => {
        const data = report(); data.pairs[1]!.ipc.m5.windowCpuMs = 0;
        expect(row(data, 'm5.windowCpuMs')).toMatchObject({ pass: false });
    });

    it('a single gap over 200 ms fails even when the median gap is small and IPC is slower', () => {
        const data = report();
        data.pairs[1]!.ipc.m5.maxGapMs = 500;
        data.pairs[1]!.door.m5.maxGapMs = 201;
        expect(row(data, 'm5.maxGapMs')).toMatchObject({ pass: false, value: 201, limit: 200 });
    });

    it('a single post-GC heap over 120% fails even when the other pairs retained less', () => {
        const data = report(); data.pairs[1]!.door.m5.heapAfterGcBytes = 1_200_001;
        expect(row(data, 'm5.heapAfterGc')).toMatchObject({ pass: false, limit: 1.2 });
    });

    it('missing proof of GC fails even if the reported heap number is small', () => {
        const data = report(); data.pairs[1]!.door.m5.gc = false;
        expect(row(data, 'm5.heapAfterGc')).toMatchObject({ pass: false });
    });

    it('CONTROL: the existing single-pair verdict independently sees a slow candidate', () => {
        const ipc = sample(), door = sample(); door.m4_20000.ms = 481;
        expect(compareRuns(ipc, door).filter((r) => !r.pass).map((r) => r.row)).toEqual(['m4_20000.ms']);
    });

    it('CONTROL: the existing gap gauge independently refuses an unobserved artificial block', () => {
        const ipc = sample(), door = sample(); door.control.blockedGapMs = 12;
        expect(compareRuns(ipc, door).filter((r) => !r.pass).map((r) => r.row)).toEqual(['control.blockedGapMs']);
    });
});

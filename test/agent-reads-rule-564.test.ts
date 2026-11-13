import { describe, expect, it } from 'vitest';
import { comparePairedRuns } from '../scripts/agent-reads-compare.mjs';

const observation = (candidate = false) => ({
    m4_5000: { ms: candidate ? 105 : 100, maxGapMs: 10 }, m4_20000: { ms: candidate ? 105 : 100, maxGapMs: 10 },
    m5: { windowCpuMs: 100, hostCpuMs: 100, maxGapMs: 10, heapBeforeBytes: 100, heapAfterGcBytes: 110, gc: true },
    m6: { readMs: 100, maxGapMs: 10 },
    measureControls: {
        m4_5000: { metric: 'ms', value: candidate ? 200 : 100 }, m4_20000: { metric: 'ms', value: candidate ? 200 : 100 },
        m5: { metric: 'windowCpuMs', value: candidate ? 200 : 100 }, m6: { metric: 'readMs', value: candidate ? 200 : 100 },
    },
});
const report = (count = 12) => ({ pairs: Array.from({ length: count }, (_, i) => ({
    order: i % 2 === 0 ? ['ipc', 'door'] : ['door', 'ipc'], ipc: observation(), door: observation(true),
})) });
const rows = (value: unknown, scope: 'm4' | 'm5-m6' = 'm4') => comparePairedRuns(value, { scope });
const row = (value: unknown, name: string, scope: 'm4' | 'm5-m6' = 'm4') => rows(value, scope).find(r => r.row === name);

describe('approved fixed M4 acceptance rule, separate from M5/M6 (Tynn #564)', () => {
    it('requires exactly twelve pairs and only M4 metrics/gaps/controls', () => {
        const verdict = rows(report());
        expect(verdict.map(r => r.row)).toEqual(['pairs.count', 'pairs.order', 'm4_5000.ms', 'm4_20000.ms',
            'm4_5000.maxGapMs', 'm4_20000.maxGapMs', 'control.m4_5000', 'control.m4_20000']);
        expect(verdict.every(r => r.pass)).toBe(true);
        expect(row(report(), 'pairs.count')).toMatchObject({ value: 12, limit: 12, pass: true });
    });

    it.each([3, 11, 13])('refuses %s M4 pairs rather than accepting a smaller or extended sample', count => {
        expect(row(report(count), 'pairs.count')).toMatchObject({ value: count, limit: 12, pass: false });
    });

    it('CONTROL: an unalternated pair fails even when all twelve ratios are good', () => {
        const data = report(); data.pairs[7]!.order = ['ipc', 'door'];
        expect(row(data, 'pairs.order')?.pass).toBe(false);
    });

    it('CONTROL: the even median is the mean of the sixth and seventh paired ratios, with the same 1.2 bound', () => {
        const data = report(); data.pairs.forEach((pair, i) => { pair.door.m4_5000.ms = i < 6 ? 100 : 140; });
        expect(row(data, 'm4_5000.ms')).toMatchObject({ value: 1.2, limit: 1.2, pass: true });
    });

    it('CONTROL: an arbitrarily small excess above 1.2 still fails, without rounding or an absolute exemption', () => {
        const data = report(); for (const pair of data.pairs) pair.door.m4_5000.ms = 120.00001;
        expect(row(data, 'm4_5000.ms')).toMatchObject({ limit: 1.2, pass: false });
    });

    it('CONTROL: a missing twelfth observation is not removed from the ratio calculation', () => {
        const data = report(); Reflect.deleteProperty(data.pairs[11]!.door.m4_5000, 'ms');
        expect(row(data, 'm4_5000.ms')).toMatchObject({ value: null, pass: false });
    });

    it('CONTROL: one late gap above 200 ms fails even with a passing ratio median', () => {
        const data = report(); data.pairs[11]!.door.m4_5000.maxGapMs = 201;
        expect(row(data, 'm4_5000.ms')?.pass).toBe(true);
        expect(row(data, 'm4_5000.maxGapMs')).toMatchObject({ value: 201, limit: 200, pass: false });
    });

    it('CONTROL: physical controls must still cross the same failure bound', () => {
        const data = report(); for (const pair of data.pairs) pair.door.measureControls.m4_5000.value = 120;
        expect(row(data, 'control.m4_5000')).toMatchObject({ value: 1.2, limit: 1.2, pass: false });
    });

    it('accepts complete M4 evidence without inventing M5/M6 measurements in those twelve pairs', () => {
        const data = report(); for (const pair of data.pairs) for (const mode of ['ipc', 'door'] as const) {
            Reflect.deleteProperty(pair[mode], 'm5'); Reflect.deleteProperty(pair[mode], 'm6');
        }
        expect(rows(data).every(r => r.pass)).toBe(true);
    });

    it('keeps exactly the M5/M6 rows and unchanged bounds in their separate three-pair verdict', () => {
        const verdict = rows(report(3), 'm5-m6');
        expect(verdict.map(r => r.row)).toEqual(['pairs.count', 'pairs.order', 'm5.windowCpuMs', 'm5.hostCpuMs', 'm6.readMs',
            'm5.maxGapMs', 'm6.maxGapMs', 'm5.heapAfterGc', 'control.m5', 'control.m6']);
        expect(verdict.every(r => r.pass)).toBe(true);
    });

    it('judges M5/M6 independently without demanding extra M4 opens in their three pairs', () => {
        const data = report(3); for (const pair of data.pairs) for (const mode of ['ipc', 'door'] as const) {
            Reflect.deleteProperty(pair[mode], 'm4_5000'); Reflect.deleteProperty(pair[mode], 'm4_20000');
        }
        expect(rows(data, 'm5-m6').every(r => r.pass)).toBe(true);
    });

    it('CONTROL: M5/M6 still need their original three complete alternating pairs', () => {
        expect(row(report(3), 'pairs.count', 'm5-m6')).toMatchObject({ value: 3, limit: 3, pass: true });
    });
});

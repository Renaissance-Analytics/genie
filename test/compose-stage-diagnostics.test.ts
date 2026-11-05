import { expect, it, vi } from 'vitest';
const helper = async () => { const path: string = '../src/main/compose-stage-diagnostics.js'; return import(path); };

it('an absent observer creates no diagnostics and reads no clock, with the same clock as a positive control', async () => {
    const { composeStageDiagnostics } = await helper(), clock = vi.fn(() => 100);
    expect(composeStageDiagnostics(undefined, clock)).toBeNull(); expect(clock).not.toHaveBeenCalled();
    const control = composeStageDiagnostics(vi.fn(), clock); control.begin('positive'); expect(clock).toHaveBeenCalled();
});
it('reports numeric start/end/ready costs without wrapping the operation', async () => {
    const { composeStageDiagnostics } = await helper(), report = vi.fn(); let at = 20;
    const diagnostics = composeStageDiagnostics(report, () => at);
    at = 22; diagnostics.begin('store'); at = 29; diagnostics.end(); at = 30; diagnostics.ready();
    expect(report.mock.calls.map(call => call[0])).toEqual([
        { stage: 'store:begin', elapsedMs: 0, totalMs: 2 },
        { stage: 'store', elapsedMs: 7, totalMs: 9 },
        { stage: 'ready', elapsedMs: 1, totalMs: 10 },
    ]);
});
it('a throwing diagnostic observer cannot throw from any checkpoint', async () => {
    const { composeStageDiagnostics } = await helper(), observer = vi.fn(() => { throw new Error('synthetic observer'); });
    const diagnostics = composeStageDiagnostics(observer, () => 10);
    expect(() => { diagnostics.begin('store'); diagnostics.end(); diagnostics.ready(); }).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(3);
});

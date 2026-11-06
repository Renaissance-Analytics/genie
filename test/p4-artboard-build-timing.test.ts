import { expect, it, vi } from 'vitest';

const load = async () => { const file: string = '../src/main/artboard-build-timing.js'; return import(file); };
function fixture() {
    let time = 10, cpu = { user: 1000, system: 2000 };
    const trace = { events: [] as Array<Record<string, unknown>>, dropped: 0 };
    const ports = { enabled: true, trace, now: vi.fn(() => time), cpuUsage: vi.fn(() => cpu) };
    return { trace, ports, advance: () => { time = 60; cpu = { user: 4000, system: 4000 }; } };
}

it('records asynchronous native build elapsed and process CPU without calling that a synchronous span', async () => {
    const f = fixture(), { beginArtboardBuildTiming } = await load(), finish = beginArtboardBuildTiming('native-build', 'async', f.ports);
    f.advance(); finish();
    expect(f.trace.events).toEqual([{ phase: 'native-build', mode: 'async', startedMs: 10, endedMs: 60, elapsedMs: 50, processCpuMs: 5, syncMs: null }]);
});
it('records synchronous projection and resolve spans on the same clock', async () => {
    const f = fixture(), { beginArtboardBuildTiming } = await load();
    const resolve = beginArtboardBuildTiming('resolve-board', 'sync', f.ports), projection = beginArtboardBuildTiming('projection', 'sync', f.ports);
    f.advance(); resolve(); projection();
    expect(f.trace.events).toEqual(['resolve-board', 'projection'].map(phase => ({ phase, mode: 'sync', startedMs: 10, endedMs: 60, elapsedMs: 50, processCpuMs: 5, syncMs: 50 })));
});
it('takes no clock or CPU readings when disabled or without an owned trace store', async () => {
    const f = fixture(), { beginArtboardBuildTiming } = await load();
    beginArtboardBuildTiming('native-build', 'async', { ...f.ports, enabled: false })();
    beginArtboardBuildTiming('projection', 'sync', { ...f.ports, trace: undefined })();
    expect(f.ports.now).not.toHaveBeenCalled(); expect(f.ports.cpuUsage).not.toHaveBeenCalled(); expect(f.trace.events).toEqual([]);
});
it('finishes a phase only once', async () => {
    const f = fixture(), { beginArtboardBuildTiming } = await load(), finish = beginArtboardBuildTiming('projection', 'sync', f.ports);
    f.advance(); finish(); finish(); expect(f.trace.events).toHaveLength(1); expect(f.trace.dropped).toBe(0);
});
it('keeps at most 128 phase records and reports dropped measurements', async () => {
    const f = fixture(), { beginArtboardBuildTiming } = await load();
    for (let i = 0; i < 132; i++) beginArtboardBuildTiming('projection', 'sync', f.ports)();
    expect(f.trace.events).toHaveLength(128); expect(f.trace.dropped).toBe(4);
    expect(Object.keys(f.trace.events[0]!)).toEqual(['phase', 'mode', 'startedMs', 'endedMs', 'elapsedMs', 'processCpuMs', 'syncMs']);
});
it('a diagnostic clock failing before a phase cannot change the application call', async () => {
    const f = fixture(), { beginArtboardBuildTiming } = await load();
    f.ports.now.mockImplementation(() => { throw new Error('synthetic clock failure'); });
    expect(() => beginArtboardBuildTiming('native-build', 'async', f.ports)()).not.toThrow(); expect(f.trace.events).toEqual([]);
});
it('a diagnostic sink failing at completion cannot replace an application result or error', async () => {
    const f = fixture(), { beginArtboardBuildTiming } = await load(), finish = beginArtboardBuildTiming('projection', 'sync', f.ports);
    Object.freeze(f.trace.events); f.advance(); expect(finish).not.toThrow(); expect(f.trace.events).toEqual([]);
});

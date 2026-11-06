import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const load = async () => { const file: string = '../scripts/artboard-gap-probe.mjs'; return import(file); };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function clock() {
    let now = 10, wall = 1_700_000_000_010;
    return { ports: { now: () => now, wallNow: () => wall }, advance: (ms: number, wallMs = ms) => { now += ms; wall += wallMs; } };
}
it('records every main/page gap over100ms with actual monotonic and wall endpoints', async () => {
    const { createWallGapGauge } = await load(), c = clock(), gauge = createWallGapGauge(c.ports);
    c.advance(100); expect(gauge.beat()).toBeNull();
    c.advance(648); gauge.beat(); c.advance(151); gauge.beat();
    expect(gauge.snapshot()).toMatchObject({ ticks: 3, maxGapMs: 648, dropped: 0, gaps: [
        { startedMs: 110, endedMs: 758, startedWallMs: 1_700_000_000_110, endedWallMs: 1_700_000_000_758, gapMs: 648, latenessMs: 648 },
        { startedMs: 758, endedMs: 909, startedWallMs: 1_700_000_000_758, endedWallMs: 1_700_000_000_909, gapMs: 151, latenessMs: 151 },
    ] });
});
it('keeps actual wall observations across a clock correction instead of deriving wall start from elapsed time', async () => {
    const { createWallGapGauge } = await load(), c = clock(), gauge = createWallGapGauge(c.ports);
    c.advance(648, -200); gauge.beat();
    expect(gauge.snapshot().gaps[0]).toMatchObject({ startedMs: 10, endedMs: 658, startedWallMs: 1_700_000_000_010, endedWallMs: 1_699_999_999_810, gapMs: 648 });
});
it('the independent host records lateness at least100ms beyond its200ms heartbeat', async () => {
    const { createWallGapGauge } = await load(), c = clock(), gauge = createWallGapGauge({ ...c.ports, intervalMs: 200, inclusive: true });
    c.advance(200); expect(gauge.beat()).toBeNull(); c.advance(299); expect(gauge.beat()).toBeNull(); c.advance(300); gauge.beat();
    expect(gauge.snapshot().gaps).toEqual([expect.objectContaining({ gapMs: 300, latenessMs: 100, startedMs: 509, endedMs: 809 })]);
});
it('bounds records with an explicit drop count, isolates snapshots and resets all row observations', async () => {
    const { createWallGapGauge } = await load(), c = clock(), gauge = createWallGapGauge(c.ports);
    for (let i = 0; i < 1027; i++) { c.advance(101); gauge.beat(); }
    const snapshot = gauge.snapshot(); expect(snapshot.gaps).toHaveLength(1024); expect(snapshot.dropped).toBe(3);
    snapshot.gaps[0].gapMs = -1; expect(gauge.snapshot().gaps[0].gapMs).toBe(101);
    gauge.reset(); expect(gauge.snapshot()).toEqual({ ticks: 0, maxGapMs: 0, dropped: 0, gaps: [] });
    c.advance(103); gauge.beat(); expect(gauge.snapshot().gaps).toEqual([expect.objectContaining({ gapMs: 103 })]);
});

function hostPorts(env: Record<string, string> = {}) {
    const c = clock(); let callback = () => {};
    const timer = { unref: vi.fn() }, emit = vi.fn(), clearInterval = vi.fn();
    const setInterval = vi.fn((fn: () => void, _ms: number) => { callback = fn; return timer; });
    return { ...c, emit, timer, ports: { ...c.ports, env, pid: 42, emit, setInterval, clearInterval }, tick: (ms: number) => { c.advance(ms); callback(); } };
}
it.each([{}, { GENIE_ARTBOARD_MEASURE_ALLOW: '1' }, { GENIE_PAGE_PROBE: '1', ELECTRON_RUN_AS_NODE: '1' }])('host gauge stays completely inert without all owned measurement flags: %j', async env => {
    const f = hostPorts(env), { installMeasurementHostHeartbeat } = await load(), probe = installMeasurementHostHeartbeat(f.ports);
    expect(probe.enabled).toBe(false); expect(f.ports.setInterval).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled(); probe.stop();
});
it('logs independent host installation, subsecond gaps and positive beats with no payload or environment data', async () => {
    const f = hostPorts({ GENIE_ARTBOARD_MEASURE_ALLOW: '1', GENIE_PAGE_PROBE: '1', ELECTRON_RUN_AS_NODE: '1', SECRET: 'never-emit' });
    const { installMeasurementHostHeartbeat } = await load(), probe = installMeasurementHostHeartbeat(f.ports);
    expect(probe.enabled).toBe(true); expect(f.ports.setInterval).toHaveBeenCalledWith(expect.any(Function), 200); expect(f.timer.unref).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'installed', role: 'host', pid: 42, intervalMs: 200, thresholdMs: 100 }));
    for (const ms of [200, 200, 848, 200, 200]) f.tick(ms);
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gap', pid: 42, gapMs: 848, latenessMs: 648, startedWallMs: 1_700_000_000_410, endedWallMs: 1_700_000_001_258 }));
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'beat', pid: 42, ticks: 5, dropped: 0 }));
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain('never-emit'); probe.stop(); probe.stop(); expect(f.ports.clearInterval).toHaveBeenCalledTimes(1);
});

function launchPorts(enabled = true) {
    const home = path.resolve('owned-measurement-home', '.genie'), entry = path.resolve('dist/main/host.js'), preloadUrl = pathToFileURL(path.resolve('scripts/artboard-host-gauge.mjs')).href;
    const child = { pid: 42 }, spawn = vi.fn((_file: string, _args: string[], _options: unknown) => child);
    const env = { GENIE_ARTBOARD_MEASURE_ALLOW: enabled ? '1' : '0', GENIE_PAGE_PROBE: '1' };
    const ports = { env, child: { spawn }, path, syncBuiltinESMExports: vi.fn() };
    const options = { home, entry, preloadUrl, execPath: process.execPath };
    const spawnOptions = { detached: true, windowsHide: true, stdio: ['ignore', 12, 12], env: { ...env, GENIE_HOME: home, ELECTRON_RUN_AS_NODE: '1', GENIE_HOST_BUILD: 'synthetic-build' } };
    return { options, ports, spawn, child, spawnOptions };
}
it('adds the script preload only to the exact owned host launch and preserves its options and child identity', async () => {
    const f = launchPorts(), { installMeasurementHostLaunch } = await load(), probe = installMeasurementHostLaunch(f.options, f.ports);
    expect(f.ports.child.spawn(process.execPath, [f.options.entry], f.spawnOptions)).toBe(f.child);
    expect(f.spawn).toHaveBeenCalledWith(process.execPath, ['--import', f.options.preloadUrl, f.options.entry], f.spawnOptions);
    expect(probe.snapshot()).toMatchObject({ enabled: true, installed: true, injectedPids: [42] }); probe.stop();
});
it('never instruments unrelated or foreign-home children and preserves thrown errors and restoration', async () => {
    const f = launchPorts(), { installMeasurementHostLaunch } = await load(), probe = installMeasurementHostLaunch(f.options, f.ports);
    f.ports.child.spawn('other-program', [f.options.entry], f.spawnOptions);
    const foreign = { ...f.spawnOptions, env: { ...f.spawnOptions.env, GENIE_HOME: path.resolve('foreign-home') } };
    f.ports.child.spawn(process.execPath, [f.options.entry], foreign);
    f.ports.child.spawn(process.execPath, ['other-entry.js'], f.spawnOptions);
    expect(f.spawn.mock.calls.map(call => call[1])).toEqual([[f.options.entry], [f.options.entry], ['other-entry.js']]);
    const error = new Error('synthetic launch refused'); f.spawn.mockImplementationOnce(() => { throw error; });
    expect(() => f.ports.child.spawn(process.execPath, [f.options.entry], f.spawnOptions)).toThrow(error);
    probe.stop(); probe.stop(); expect(f.ports.child.spawn).toBe(f.spawn); expect(f.ports.syncBuiltinESMExports).toHaveBeenCalledTimes(2);
});
it('a disabled launch probe installs no hook and changes no child arguments', async () => {
    const f = launchPorts(false), { installMeasurementHostLaunch } = await load(), probe = installMeasurementHostLaunch(f.options, f.ports);
    expect(probe.snapshot()).toMatchObject({ enabled: false, installed: false, injectedPids: [] });
    expect(f.ports.child.spawn).toBe(f.spawn); expect(f.ports.syncBuiltinESMExports).not.toHaveBeenCalled(); probe.stop();
});
it('the real page helper returns all timestamped gaps and the drop count from its heartbeat gauge', async () => {
    const file: string = '../scripts/artboard-measure-page.mjs', { measureArtboardPage } = await import(file);
    const gauge = { beat: vi.fn(), snapshot: () => ({ ticks: 9, maxGapMs: 648, dropped: 0, gaps: [{ startedMs: 100, endedMs: 748, startedWallMs: 1000, endedWallMs: 1648, gapMs: 648, latenessMs: 648 }] }) };
    const create = vi.fn(() => gauge);
    vi.stubGlobal('window', { genieTest: { artboard: { read: async () => ({ posts: [{ id: 'p', kind: 'html', html: '<p>Kept</p>' }] }) }, workspaces: { settings: async () => ({ ok: true }) } } });
    const result = await measureArtboardPage({ workspaceId: 'work', postId: 'p' }, create);
    expect(create).toHaveBeenCalledOnce(); expect(gauge.beat).toHaveBeenCalled();
    expect(result.heartbeat).toMatchObject({ dropped: 0, gaps: gauge.snapshot().gaps });
});

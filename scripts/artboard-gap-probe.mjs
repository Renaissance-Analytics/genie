/** CI/VM diagnostics only. Actual wall observations are retained even if the wall clock changes. */
export function createWallGapGauge(options = {}) {
    const now = options.now ?? (() => performance.now()), wallNow = options.wallNow ?? (() => Date.now());
    const intervalMs = options.intervalMs ?? 0, thresholdMs = options.thresholdMs ?? 100;
    let last = now(), lastWall = wallNow(), ticks = 0, maxGapMs = 0, dropped = 0, gaps = [];
    return {
        beat() {
            const endedMs = now(), endedWallMs = wallNow(), gapMs = Math.max(0, endedMs - last), latenessMs = Math.max(0, gapMs - intervalMs);
            const event = { startedMs: last, endedMs, startedWallMs: lastWall, endedWallMs, gapMs, latenessMs };
            last = endedMs; lastWall = endedWallMs; ticks++; maxGapMs = Math.max(maxGapMs, gapMs);
            if (!(options.inclusive ? latenessMs >= thresholdMs : latenessMs > thresholdMs)) return null;
            if (gaps.length < 1024) gaps.push(event); else dropped++;
            return { ...event };
        },
        snapshot: () => ({ ticks, maxGapMs, dropped, gaps: gaps.map(event => ({ ...event })) }),
        stats: () => ({ ticks, maxGapMs, dropped }),
        reset() { last = now(); lastWall = wallNow(); ticks = 0; maxGapMs = 0; dropped = 0; gaps = []; },
    };
}

/** Runs only in the owned measurement host. Its stdout already belongs to that host's log. */
export function installMeasurementHostHeartbeat(injected) {
    const ports = injected ?? { env: process.env, pid: process.pid, now: () => performance.now(), wallNow: () => Date.now(),
        setInterval, clearInterval, emit: value => process.stdout.write('ARTBOARD_HOST_GAUGE ' + JSON.stringify(value) + '\n') };
    if (ports.env.GENIE_ARTBOARD_MEASURE_ALLOW !== '1' || ports.env.GENIE_PAGE_PROBE !== '1' || ports.env.ELECTRON_RUN_AS_NODE !== '1') return { enabled: false, stop() {} };
    const gauge = createWallGapGauge({ now: ports.now, wallNow: ports.wallNow, intervalMs: 200, inclusive: true });
    const emit = value => ports.emit({ role: 'host', pid: ports.pid, ...value });
    emit({ kind: 'installed', intervalMs: 200, thresholdMs: 100, startedMs: ports.now(), startedWallMs: ports.wallNow() });
    const timer = ports.setInterval(() => {
        const gap = gauge.beat(), state = gauge.stats();
        if (gap) emit({ kind: 'gap', ...gap, ticks: state.ticks, dropped: state.dropped });
        if (state.ticks % 5 === 0) emit({ kind: 'beat', ticks: state.ticks, dropped: state.dropped, endedWallMs: ports.wallNow() });
    }, 200);
    timer.unref?.(); let stopped = false;
    return { enabled: true, stop() { if (stopped) return; stopped = true; ports.clearInterval(timer); const state = gauge.stats(); emit({ kind: 'stopped', ticks: state.ticks, dropped: state.dropped, endedWallMs: ports.wallNow() }); } };
}

/** Serialized before the app entry. Only the exact owned independent-host launch receives the preload. */
export function installMeasurementHostLaunch(options, injected) {
    const ports = injected ?? { env: process.env, child: process.getBuiltinModule('node:child_process'), path: process.getBuiltinModule('node:path'), syncBuiltinESMExports: process.getBuiltinModule('node:module').syncBuiltinESMExports };
    const enabled = ports.env.GENIE_ARTBOARD_MEASURE_ALLOW === '1' && ports.env.GENIE_PAGE_PROBE === '1';
    const original = ports.child.spawn, originalExec = ports.child.execFile, injectedPids = []; let stopped = false, dropped = 0;
    const same = (a, b) => typeof a === 'string' && typeof b === 'string' && ports.path.relative(ports.path.resolve(a), ports.path.resolve(b)) === '';
    function wrapped(...args) {
        const [file, argv, spawnOptions] = args, env = spawnOptions?.env;
        if (args.length !== 3 || !same(file, options.execPath) || !Array.isArray(argv) || argv.length !== 1 || !same(argv[0], options.entry)
            || env?.ELECTRON_RUN_AS_NODE !== '1' || env.GENIE_ARTBOARD_MEASURE_ALLOW !== '1' || env.GENIE_PAGE_PROBE !== '1' || !same(env.GENIE_HOME, options.home) || typeof env.GENIE_HOST_BUILD !== 'string') return Reflect.apply(original, this, args);
        const forwarded = [...args]; forwarded[1] = ['--import', options.preloadUrl, ...argv];
        const child = Reflect.apply(original, this, forwarded);
        if (Number.isSafeInteger(child?.pid) && child.pid > 0 && !injectedPids.includes(child.pid)) { if (injectedPids.length < 16) injectedPids.push(child.pid); else dropped++; }
        return child;
    }
    /*
     * On Windows the product starts the host through genie-launch.exe (#1628), asynchronously: `execFile(launcher,
     * ['detach', log, execPath, entry], options, callback)`, which prints the host's pid. The same exact launch gets the
     * same preload, before the entry, and the pid it prints is recorded.
     */
    function wrappedExec(...args) {
        const [file, argv, spawnOptions, callback] = args, env = spawnOptions?.env;
        if (args.length !== 4 || typeof callback !== 'function' || typeof file !== 'string' || ports.path.basename(file).toLowerCase() !== 'genie-launch.exe' || !Array.isArray(argv) || argv.length !== 4 || argv[0] !== 'detach'
            || !same(argv[2], options.execPath) || !same(argv[3], options.entry)
            || env?.ELECTRON_RUN_AS_NODE !== '1' || env.GENIE_ARTBOARD_MEASURE_ALLOW !== '1' || env.GENIE_PAGE_PROBE !== '1' || !same(env.GENIE_HOME, options.home) || typeof env.GENIE_HOST_BUILD !== 'string') return Reflect.apply(originalExec, this, args);
        const forwarded = [file, ['detach', argv[1], argv[2], '--import', options.preloadUrl, argv[3]], spawnOptions, (error, stdout, stderr) => {
            const pid = Number(String(stdout ?? '').trim());
            if (!error && Number.isSafeInteger(pid) && pid > 0 && !injectedPids.includes(pid)) { if (injectedPids.length < 16) injectedPids.push(pid); else dropped++; }
            callback(error, stdout, stderr);
        }];
        return Reflect.apply(originalExec, this, forwarded);
    }
    if (enabled) { ports.child.spawn = wrapped; ports.child.execFile = wrappedExec; ports.syncBuiltinESMExports(); }
    // execFile may be wrapped again over this one (the ArtBoard trace wraps it to time each call): still this one's, through it.
    const installed = () => ports.child.spawn === wrapped;
    return {
        snapshot: () => ({ enabled, installed: enabled && !stopped && installed(), injectedPids: [...injectedPids], dropped }),
        stop() { if (stopped) return; stopped = true; if (enabled && installed()) { ports.child.spawn = original; if (ports.child.execFile === wrappedExec) ports.child.execFile = originalExec; ports.syncBuiltinESMExports(); } },
    };
}

const HOST_PHASE = 'ARTBOARD_HOST_PHASE ';
const PHASES = ['native-build', 'resolve-board', 'metadata-build', 'artifact-open', 'projection'];

/**
 * THE ARTBOARD BUILD RUNS IN GENIE-HOST (Tynn #898 step 2d-4b): its phase timing (src/main/artboard-build-timing.ts) is
 * recorded there, under the same flags as the heartbeat. Nothing is held in memory: each phase is written to the host's
 * log as it ends, with its wall window, so the in-memory cap never drops one. Fixed diagnostic fields only.
 */
export function installMeasurementHostPhases(injected) {
    const ports = injected ?? { env: process.env, pid: process.pid, wallNow: () => Date.now(), globals: globalThis, emit: line => process.stdout.write(line + '\n') };
    if (ports.env.GENIE_ARTBOARD_MEASURE_ALLOW !== '1' || ports.env.GENIE_PAGE_PROBE !== '1' || ports.env.ELECTRON_RUN_AS_NODE !== '1') return { enabled: false };
    const events = [];
    Object.defineProperty(events, 'push', { value: (...items) => {
        for (const e of items) {
            const endedWallMs = ports.wallNow(), elapsedMs = Number.isFinite(e?.elapsedMs) ? e.elapsedMs : 0;
            ports.emit(HOST_PHASE + JSON.stringify({ role: 'host', pid: ports.pid, kind: 'phase', phase: e?.phase, mode: e?.mode, elapsedMs, startedWallMs: endedWallMs - Math.round(elapsedMs), endedWallMs }));
        }
        return 0;
    } });
    ports.globals.__artboardPhases = { events, dropped: 0 };
    return { enabled: true };
}

/** The phases an owned host (by pid) ended inside a row's wall window. A partial or malformed owned record fails the row. */
export function readHostPhases(text, pids, fromWallMs, toWallMs) {
    const events = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(HOST_PHASE)) continue;
        let value; try { value = JSON.parse(line.slice(HOST_PHASE.length)); } catch { throw new Error('an owned host phase record is incomplete'); }
        if (value?.role !== 'host' || !pids.includes(value.pid)) continue;
        if (value.kind !== 'phase' || !PHASES.includes(value.phase) || !['async', 'sync'].includes(value.mode) || !['elapsedMs', 'startedWallMs', 'endedWallMs'].every(key => Number.isFinite(value[key]))) throw new Error('invalid owned host phase fields');
        if (value.endedWallMs < fromWallMs || value.endedWallMs > toWallMs) continue;
        if (events.length >= 4096) throw new Error('too many owned host phase records');
        events.push({ phase: value.phase, mode: value.mode, elapsedMs: value.elapsedMs, startedWallMs: value.startedWallMs, endedWallMs: value.endedWallMs });
    }
    return { events, dropped: 0 };
}

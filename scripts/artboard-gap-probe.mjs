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
    const original = ports.child.spawn, originalSync = ports.child.execFileSync, injectedPids = []; let stopped = false, dropped = 0;
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
     * On Windows the product starts the host through genie-launch.exe (#1628): `execFileSync(launcher, ['detach', log,
     * execPath, entry])`, which prints the host's pid. The same exact launch gets the same preload, before the entry.
     */
    function wrappedSync(...args) {
        const [file, argv, spawnOptions] = args, env = spawnOptions?.env;
        if (args.length !== 3 || typeof file !== 'string' || ports.path.basename(file).toLowerCase() !== 'genie-launch.exe' || !Array.isArray(argv) || argv.length !== 4 || argv[0] !== 'detach'
            || !same(argv[2], options.execPath) || !same(argv[3], options.entry)
            || env?.ELECTRON_RUN_AS_NODE !== '1' || env.GENIE_ARTBOARD_MEASURE_ALLOW !== '1' || env.GENIE_PAGE_PROBE !== '1' || !same(env.GENIE_HOME, options.home) || typeof env.GENIE_HOST_BUILD !== 'string') return Reflect.apply(originalSync, this, args);
        const forwarded = [...args]; forwarded[1] = ['detach', argv[1], argv[2], '--import', options.preloadUrl, argv[3]];
        const said = Reflect.apply(originalSync, this, forwarded);
        const pid = Number(String(said).trim());
        if (Number.isSafeInteger(pid) && pid > 0 && !injectedPids.includes(pid)) { if (injectedPids.length < 16) injectedPids.push(pid); else dropped++; }
        return said;
    }
    if (enabled) { ports.child.spawn = wrapped; ports.child.execFileSync = wrappedSync; ports.syncBuiltinESMExports(); }
    const installed = () => ports.child.spawn === wrapped && ports.child.execFileSync === wrappedSync;
    return {
        snapshot: () => ({ enabled, installed: enabled && !stopped && installed(), injectedPids: [...injectedPids], dropped }),
        stop() { if (stopped) return; stopped = true; if (enabled && installed()) { ports.child.spawn = original; ports.child.execFileSync = originalSync; ports.syncBuiltinESMExports(); } },
    };
}

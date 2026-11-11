/**
 * THE UI-LAG ROW'S OWN genie-host, WITH AN INSPECTOR (Tynn #524). Serialized into window main before its entry runs, as
 * the ArtBoard row's launch hook (scripts/artboard-gap-probe.mjs): only the exact launch of THIS app's host, on THIS
 * row's home, is changed, and only by adding `--inspect=127.0.0.1:<port>` before the host's entry, so the row can gauge
 * and profile genie-host the way it does window main. Both of the product's launches are covered: a plain spawn, and
 * genie-launch.exe on Windows (#1628), which prints the host's pid.
 */
export function installUiLagHostLaunch(options, injected) {
    const ports = injected ?? { env: process.env, child: process.getBuiltinModule('node:child_process'), path: process.getBuiltinModule('node:path'), syncBuiltinESMExports: process.getBuiltinModule('node:module').syncBuiltinESMExports };
    const enabled = ports.env.GENIE_UI_LAG_MEASURE === '1' && ports.env.GENIE_PAGE_PROBE === '1';
    const original = ports.child.spawn, originalExec = ports.child.execFile, pids = [];
    const inspect = `--inspect=127.0.0.1:${options.inspectPort}`;
    const same = (a, b) => typeof a === 'string' && typeof b === 'string' && ports.path.relative(ports.path.resolve(a), ports.path.resolve(b)) === '';
    const ours = (env) => env?.ELECTRON_RUN_AS_NODE === '1' && env.GENIE_UI_LAG_MEASURE === '1' && env.GENIE_PAGE_PROBE === '1' && same(env.GENIE_HOME, options.home) && typeof env.GENIE_HOST_BUILD === 'string';
    function wrapped(...args) {
        const [file, argv, spawnOptions] = args;
        if (args.length !== 3 || !same(file, options.execPath) || !Array.isArray(argv) || argv.length !== 1 || !same(argv[0], options.entry) || !ours(spawnOptions?.env)) return Reflect.apply(original, this, args);
        const child = Reflect.apply(original, this, [file, [inspect, ...argv], spawnOptions]);
        if (Number.isSafeInteger(child?.pid) && pids.length < 16) pids.push(child.pid);
        return child;
    }
    function wrappedExec(...args) {
        const [file, argv, spawnOptions, callback] = args;
        if (args.length !== 4 || typeof callback !== 'function' || typeof file !== 'string' || ports.path.basename(file).toLowerCase() !== 'genie-launch.exe' || !Array.isArray(argv) || argv.length !== 4 || argv[0] !== 'detach'
            || !same(argv[2], options.execPath) || !same(argv[3], options.entry) || !ours(spawnOptions?.env)) return Reflect.apply(originalExec, this, args);
        return Reflect.apply(originalExec, this, [file, ['detach', argv[1], argv[2], inspect, argv[3]], spawnOptions, (error, stdout, stderr) => {
            const pid = Number(String(stdout ?? '').trim());
            if (!error && Number.isSafeInteger(pid) && pid > 0 && pids.length < 16) pids.push(pid);
            callback(error, stdout, stderr);
        }]);
    }
    if (enabled) { ports.child.spawn = wrapped; ports.child.execFile = wrappedExec; ports.syncBuiltinESMExports(); }
    let stopped = false;
    return {
        snapshot: () => ({ enabled, installed: enabled && !stopped && ports.child.spawn === wrapped, pids: [...pids] }),
        stop() {
            if (stopped) return; stopped = true;
            if (ports.child.spawn === wrapped) ports.child.spawn = original;
            if (ports.child.execFile === wrappedExec) ports.child.execFile = originalExec;
            ports.syncBuiltinESMExports();
        },
    };
}

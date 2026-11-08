#!/usr/bin/env node
/**
 * UI LAG DURING A WRITE-HEAVY BUILD, MEASURED (Tynn #274 / #429). CI / test VM only: it starts its own app, on a home and
 * ports of its own, and never touches another.
 *
 * The owner: "I am getting a lot of UI lag"; "even mouse movement over genie starts slowing down"; "the ui lag is only in
 * genie". And the host split's P2 row, never measured as written: "a write-heavy build never blocks the window more than
 * 50 ms".
 *
 * What it does, in the real app: a workspace that is a git repository, a Terminals panel in it, and in that terminal a
 * build (scripts/perf-lag/ui-lag-build.mjs) that rewrites thousands of files in the workspace and prints progress, while
 * the mouse moves over the window and keys are typed — first with the terminal on screen, then with the Files panel.
 * Two passes: the first with nothing but the gauges (its numbers are the row's), the second with V8's sampling profiler on
 * window main and on the page, so each of the worst gaps is shown with what the thread was doing during it.
 *
 * Gauges, each proven on a deliberate 120 ms block first (the control phase): window main's timer lateness (10 ms
 * interval); the page's timer lateness, its long tasks and its frame gaps; each input event's round trip through the
 * browser (CDP waits for the input to be handled) and its delay to the page's handler and to the next frame;
 * genie-host's timer lateness (its own preload, as the ArtBoard row). Calls the page made to main are counted by method.
 *
 *   node scripts/ui-lag-cdp.mjs [--budget]     --budget: exit 1 when window main is late by more than 50 ms during the build
 */
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { installUiLagHostLaunch } from './perf-lag/ui-lag-host-launch.mjs';
import { budgetVerdict, createGapGauge, firstSampleWith, indexProfile, pagingVerdict, pushVerdict, retryOnTimeout, sliceVerdict, summarize, throughputVerdict, traceSummary, windowProfile, worstGaps } from './perf-lag/ui-lag-analyze.mjs';

const WIN = process.platform === 'win32', OUT = resolve('smoke-out'), PORT = 9362, INSPECT = 9363, HOST_INSPECT = 9364, started = Date.now(), sessions = [];
// Ten pairs (the coordinator's (b), Tynn #536): a stable median of paired differences on the Linux runner.
const SLICE_PAIRS = 10, SLICE_MS = 1200, SETTLE_MS = 400;
// One pair traced in the profiled pass (Tynn #537): what every thread of the window did, terminal on against off.
const TRACE_PAIR = 4, TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'gpu', 'viz', 'benchmark', 'renderer.scheduler', 'v8.execute'];
const BUDGET = process.argv.includes('--budget'), BUDGET_MS = 50, HOST_BUDGET_MS = 100, IDLE_MS = 6000, BUILD_MS = 52000, CONTROL_MS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const demand = (ok, reason) => { if (!ok) throw new Error(reason); };
const json = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const head = () => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; } };
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await read().catch(() => null); if (v) return v; await sleep(100); } throw new Error(`${label} was not ready`); }
function logTail(path, max = 65536) {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, max)); let at = 0;
        while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, size - bytes.length + at); if (!n) break; at += n; }
        return bytes.subarray(0, at).toString('utf8');
    } finally { closeSync(fd); }
}
class Cdp {
    next = 0; pending = new Map(); listeners = new Map();
    on(method, fn) { this.listeners.set(method, fn); return () => this.listeners.delete(method); }
    static async connect(url) {
        const c = new Cdp(); c.socket = new WebSocket(url); let timer;
        c.socket.addEventListener('message', (event) => { const frame = JSON.parse(event.data); if (frame.method === 'Debugger.paused') c.paused = frame.params; if (frame.method) c.listeners.get(frame.method)?.(frame.params); { const done = c.pending.get(frame.id); if (typeof done === 'function') done(frame); } c.pending.delete(frame.id); });
        c.socket.addEventListener('close', () => { c.dead ??= 'CDP closed'; for (const done of c.pending.values()) done({ error: { message: c.dead } }); c.pending.clear(); });
        try { await Promise.race([new Promise((ok, no) => { c.socket.addEventListener('open', ok, { once: true }); c.socket.addEventListener('error', no, { once: true }); }), new Promise((_, no) => { timer = setTimeout(() => no(new Error('CDP connect timed out')), 10000); })]); }
        finally { clearTimeout(timer); }
        sessions.push(c); return c;
    }
    async evaluate(expression) {
        const result = await this.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page exception');
        return result.result.value;
    }
    async request(method, params) {
        if (this.dead || this.socket.readyState !== 1) throw new Error(this.dead ?? 'CDP is not connected');
        const id = ++this.next; let timer;
        try {
            const frame = await Promise.race([new Promise((ok) => { this.pending.set(id, ok); this.socket.send(JSON.stringify({ id, method, params })); }), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`CDP operation timed out: ${method}`)), 120000); })]);
            if (frame.error) throw new Error(frame.error.message); return frame.result;
        } finally { clearTimeout(timer); this.pending.delete(id); }
    }
}

/** Window main's gauge and the page's calls to it, by method. Serialized into main. */
function installMainGauge(create) {
    const ipc = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').ipcMain;
    const s = globalThis.__uiLag = { gauge: create({ intervalMs: 10, thresholdMs: 16, now: () => performance.now() }), calls: [] };
    s.timer = setInterval(() => s.gauge.beat(), 10);
    s.listener = (_event, action, _handle, text) => {
        if (action !== 'frame' || typeof text !== 'string') return;
        try { const m = JSON.parse(text); if (m.method && s.calls.length < 200000) s.calls.push([performance.now(), m.method]); } catch { /* not a call */ }
    };
    ipc.on('genie:local-frame', s.listener);
    s.stop = () => { clearInterval(s.timer); ipc.removeListener('genie:local-frame', s.listener); };
    return { now: performance.now() };
}

/** genie-host's gauge (Tynn #524): its timer lateness, every gap over 16 ms. Serialized into genie-host. */
function installHostGauge(create) {
    const s = globalThis.__uiLagHost = { gauge: create({ intervalMs: 10, thresholdMs: 16, now: () => performance.now() }), spawns: [] };
    s.timer = setInterval(() => s.gauge.beat(), 10);
    /*
     * EVERY PROCESS genie-host CREATES ON ITS OWN THREAD (Tynn #532): Windows creates a process synchronously on the
     * calling thread, so each one is a stall of its own (one git spawn held genie-host 295 ms on the runner). Counted where
     * every spawn, execFile and fork of this process passes: ChildProcess.prototype.spawn. Only the program's name is kept.
     */
    const { ChildProcess } = process.getBuiltinModule('node:child_process');
    const original = ChildProcess.prototype.spawn;
    ChildProcess.prototype.spawn = function (options) {
        const file = typeof options?.file === 'string' ? options.file.split(/[\\/]/).pop().slice(0, 40) : '?';
        const next = Array.isArray(options?.args) && typeof options.args[1] === 'string' ? options.args[1].split(/[\\/]/).pop().slice(0, 40) : '';
        // Genie's own executable started as the APP (not as Node): a window, the Genie browser or the updater, once each.
        const app = options?.file === process.execPath && Array.isArray(options?.envPairs) && !options.envPairs.includes('ELECTRON_RUN_AS_NODE=1');
        if (s.spawns.length < 5000) s.spawns.push([performance.now(), app ? `app launch: ${file}` : next ? `${file} ${next}` : file]);
        return original.call(this, options);
    };
    s.stop = () => { clearInterval(s.timer); if (ChildProcess.prototype.spawn !== original) ChildProcess.prototype.spawn = original; };
    return { now: performance.now() };
}
/** The spawn gauge's positive control: one process genie-host creates on its own thread, on purpose. */
function uiLagControlSpawnHost() {
    const { execFile } = process.getBuiltinModule('node:child_process');
    return new Promise((done) => { execFile(process.execPath, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }, () => done(true)); });
}

/** The page's gauges: timer lateness, long tasks, frame gaps, input delays, the Files pushes. Serialized into the page. */
function installPageGauge(create) {
    const s = window.__uiLag = { gauge: create({ intervalMs: 10, thresholdMs: 16, now: () => performance.now() }), longtasks: [], frames: [], frameTimes: [], inputs: [], files: [], lastFrame: null };
    s.timer = setInterval(() => s.gauge.beat(), 10);
    if (typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) if (s.longtasks.length < 20000) s.longtasks.push({ startedMs: e.startTime, endedMs: e.startTime + e.duration, ms: e.duration }); }).observe({ type: 'longtask' });
        s.longtaskSupported = true;
    }
    const frame = (t) => {
        if (document.visibilityState !== 'visible') s.lastFrame = null;
        else { if (s.lastFrame !== null && t - s.lastFrame > 50 && s.frames.length < 20000) s.frames.push({ startedMs: s.lastFrame, endedMs: t, ms: t - s.lastFrame }); s.lastFrame = t; if (s.frameTimes.length < 100000) s.frameTimes.push(t); }
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const input = (kind) => (e) => {
        const at = performance.now(), stamp = e.timeStamp;
        requestAnimationFrame((t) => { if (s.inputs.length < 50000) s.inputs.push({ kind, at: stamp, handlerMs: at - stamp, frameMs: t - stamp }); });
    };
    addEventListener('mousemove', input('mouse'), { capture: true, passive: true });
    addEventListener('keydown', input('key'), { capture: true, passive: true });
    window.genieLocalProtocol.onFrame((action, _handle, text) => {
        if (action !== 'frame' || typeof text !== 'string') return;
        if (!text.includes('"local-files"')) return;
        try { const m = JSON.parse(text); if (m.kind === 'event' && m.channel === 'local-files' && s.files.length < 50000) s.files.push([performance.now(), text.length]); } catch { /* not ours */ }
    });
    // Where the person types: a field of the probe's own, so typing reaches no shell and no agent.
    const field = document.createElement('textarea');
    field.setAttribute('data-ui-lag-typing', '');
    Object.assign(field.style, { position: 'fixed', right: '8px', bottom: '8px', width: '220px', height: '48px', zIndex: '2147483647', opacity: '0.9' });
    document.body.appendChild(field);
    return { now: performance.now(), longtasks: s.longtaskSupported === true };
}

/**
 * WHAT IS COMPOSITED OVER THE WINDOW (Tynn #537): every element with a backdrop filter or a filter, where it is and what it
 * says. The trace of run 42489513576 showed, on and off alike, a backdrop-filter render surface and the whole window
 * damaged on every drawn frame, each draw ~45 ms in Linux's software compositor. Serialized into the page.
 */
function uiLagComposited() {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if ((cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.filter && cs.filter !== 'none')) {
            const r = el.getBoundingClientRect();
            const data = Object.fromEntries([...el.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'role' || a.name.startsWith('aria-')).map((a) => [a.name, a.value.slice(0, 60)]));
            let up = el.parentElement, owner = null;
            while (up && !owner) { if ([...up.attributes].some((a) => a.name.startsWith('data-') || a.name === 'role')) owner = up.outerHTML.slice(0, up.outerHTML.indexOf('>') + 1).slice(0, 200); up = up.parentElement; }
            out.push({ tag: el.tagName.toLowerCase(), backdrop: cs.backdropFilter, filter: cs.filter, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden', data, owner, cls: String(el.className).slice(0, 160), text: (el.textContent ?? '').trim().slice(0, 120) });
        }
    }
    // And every dialog open, with what it says: the element over the window belongs to one.
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].map((d) => ({ data: Object.fromEntries([...d.attributes].filter((a) => a.name.startsWith('data-') || a.name.startsWith('aria-')).map((a) => [a.name, a.value.slice(0, 60)])), text: (d.textContent ?? '').trim().split(String.fromCharCode(10)).join(' ').slice(0, 300) }));
    return { filtered: out.slice(0, 20), dialogs: dialogs.slice(0, 5) };
}

/** A deliberate block, the gauges' positive control and the profiles' alignment marker. Serialized into each thread. */
function uiLagControlBusyMain(ms) { const start = performance.now(); let x = 0; while (performance.now() - start < ms) for (let i = 0; i < 10000; i += 1) x += i; return { start, end: performance.now(), x: x > 0 }; }
function uiLagControlBusyHost(ms) { const start = performance.now(); let x = 0; while (performance.now() - start < ms) for (let i = 0; i < 10000; i += 1) x += i; return { start, end: performance.now(), x: x > 0 }; }
function uiLagControlBusyPage(ms) { const start = performance.now(); let x = 0; while (performance.now() - start < ms) for (let i = 0; i < 10000; i += 1) x += i; return { start, end: performance.now(), x: x > 0 }; }

/** The mouse moves over the window and keys are typed, each round trip timed, until `untilFn()` or `ms`. */
async function drive(page, { ms, untilFn = async () => false, width, height }) {
    const mouse = [], keys = [], end = Date.now() + ms;
    let i = 0, lastCheck = 0;
    while (Date.now() < end) {
        const tick = Date.now(), a = i / 12;
        const x = Math.round(width / 2 + Math.cos(a) * width * 0.3), y = Math.round(height / 2 + Math.sin(a) * height * 0.3);
        let t = performance.now();
        await page.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        mouse.push(performance.now() - t);
        if (i % 4 === 0) {
            const ch = String.fromCharCode(97 + (i / 4) % 26);
            t = performance.now();
            await page.request('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
            keys.push(performance.now() - t);
            await page.request('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
        }
        i += 1;
        if (Date.now() - lastCheck > 500) { lastCheck = Date.now(); if (await untilFn()) break; }
        const rest = 16 - (Date.now() - tick);
        if (rest > 0) await sleep(rest);
    }
    return { mouse, keys };
}

/** Each source-mapped bundle frame named by its original source and line (the renderer bundle is minified). */
function sourceMapper() {
    const maps = new Map();
    const mapFor = (url) => {
        if (maps.has(url)) return maps.get(url);
        let map = null;
        try { const path = fileURLToPath(url); if (existsSync(`${path}.map`)) map = new SourceMap(JSON.parse(readFileSync(`${path}.map`, 'utf8'))); } catch { map = null; }
        maps.set(url, map); return map;
    };
    return (f) => {
        if (!f.url?.startsWith('file:')) return null;
        const map = mapFor(f.url.split('?')[0]);
        if (!map || f.lineNumber < 0) return null;
        const e = map.findEntry(f.lineNumber, Math.max(0, f.columnNumber ?? 0));
        if (!e?.originalSource) return null;
        const src = String(e.originalSource).replace(/\\/g, '/');
        const at = src.search(/(src|node_modules)\//);
        return `${f.functionName || e.name || '(anonymous)'} ${at >= 0 ? src.slice(at) : src.split('/').pop()}:${e.originalLine + 1}`;
    };
}
const isOwn = (frame) => /\bsrc\/(main|renderer|core)\/|dist\/main\//.test(frame);

let app, page, main, hostCdp, root, hostRecord, hostLaunch, failure = null, code = 1;
const passes = [], savedProfiles = {}, result = { budget: null, controls: {}, limits: [] };
try {
    demand(process.env.CI === 'true' || process.env.GENIE_UI_LAG_ALLOW === '1' || (process.platform === 'linux' && process.env.USER === 'genie'), 'refused: run only in CI or an explicitly allowed test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT, HOST_INSPECT]) { let occupied = false; try { await targets(port); occupied = true; } catch (e) { if (e.name === 'TimeoutError') occupied = true; } demand(!occupied, `debugger port ${port} occupied; no app touched`); }
    root = mkdtempSync(join(tmpdir(), 'genie-ui-lag-')); const workspace = join(root, 'workspace'), runtime = join(root, '.genie', 'runtime');
    mkdirSync(workspace); mkdirSync(OUT, { recursive: true });
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1', GENIE_UI_LAG_MEASURE: '1' };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15000, windowsHide: true });
    // THE WORKSPACE: a git repository of 1,500 tracked sources, its build output ignored, and the build script.
    for (let d = 0; d < 30; d += 1) { mkdirSync(join(workspace, 'src', `m${d}`), { recursive: true }); for (let f = 0; f < 50; f += 1) writeFileSync(join(workspace, 'src', `m${d}`, `s${f}.js`), `export const s${d}_${f} = ${f};\n`); }
    writeFileSync(join(workspace, '.gitignore'), 'dist/\n');
    copyFileSync(resolve('scripts/perf-lag/ui-lag-build.mjs'), join(workspace, 'build.mjs'));
    const git = (args) => execFileSync('git', ['-c', 'user.name=UI lag fixture', '-c', 'user.email=ui-lag@example.test', ...args], { cwd: workspace, stdio: 'pipe', timeout: 90000, windowsHide: true });
    // THE FIXTURE GIT, BOUNDED (Tynn #536): spawnSync git ETIMEDOUT on the Windows runner (genie#1718). A timed-out try is
    // started again from no repository, at most twice; how long each took is in the result.
    result.fixtureGit = retryOnTimeout(() => { git(['init']); git(['add', '.']); git(['commit', '-m', 'ui lag baseline']); }, { attempts: 2, reset: () => rmSync(join(workspace, '.git'), { recursive: true, force: true, maxRetries: 5 }) }).tries;

    const fd = openSync(join(OUT, 'ui-lag-electron.log'), 'w');
    const electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron'), args = ['.', `--remote-debugging-port=${PORT}`, `--inspect-brk=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`];
    if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', fd, fd] }); closeSync(fd); app.on('error', (e) => console.error(e.message));
    // genie-host is started with an inspector of its own, by a hook installed before main's entry runs (Tynn #524).
    main = await Cdp.connect((await until('owned paused main inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl);
    await main.request('Debugger.enable', {}); await main.request('Runtime.runIfWaitingForDebugger', {});
    const paused = await until('owned entry pause', async () => main.paused);
    const hostOptions = { home: join(root, '.genie'), entry: resolve('dist/main/host.js'), inspectPort: HOST_INSPECT };
    const installed = await main.request('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, returnByValue: true,
        expression: `globalThis.__uiLagHostLaunch=(${installUiLagHostLaunch.toString()})(Object.assign(${JSON.stringify(hostOptions)},{execPath:process.execPath}));true` });
    if (installed.exceptionDetails) throw new Error(installed.exceptionDetails.exception?.description ?? 'host gauge installation failed');
    await main.request('Debugger.resume', {}); await main.request('Debugger.disable', {});

    const target = await until('owned app page', async () => { hostRecord ??= json(join(runtime, 'host.json')); return (await targets(PORT)).find((t) => t.type === 'page' && /index\.html/.test(t.url)); }, 240000);
    page = await Cdp.connect(target.webSocketDebuggerUrl);
    await waitForPageProbe(page);
    await until('ready page connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"'), 60000);
    hostRecord ??= json(join(runtime, 'host.json'));
    hostCdp = await Cdp.connect((await until('owned genie-host inspector', async () => (await targets(HOST_INSPECT))[0], 30000)).webSocketDebuggerUrl);
    const box = await page.evaluate('({ width: innerWidth, height: innerHeight })');
    console.log(`UI_LAG_COMPOSITED ready ${JSON.stringify(await page.evaluate(`(${uiLagComposited.toString()})()`))}`.slice(0, 6000));

    // The workspace, and a Terminals panel in a tab of its own (as smoke-cdp's check 49 places one).
    await page.evaluate(`window.location.hash = '#genie://workspace/tynn'; true`);
    await until('the workspace surface', () => page.evaluate(`Boolean(document.querySelector('[data-surface="workspace"] [data-workspace-tab="add"]'))`), 30000);
    await page.evaluate(`document.querySelector('[data-workspace-tab="add"]').click(); true`);
    await until('the panel designer', () => page.evaluate(`Boolean(document.querySelector('[data-designed-tab] [data-add-panel="terminal"]'))`), 15000);
    await page.evaluate(`document.querySelector('[data-designed-tab] [data-add-panel="terminal"]').click(); true`);
    await until('the terminal pane', () => page.evaluate(`Boolean(document.querySelector('[data-panel="terminal"] [data-terminal-pane] .xterm-rows'))`), 30000);
    await sleep(1500);
    console.log(`UI_LAG_COMPOSITED terminal-placed ${JSON.stringify(await page.evaluate(`(${uiLagComposited.toString()})()`))}`.slice(0, 6000));
    const rowsText = `(document.querySelector('[data-terminal-pane] .xterm-rows')?.innerText ?? '').replace(/\\n/g, '')`;

    await main.evaluate(`(${installMainGauge.toString()})((${createGapGauge.toString()}))`);
    await hostCdp.evaluate(`(${installHostGauge.toString()})((${createGapGauge.toString()}))`);
    const pageGauge = await page.evaluate(`(${installPageGauge.toString()})((${createGapGauge.toString()}))`);
    const focusField = () => page.evaluate(`document.querySelector('[data-ui-lag-typing]').focus(); true`);
    const filesOpen = () => page.evaluate(`document.querySelector('[data-action="toggle-files"]')?.getAttribute('data-panel-open') === 'true'`);
    const toggleFiles = async (want) => {
        if ((await filesOpen()) === want) return;
        await page.evaluate(`document.querySelector('[data-action="toggle-files"]').click(); true`);
        await until(`the Files panel ${want ? 'open' : 'closed'}`, async () => (await filesOpen()) === want, 15000);
    };

    /** A Chromium trace of `fn`'s span on the page's session: every thread of the window, the GPU and compositor too. */
    async function traced(fn) {
        const events = [];
        const stopData = page.on('Tracing.dataCollected', (p) => { for (const e of p.value) events.push(e); });
        const complete = new Promise((done) => { const stop = page.on('Tracing.tracingComplete', () => { stop(); done(); }); });
        // A trace that cannot start is reported, and the slice still runs: the trace explains, the gauges decide.
        try { await page.request('Tracing.start', { traceConfig: { includedCategories: TRACE_CATEGORIES, recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' }); }
        catch (e) { stopData(); console.log(`UI_LAG_TRACE_UNAVAILABLE ${e.message}`); return { value: await fn(), events: null }; }
        let value;
        try { value = await fn(); }
        finally { await page.request('Tracing.end', {}); await Promise.race([complete, sleep(30000)]); stopData(); }
        return { value, events };
    }

    async function runPass(label, profiled) {
        const phases = [];
        const mark = async (name) => ({ name, mainMs: (await main.evaluate('performance.now()')), pageMs: await page.evaluate('performance.now()'), hostMs: await hostCdp.evaluate('performance.now()'), wallMs: Date.now() });
        // genie-host is profiled in BOTH passes (Tynn #536): every host gap, the budget pass's included, comes with its stack.
        // Window main and the page only in the second (their gauges decide the main and page budgets in the first).
        for (const c of profiled ? [main, page, hostCdp] : [hostCdp]) { await c.request('Profiler.enable', {}); await c.request('Profiler.setSamplingInterval', { interval: 1000 }); await c.request('Profiler.start', {}); }
        await sleep(1500);
        // CONTROL: one deliberate block on each thread. Every gauge must see it, and each profile must name it.
        await focusField();
        const c0 = await mark('control');
        const mainCtl = await main.evaluate(`(${uiLagControlBusyMain.toString()})(${CONTROL_MS})`);
        await sleep(200);
        // In a task of its own (a timer): a block inside CDP's own evaluate is not a long task the page's observer reports.
        const hostCtl = await hostCdp.evaluate(`(${uiLagControlBusyHost.toString()})(${CONTROL_MS})`);
        await hostCdp.evaluate(`(${uiLagControlSpawnHost.toString()})()`);
        await sleep(200);
        const pageCtl = await page.evaluate(`new Promise((done) => setTimeout(() => done((${uiLagControlBusyPage.toString()})(${CONTROL_MS})), 0))`);
        await sleep(400);
        phases.push({ ...c0, end: await mark('control-end'), mainCtl, hostCtl, pageCtl, input: { mouse: [], keys: [] } });

        let p = await mark('idle');
        let input = await drive(page, { ms: IDLE_MS, width: box.width, height: box.height });
        phases.push({ ...p, end: await mark('idle-end'), input });

        // The build, typed into the workspace's terminal as a person would; then the mouse and the keys elsewhere.
        const run = `${label}${Date.now() % 100000}`, done = join(workspace, 'dist', 'ui-lag-build.json');
        await page.evaluate(`document.querySelector('[data-terminal-pane] textarea')?.focus(); true`);
        await page.request('Input.insertText', { text: `node build.mjs ${BUILD_MS} ${run}` });
        await page.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await page.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await until('the build to start printing', () => page.evaluate(`${rowsText}.includes('[build ${run}]')`), 20000);
        await focusField();
        /*
         * THE TERMINAL ON AND OFF SCREEN, INTERLEAVED (Tynn #536): the same build runs throughout, so each pair of slices
         * differs only in whether the terminal is drawn. Each slice's first SETTLE_MS (the switch itself, a re-attach) is
         * not measured.
         */
        const termTab = await page.evaluate("document.querySelector('[data-workspace-tab^=\"tab:\"]')?.getAttribute('data-workspace-tab') ?? null");
        demand(typeof termTab === 'string', 'the terminal\'s tab is in the workspace\'s tab strip');
        const show = async (tab) => { await page.evaluate(`document.querySelector('[data-workspace-tab="${tab}"]').click(); true`); };
        p = await mark('build-terminal');
        const slices = [], mouse = [], keys = [], traces = {};
        for (let k = 0; k < SLICE_PAIRS; k += 1) {
            for (const [cond, tab] of [['on', termTab], ['off', 'home']]) {
                await show(tab);
                await sleep(SETTLE_MS);
                await focusField();
                const slice = async () => {
                    const from = await page.evaluate('performance.now()');
                    const d = await drive(page, { ms: SLICE_MS, width: box.width, height: box.height });
                    return { d, from, to: await page.evaluate('performance.now()') };
                };
                let s, trace = null;
                if (profiled && k === TRACE_PAIR) { const t = await traced(slice); s = t.value; trace = t.events; } else s = await slice();
                mouse.push(...s.d.mouse); keys.push(...s.d.keys);
                if (profiled && k === TRACE_PAIR) console.log(`UI_LAG_COMPOSITED ${cond} ${JSON.stringify(await page.evaluate(`(${uiLagComposited.toString()})()`))}`.slice(0, 6000));
                if (trace?.length) { writeFileSync(join(OUT, `ui-lag-trace-${cond}.json`), JSON.stringify({ traceEvents: trace })); traces[cond] = traceSummary(trace); }
                slices.push({ cond, from: s.from, to: s.to });
            }
        }
        await show(termTab);
        phases.push({ ...p, end: await mark('build-terminal-end'), input: { mouse, keys }, slices, traces });
        await toggleFiles(true); await focusField();
        p = await mark('build-files');
        const finished = async () => json(done)?.run === run;
        input = await drive(page, { ms: BUILD_MS + 20000, untilFn: finished, width: box.width, height: box.height });
        phases.push({ ...p, end: await mark('build-files-end'), input });
        const build = json(done);
        demand(build?.run === run && build.writes > 0, `the ${label} build ran to its end (${JSON.stringify(build)})`);
        await toggleFiles(false);
        await until('the terminal again', () => page.evaluate(`Boolean(document.querySelector('[data-panel="terminal"] [data-terminal-pane] .xterm-rows'))`), 30000);
        const profiles = {};
        for (const [name, c] of profiled ? [['main', main], ['page', page], ['host', hostCdp]] : [['host', hostCdp]]) { profiles[name] = (await c.request('Profiler.stop', {})).profile; await c.request('Profiler.disable', {}); }
        return { label, profiled, run, build, phases, profiles };
    }

    for (const [label, profiled] of [['gauges', false], ['profiled', true]]) {
        const pass = await runPass(label, profiled);
        const mainState = await main.evaluate('({ gauge: globalThis.__uiLag.gauge.snapshot(), calls: globalThis.__uiLag.calls.splice(0) })');
        const hostState = await hostCdp.evaluate('({ gauge: globalThis.__uiLagHost.gauge.snapshot(), spawns: globalThis.__uiLagHost.spawns.splice(0) })');
        const pageState = await page.evaluate('(() => { const s = window.__uiLag; return { gauge: s.gauge.snapshot(), longtasks: s.longtasks.splice(0), frames: s.frames.splice(0), frameTimes: s.frameTimes.splice(0), inputs: s.inputs.splice(0), files: s.files.splice(0) }; })()');
        await main.evaluate('globalThis.__uiLag.gauge.reset(); true'); await hostCdp.evaluate('globalThis.__uiLagHost.gauge.reset(); true'); await page.evaluate('window.__uiLag.gauge.reset(); true');
        passes.push({ ...pass, mainState, hostState, pageState });
    }

    // THE NUMBERS, per pass and phase.
    hostLaunch = await main.evaluate('globalThis.__uiLagHostLaunch?.snapshot()');
    const mapper = sourceMapper();
    for (const pass of passes) {
        const hostIdx = pass.profiles?.host ? indexProfile(pass.profiles.host, mapper) : null, mainIdx = pass.profiles?.main ? indexProfile(pass.profiles.main, mapper) : null, pageIdx = pass.profiles?.page ? indexProfile(pass.profiles.page, mapper) : null;
        const ctl = pass.phases[0];
        // Profile clock = gauge clock + offset, from the control block each profile must contain.
        const mainOffset = mainIdx ? (firstSampleWith(mainIdx, 'uiLagControlBusyMain') ?? NaN) - ctl.mainCtl.start : null;
        const pageOffset = pageIdx ? (firstSampleWith(pageIdx, 'uiLagControlBusyPage') ?? NaN) - ctl.pageCtl.start : null;
        const hostOffset = hostIdx ? (firstSampleWith(hostIdx, 'uiLagControlBusyHost') ?? NaN) - ctl.hostCtl.start : null;
        pass.alignment = { mainOffsetMs: mainOffset, pageOffsetMs: pageOffset, hostOffsetMs: hostOffset };
        pass.rows = pass.phases.map((ph) => {
            const inMain = (x) => x >= ph.mainMs && x <= ph.end.mainMs, inPage = (x) => x >= ph.pageMs && x <= ph.end.pageMs;
            const mainGaps = worstGaps(pass.mainState.gauge.gaps, ph.mainMs, ph.end.mainMs, 8);
            const pageGaps = worstGaps(pass.pageState.gauge.gaps, ph.pageMs, ph.end.pageMs, 5);
            const hostGapsIn = worstGaps(pass.hostState.gauge.gaps, ph.hostMs, ph.end.hostMs, 8);
            const longtasks = pass.pageState.longtasks.filter((l) => l.endedMs >= ph.pageMs && l.startedMs <= ph.end.pageMs);
            const frames = worstGaps(pass.pageState.frames, ph.pageMs, ph.end.pageMs, 5);
            const inputs = pass.pageState.inputs.filter((x) => inPage(x.at));
            const calls = {};
            for (const [t, m] of pass.mainState.calls) if (inMain(t)) calls[m] = (calls[m] ?? 0) + 1;
            const files = pass.pageState.files.filter(([t]) => inPage(t));
            const row = {
                phase: ph.name, ms: Math.round(ph.end.wallMs - ph.wallMs),
                main: { worstMs: Math.round(mainGaps[0]?.ms ?? 0), over50: pass.mainState.gauge.gaps.filter((g) => g.ms > BUDGET_MS && g.endedMs >= ph.mainMs && g.startedMs <= ph.end.mainMs).length, gaps: mainGaps },
                page: { worstMs: Math.round(pageGaps[0]?.ms ?? 0), gaps: pageGaps, longtasks: { count: longtasks.length, totalMs: Math.round(longtasks.reduce((a, l) => a + l.ms, 0)), worst: [...longtasks].sort((a, b) => b.ms - a.ms).slice(0, 5) }, frameGaps: frames },
                input: { mouseRtt: summarize(ph.input.mouse), keyRtt: summarize(ph.input.keys), mouseHandler: summarize(inputs.filter((x) => x.kind === 'mouse').map((x) => x.handlerMs)), mouseToFrame: summarize(inputs.filter((x) => x.kind === 'mouse').map((x) => x.frameMs)), keyToFrame: summarize(inputs.filter((x) => x.kind === 'key').map((x) => x.frameMs)) },
                host: { worstMs: Math.round(hostGapsIn[0]?.ms ?? 0), over50: pass.hostState.gauge.gaps.filter((g) => g.ms > BUDGET_MS && g.endedMs >= ph.hostMs && g.startedMs <= ph.end.hostMs).length, gaps: hostGapsIn,
                    spawns: (() => { const own = pass.hostState.spawns.filter(([t]) => t >= ph.hostMs && t <= ph.end.hostMs); const by = {}; for (const [, f] of own) by[f] = (by[f] ?? 0) + 1; return { count: own.length, by }; })() },
                ...(ph.traces && Object.keys(ph.traces).length ? { traces: ph.traces } : {}),
                ...(ph.slices ? { slices: ph.slices.map((sl) => {
                    const own = pass.pageState.inputs.filter((x) => x.kind === 'mouse' && x.at >= sl.from && x.at <= sl.to).map((x) => x.frameMs);
                    const gaps = pass.pageState.frames.filter((g) => g.endedMs >= sl.from && g.startedMs <= sl.to).map((g) => g.ms);
                    const frames = pass.pageState.frameTimes.filter((t) => t >= sl.from && t <= sl.to).length;
                    return { cond: sl.cond, count: own.length, p95: summarize(own).p95, worstGapMs: Math.round(Math.max(0, ...gaps)), fps: Math.round(frames / ((sl.to - sl.from) / 1000)) };
                }) } : {}),
                filesPushes: { count: files.length, bytes: files.reduce((a, [, n]) => a + n, 0), maxBytes: Math.max(0, ...files.map(([, n]) => n)), sizes: files.map(([, n]) => n) },
                calls,
            };
            if (mainIdx && Number.isFinite(mainOffset)) {
                row.mainProfile = windowProfile(mainIdx, ph.mainMs + mainOffset, ph.end.mainMs + mainOffset, { top: 5, isOwn });
                row.mainGapStacks = mainGaps.slice(0, 5).map((g) => ({ gapMs: Math.round(g.ms), ...windowProfile(mainIdx, g.startedMs + mainOffset, g.endedMs + mainOffset, { top: 3, isOwn }) }));
            }
            if (hostIdx && Number.isFinite(hostOffset)) {
                row.hostProfile = windowProfile(hostIdx, ph.hostMs + hostOffset, ph.end.hostMs + hostOffset, { top: 5, isOwn });
                row.hostGapStacks = hostGapsIn.slice(0, 5).map((g) => ({ gapMs: Math.round(g.ms), ...windowProfile(hostIdx, g.startedMs + hostOffset, g.endedMs + hostOffset, { top: 3, isOwn }) }));
            }
            if (pageIdx && Number.isFinite(pageOffset)) {
                row.pageProfile = windowProfile(pageIdx, ph.pageMs + pageOffset, ph.end.pageMs + pageOffset, { top: 5, isOwn });
                if (ph.slices && row.slices) {
                    // THE TERMINAL ON SCREEN AGAINST OFF, SLICE BY SLICE (Tynn #537): each slice's page time and its top frames, and
                    // the frames summed over each condition, so a cost only some "on" slices pay shows where it is.
                    const perSlice = ph.slices.map((sl, k) => ({ cond: sl.cond, p95: row.slices[k]?.p95, count: row.slices[k]?.count, ...windowProfile(pageIdx, sl.from + pageOffset, sl.to + pageOffset, { top: 3, depth: 14, isOwn }) }));
                    const sum = (cond) => {
                        const own = new Map(), ms = { js: 0, program: 0, gc: 0, idle: 0 };
                        for (const x of perSlice.filter((y) => y.cond === cond)) {
                            for (const k of Object.keys(ms)) ms[k] += x.ms[k];
                            for (const f of x.ownFrames) own.set(f.frame, (own.get(f.frame) ?? 0) + f.ms);
                        }
                        return { ms: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)])), own: [...own].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([frame, v]) => ({ frame, ms: Math.round(v) })) };
                    };
                    row.sliceProfiles = { perSlice: perSlice.map((x) => ({ cond: x.cond, p95: x.p95, count: x.count, ms: x.ms, top: x.stacks[0]?.stack?.slice(0, 300) ?? null })), on: sum('on'), off: sum('off') };
                }
                const worstPage = [...longtasks].sort((a, b) => b.ms - a.ms).slice(0, 5);
                row.pageLongtaskStacks = worstPage.map((l) => ({ longtaskMs: Math.round(l.ms), ...windowProfile(pageIdx, l.startedMs + pageOffset, l.endedMs + pageOffset, { top: 3, isOwn }) }));
            }
            return row;
        });
        if (pass.profiles) savedProfiles[pass.label] = pass.profiles;
        delete pass.profiles; // written to their own files below, not into the result
    }

    // THE CONTROLS. A gauge that cannot see a 120 ms block it was shown proves nothing by reading zero.
    for (const pass of passes) {
        const ctl = pass.rows[0];
        demand(ctl.main.worstMs >= CONTROL_MS * 0.8, `${pass.label}: window main's gauge saw the deliberate ${CONTROL_MS} ms block (${ctl.main.worstMs} ms)`);
        demand(ctl.host.spawns.count >= 1, `${pass.label}: the spawn gauge counted the process genie-host was made to create on its own thread (${JSON.stringify(ctl.host.spawns)})`);
        demand(ctl.host.worstMs >= CONTROL_MS * 0.8, `${pass.label}: genie-host's gauge saw the deliberate ${CONTROL_MS} ms block (${ctl.host.worstMs} ms)`);
        demand(ctl.page.worstMs >= CONTROL_MS * 0.8, `${pass.label}: the page's gauge saw the deliberate ${CONTROL_MS} ms block (${ctl.page.worstMs} ms)`);
        if (pageGauge.longtasks) demand(ctl.page.longtasks.worst[0]?.ms >= CONTROL_MS * 0.8, `${pass.label}: the long-task observer saw the deliberate block`);
        for (const row of pass.rows.slice(1)) {
            demand(row.input.mouseRtt.count > 20 && row.input.mouseHandler.count > 0, `${pass.label}/${row.phase}: the mouse moved and the page saw it`);
            demand(row.input.keyRtt.count > 5 && row.input.keyToFrame.count > 0, `${pass.label}/${row.phase}: keys were typed and the page saw them`);
        }
        demand(pass.rows.filter((r) => r.phase.startsWith('build')).some((r) => r.filesPushes.count > 0), `${pass.label}: the build's writes reached the page as Files pushes`);
        if (pass.profiled) {
            demand(Number.isFinite(pass.alignment.mainOffsetMs) && Number.isFinite(pass.alignment.pageOffsetMs) && Number.isFinite(pass.alignment.hostOffsetMs), `${pass.label}: each profile holds its control block (alignment ${JSON.stringify(pass.alignment)})`);
            demand(/uiLagControlBusyMain/.test(ctl.mainGapStacks?.[0]?.stacks?.[0]?.stack ?? ''), `${pass.label}: main's worst control gap is attributed to the control block`);
        }
        else demand(Number.isFinite(pass.alignment.hostOffsetMs), `${pass.label}: genie-host's profile holds its control block (alignment ${JSON.stringify(pass.alignment)})`);
        result.controls[pass.label] = 'passed';
    }
    demand(hostLaunch?.pids?.length > 0, 'genie-host was started with the row\'s inspector');

    // Every gap of the unprofiled pass's build phases, not only each phase's worst few: `over` is the true count.
    const build = passes[0].phases.filter((ph) => ph.name.startsWith('build'));
    const mainBudget = budgetVerdict(passes[0].mainState.gauge.gaps.filter((g) => build.some((ph) => g.endedMs >= ph.mainMs && g.startedMs <= ph.end.mainMs)), BUDGET_MS);
    // THE FILES STATE BUDGET (Tynn #522): pages per files.state with the Files panel open, bounded and not growing with the
    // session: the second pass's build runs after the first's, with twice the paths changed before it.
    const paging = pagingVerdict(passes.map((p) => { const r = p.rows.find((x) => x.phase === 'build-files'); return { pass: p.label, states: r?.calls['files.state'] ?? 0, pageNext: r?.calls['page.next'] ?? 0 }; }));
    // THE FILES PUSH BUDGET (Tynn #523): bytes per push to the page with the Files panel open during the build.
    const pushes = pushVerdict(passes.map((p) => ({ pass: p.label, sizes: p.rows.find((x) => x.phase === 'build-files')?.filesPushes.sizes ?? [] })));
    for (const p of passes) for (const r of p.rows) delete r.filesPushes.sizes; // counted above; not printed per push
    // THE HOST SPAWN BUDGET (Tynn #532): genie-host creates NO process on its own thread during the build. Its git and
    // its helpers' processes are created by its spawn-host child (Windows creates a process synchronously on the calling
    // thread). Counted, not timed: a count does not depend on how slow the runner is that day.
    const hostSpawns = passes.map((p) => ({ pass: p.label, ...p.rows.filter((r) => r.phase.startsWith('build')).reduce((a, r) => { for (const [f, n] of Object.entries(r.host.spawns.by)) { if (f.startsWith('app launch:')) a.apps[f] = (a.apps[f] ?? 0) + n; else { a.count += n; a.by[f] = (a.by[f] ?? 0) + n; } } return a; }, { count: 0, by: {}, apps: {} }) }));
    const spawnsOk = hostSpawns.every((h) => h.count === 0);
    // THE HOST BUDGET (Tynn #524): genie-host late by no more than 100 ms during the build. It runs the agents, the
    // terminals and the watcher: a stall there is every window's, even when window main is idle.
    const hostBudget = budgetVerdict(passes[0].hostState.gauge.gaps.filter((g) => build.some((ph) => g.endedMs >= ph.hostMs && g.startedMs <= ph.end.hostMs)), HOST_BUDGET_MS);
    // THE PAGE WHILE A TERMINAL STREAMS (Tynn #525): the mouse's delay to a frame against this run's idle, and no long frame gap.
    // THE PAGE BUDGET (Tynn #525, from a distribution since #536): the terminal on screen against off, the same build.
    const termSlices = passes[0].rows.find((r) => r.phase === 'build-terminal')?.slices ?? [];
    const pageBudget = sliceVerdict({ on: termSlices.filter((x) => x.cond === 'on'), off: termSlices.filter((x) => x.cond === 'off') });
    // THE THROUGHPUT BUDGET (Tynn #537): the input the page keeps up with, terminal on screen against off, the same slices.
    const throughput = throughputVerdict({ on: termSlices.filter((x) => x.cond === 'on'), off: termSlices.filter((x) => x.cond === 'off') });
    result.budget = { ok: mainBudget.ok && paging.ok && pushes.ok && spawnsOk && hostBudget.ok && pageBudget.ok && throughput.ok, main: mainBudget, paging, pushes, hostSpawns, host: hostBudget, page: pageBudget, throughput };
    code = BUDGET && !result.budget.ok ? 1 : 0;
    if (code) failure = `BUDGET: ${[...(mainBudget.ok ? [] : [`window main was late ${mainBudget.worstMs} ms during the build (${mainBudget.over} gaps over ${BUDGET_MS} ms)`]), ...(hostBudget.ok ? [] : [`genie-host was late ${hostBudget.worstMs} ms during the build (${hostBudget.over} gaps over ${HOST_BUDGET_MS} ms)`]), ...pageBudget.reasons, ...throughput.reasons, ...paging.reasons, ...pushes.reasons, ...hostSpawns.filter((h) => h.count > 0).map((h) => `${h.pass}: genie-host created ${h.count} processes on its own thread during the build (${JSON.stringify(h.by)})`)].join('; ')}`;
} catch (e) { failure = e.stack ?? String(e); console.error(failure); code = 1; }
finally {
    try { await hostCdp?.evaluate('globalThis.__uiLagHost?.stop(); true'); } catch {}
    try { await main?.evaluate('globalThis.__uiLag?.stop(); globalThis.__uiLagHostLaunch?.stop(); true'); } catch {}
    try { await main?.evaluate("process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').app.quit();true"); } catch {}
    for (const s of sessions) s.socket.close(); await sleep(1000); if (app?.exitCode === null) { try { app.kill('SIGTERM'); } catch {} }
    const record = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null;
    if (hostRecord && record?.pid === hostRecord.pid && record.startedAt === hostRecord.startedAt && Number.isFinite(record.startedAt) && record.startedAt >= started) { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
    mkdirSync(OUT, { recursive: true });
    for (const [label, profiles] of Object.entries(savedProfiles)) for (const [name, prof] of Object.entries(profiles)) writeFileSync(join(OUT, `ui-lag-${label}-${name}.cpuprofile`), JSON.stringify(prof));
    result.limits.push('the workspace is untrusted (git reads its own config first, as for any untrusted folder)', 'typing goes to a field of the probe, not a chat composer', 'GitHub runners, not the owner\'s machine: absolute numbers differ');
    const out = { code, failure, platform: process.platform, head: head(), budgetEnforced: BUDGET, ...result, passes: passes.map((p) => ({ label: p.label, profiled: p.profiled, build: p.build, alignment: p.alignment, rows: p.rows })) };
    writeFileSync(join(OUT, 'ui-lag-result.json'), JSON.stringify(out, null, 2));
    // What a person reads in the log: each phase's numbers, then what each of the worst gaps was.
    for (const p of out.passes) for (const r of p.rows ?? []) {
        console.log(`UI_LAG ${p.label}/${r.phase} ${r.ms}ms | main worst=${r.main.worstMs} over50=${r.main.over50} | page worst=${r.page.worstMs} longtasks=${r.page.longtasks.count}/${r.page.longtasks.totalMs}ms frames-worst=${Math.round(r.page.frameGaps[0]?.ms ?? 0)} | mouse rtt p95=${r.input.mouseRtt.p95} max=${r.input.mouseRtt.max} to-frame p95=${r.input.mouseToFrame.p95} | key rtt p95=${r.input.keyRtt.p95} to-frame p95=${r.input.keyToFrame.p95} | host worst=${r.host.worstMs} over50=${r.host.over50} spawns=${r.host.spawns.count} ${JSON.stringify(r.host.spawns.by)} | files pushes=${r.filesPushes.count} ${r.filesPushes.bytes}B max=${r.filesPushes.maxBytes}B | calls=${JSON.stringify(r.calls)}`);
        if (r.slices) console.log(`UI_LAG_SLICES ${p.label}/${r.phase} ${JSON.stringify(r.slices.map((x) => [x.cond, x.count, x.p95, x.worstGapMs, x.fps]))}`);
        for (const [cond, t] of Object.entries(r.traces ?? {})) console.log(`UI_LAG_TRACE ${cond} ${JSON.stringify(t)}`.slice(0, 4000));
        if (r.sliceProfiles) {
            console.log(`UI_LAG_SLICE_PROFILE on ${JSON.stringify(r.sliceProfiles.on)}`.slice(0, 3000));
            console.log(`UI_LAG_SLICE_PROFILE off ${JSON.stringify(r.sliceProfiles.off)}`.slice(0, 3000));
            for (const x of r.sliceProfiles.perSlice) console.log(`UI_LAG_SLICE_PROFILE slice ${JSON.stringify(x)}`.slice(0, 1200));
        }
        if (r.mainProfile) console.log(`UI_LAG_PROFILE main ${r.phase} ${JSON.stringify(r.mainProfile.ms)} own=${JSON.stringify(r.mainProfile.ownFrames)}`);
        for (const g of r.mainGapStacks ?? []) console.log(`UI_LAG_STACK main ${r.phase} gap=${g.gapMs}ms ${JSON.stringify(g)}`.slice(0, 4000));
        if (r.hostProfile) console.log(`UI_LAG_PROFILE host ${r.phase} ${JSON.stringify(r.hostProfile.ms)} own=${JSON.stringify(r.hostProfile.ownFrames)}`);
        for (const g of r.hostGapStacks ?? []) console.log(`UI_LAG_STACK host ${p.label}/${r.phase} gap=${g.gapMs}ms ${JSON.stringify(g)}`.slice(0, 4000));
        if (r.pageProfile) console.log(`UI_LAG_PROFILE page ${r.phase} ${JSON.stringify(r.pageProfile.ms)} own=${JSON.stringify(r.pageProfile.ownFrames)}`);
        for (const l of r.pageLongtaskStacks ?? []) console.log(`UI_LAG_STACK page ${r.phase} longtask=${l.longtaskMs}ms ${JSON.stringify(l)}`.slice(0, 4000));
    }
    try { const tail = logTail(join(root, '.genie', 'runtime', 'lifecycle.log')); writeFileSync(join(OUT, 'ui-lag-lifecycle-tail.log'), tail); console.log(`UI_LAG_LIFECYCLE_STALLS ${JSON.stringify(tail.split(/\r?\n/).filter((l) => /stall|slow|waiting|unresponsive/.test(l)).slice(-30))}`); } catch {}
    console.log(`UI_LAG_RESULT ${JSON.stringify({ code, failure, budget: out.budget, controls: out.controls })}`);
    process.exitCode = code;
}

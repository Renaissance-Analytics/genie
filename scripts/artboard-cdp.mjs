#!/usr/bin/env node
/** CI/test VM only. Copy this and artboard-measure-page.mjs to the pinned baseline; add --baseline there. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { measureArtboardPage } from './artboard-measure-page.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { installArtboardMainTrace, validateArtboardMainTrace } from './artboard-main-trace.mjs';

const WIN = process.platform === 'win32', BASELINE = process.argv.includes('--baseline'), OUT = resolve('smoke-out'), PORT = 9346, INSPECT = 9347, started = Date.now(), sessions = [], reports = [];
const TRACE = process.argv.includes('--trace-main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const demand = (ok, reason) => { if (!ok) throw new Error(reason); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const head = () => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; } };
const initialHead = head();
function logTail(path) {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 32768)); let at = 0;
        while (at < bytes.length) { const count = readSync(fd, bytes, at, bytes.length - at, size - bytes.length + at); if (!count) break; at += count; }
        return bytes.subarray(0, at).toString('utf8');
    } finally { closeSync(fd); }
}
const targets = async port => (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await read().catch(() => null); if (value) return value; await sleep(100); } throw new Error(label + ' was not ready'); }
class Cdp {
    next = 0; pending = new Map();
    static async connect(url) {
        const c = new Cdp(); c.socket = new WebSocket(url); let timer;
        c.socket.addEventListener('message', event => { const frame = JSON.parse(event.data); if (frame.method === 'Debugger.paused') c.paused = frame.params; if (frame.method === 'Debugger.resumed') c.paused = null; c.pending.get(frame.id)?.(frame); c.pending.delete(frame.id); });
        c.socket.addEventListener('close', () => { c.dead ??= 'CDP closed'; for (const done of c.pending.values()) done({ error: { message: c.dead } }); c.pending.clear(); });
        try { await Promise.race([new Promise((resolve, reject) => { c.socket.addEventListener('open', resolve, { once: true }); c.socket.addEventListener('error', reject, { once: true }); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP connect timed out')), 10000); })]); }
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
            const frame = await Promise.race([new Promise(resolve => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('CDP operation timed out: ' + method), { code: 'CDP_TIMEOUT' })), 120000); })]);
            if (frame.error) throw new Error(frame.error.message); return frame.result;
        } catch (error) {
            if (error.code === 'CDP_TIMEOUT') { this.dead = error.message; this.socket.close(); }
            throw error;
        } finally { clearTimeout(timer); this.pending.delete(id); }
    }
}
/** Load the existing native tool under a scoped test importer; no new app/preload/protocol post method. */
async function preparePostRunner(repo, workspace, agentId) {
    if (process.env.GENIE_PAGE_PROBE !== '1') throw new Error('native post probe requires the owned test app');
    const started = performance.now(), path = process.getBuiltinModule('node:path'), url = process.getBuiltinModule('node:url');
    const require = process.getBuiltinModule('node:module').createRequire(path.join(repo, 'package.json'));
    const scoped = require('tsx/esm/api').register({ namespace: 'artboard-measure-' + process.pid, tsconfig: path.join(repo, 'tsconfig.json') });
    try {
        const parent = url.pathToFileURL(path.join(repo, 'package.json')).href;
        const { runOfficialTool } = await scoped.import(url.pathToFileURL(path.join(repo, 'src/main/official-tools.ts')).href, parent);
        const { OFFICIAL_PLUGINS } = await scoped.import(url.pathToFileURL(path.join(repo, 'src/core/official-plugins.ts')).href, parent);
        const { parseManifest } = await scoped.import(url.pathToFileURL(path.join(repo, 'src/core/plugins.ts')).href, parent);
        const { stallStacksWanted } = await scoped.import(url.pathToFileURL(path.join(repo, 'src/main/stall-profile.ts')).href, parent);
        const traceModes = { profiler: typeof stallStacksWanted === 'function' ? stallStacksWanted(process.env) : true,
            profilerPolicy: typeof stallStacksWanted === 'function' ? 'stallStacksWanted' : 'legacy-always-on', privateAclLaunch: process.platform === 'win32' && process.type === 'browser' };
        globalThis.__artboardTrace?.setModes(traceModes);
        const parsed = parseManifest(OFFICIAL_PLUGINS.find(plugin => plugin.manifest.id === 'ai.genie.artboard').manifest);
        if (!parsed.ok) throw new Error(parsed.reason);
        const input = { pluginId: 'ai.genie.artboard', tool: 'post', args: { id: 'posted-image', title: 'Posted 2 MiB image', kind: 'image', imagePath: 'fixture.png', askVerdict: false },
            caller: { agentId, agentName: 'ArtBoard fixture', workspaceId: 'tynn', workspacePath: workspace }, manifest: parsed.manifest };
        globalThis.__artboardPost = { run: async () => { const at = performance.now(); const result = await runOfficialTool(input); return { result, elapsedMs: performance.now() - at }; }, stop: () => scoped.unregister() };
        return { elapsedMs: performance.now() - started, entry: 'runOfficialTool', location: 'owned Electron main', transport: 'direct native runner, not MCP/provider dispatch', traceModes };
    } catch (error) { await scoped.unregister(); throw error; }
}

/** Main's existing 16 ms gauge, with the exact span of its worst gap for trace correlation. */
function startMainMonitor() {
    const ipc = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').ipcMain, rss = process.memoryUsage().rss;
    const s = globalThis.__artboardMain = { ticks: 0, ticksBefore: 0, last: performance.now(), gap: 0, worstGap: null, rss, rssBefore: rss, methods: {}, maxCallBytes: 0, oversizedCalls: 0, handles: [], lastMethod: null };
    s.timer = setInterval(() => {
        const now = performance.now(), gap = now - s.last;
        if (gap > s.gap) { s.gap = gap; s.worstGap = { startedMs: s.last, endedMs: now, endedWallMs: Date.now(), lastMethod: s.lastMethod }; }
        s.last = now; s.ticks++; s.rss = Math.max(s.rss, process.memoryUsage().rss);
    }, 16);
    s.listener = (_event, action, handle, text) => {
        if (action !== 'frame') return; const message = JSON.parse(text);
        if (message.method) { s.lastMethod = message.method; s.methods[message.method] = (s.methods[message.method] ?? 0) + 1; }
        if (message.kind === 'call') { const bytes = Buffer.byteLength(text); s.maxCallBytes = Math.max(s.maxCallBytes, bytes); if (bytes > 524288) s.oversizedCalls++; if (!s.handles.includes(handle)) s.handles.push(handle); }
    };
    ipc.on('genie:local-frame', s.listener); s.stop = () => { clearInterval(s.timer); ipc.removeListener('genie:local-frame', s.listener); };
    return ['read', 'review'].map(operation => ipc._invokeHandlers.has('genie:artboard-' + operation));
}

let app, page, main, root, hostRecord, ownedElectronLog = false, failure = null, code = 1;
const startup = {};
try {
    demand(process.env.CI === 'true' || process.env.GENIE_ARTBOARD_MEASURE_ALLOW === '1' || (process.platform === 'linux' && process.env.USER === 'genie'), 'refused: run only in CI or an explicitly allowed test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT]) { let occupied = false; try { await targets(port); occupied = true; } catch (error) { if (error.name === 'TimeoutError') occupied = true; } demand(!occupied, 'debugger port ' + port + ' occupied; no app touched'); }
    root = mkdtempSync(join(tmpdir(), 'genie-artboard-')); const workspace = join(root, 'workspace'), runtime = join(root, '.genie', 'runtime'), board = join(workspace, '.artboard');
    mkdirSync(workspace); mkdirSync(board); mkdirSync(OUT, { recursive: true });
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1' };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15000, windowsHide: true });
    const agent = json(join(runtime, 'agents.json'))[0], image = Buffer.alloc(2 * 1024 * 1024), html = '<!doctype html><title>ArtBoard fixture</title><p>Synthetic preview</p>';
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=', 'base64').copy(image);
    writeFileSync(join(workspace, 'fixture.png'), image); writeFileSync(join(board, 'initial.png'), image); writeFileSync(join(board, 'small.html'), html);
    const posts = Array.from({ length: 100 }, (_, i) => ({ id: i === 0 ? 'initial-image' : 'p-' + i, title: 'Post ' + i + ': ' + '雪'.repeat(2000), kind: i === 0 ? 'image' : 'html', file: i === 0 ? 'initial.png' : 'small.html',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), agentId: agent.id, askVerdict: false }));
    writeFileSync(join(board, 'index.json'), JSON.stringify({ posts }));
    const nativeBoard = { posts: [...posts].reverse().map(post => ({ id: post.id, title: post.title, kind: post.kind, createdAt: post.createdAt, askVerdict: false,
        ...(post.kind === 'image' ? { src: 'data:image/png;base64,' + image.toString('base64') } : { html }) })) };
    const imageHash = sha(image), boardBytes = Buffer.from(JSON.stringify(nativeBoard));
    const fd = openSync(join(OUT, 'artboard-electron.log'), 'w'); ownedElectronLog = true;
    const electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron'), args = ['.', '--remote-debugging-port=' + PORT, (TRACE ? '--inspect-brk=' : '--inspect=') + INSPECT, '--user-data-dir=' + join(root, 'profile')];
    if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push('--ozone-platform=' + process.env.XDG_SESSION_TYPE);
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, launchStarted = Date.now();
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', fd, fd] }); closeSync(fd); app.on('error', error => console.error(error.message));
    if (TRACE) {
        main = await Cdp.connect((await until('owned paused main inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl);
        const phase = name => console.log('ARTBOARD_TRACE_PHASE ' + JSON.stringify({ phase: name, elapsedMs: Date.now() - launchStarted }));
        phase('inspector-connected'); await main.request('Debugger.enable', {});
        await main.request('Runtime.runIfWaitingForDebugger', {}); phase('waiting-entry-pause');
        const paused = await until('owned entry pause', async () => main.paused);
        const installed = await main.request('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId, expression: 'globalThis.__artboardTrace=(' + installArtboardMainTrace.toString() + ')(' + JSON.stringify(root) + ');true', returnByValue: true });
        if (installed.exceptionDetails) throw new Error(installed.exceptionDetails.exception?.description ?? 'trace installation failed');
        phase('trace-installed'); await main.request('Debugger.resume', {}); await main.request('Debugger.disable', {});
        startup.traceResumeMs = Date.now() - launchStarted; phase('entry-resumed');
    }
    const target = await until('owned app page', async () => { hostRecord ??= json(join(runtime, 'host.json')); return (await targets(PORT)).find(target => target.type === 'page' && /index\.html/.test(target.url)); }, 240000);
    startup.pageTargetMs = Date.now() - launchStarted; page = await Cdp.connect(target.webSocketDebuggerUrl);
    main ??= await Cdp.connect((await until('owned main inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl); startup.inspectorsConnectedMs = Date.now() - launchStarted;
    await waitForPageProbe(page); startup.pageBridgeMs = Date.now() - launchStarted;
    await until('ready page connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"')); startup.protocolReadyMs = Date.now() - launchStarted;
    startup.navigation = await page.evaluate('(()=>{const n=performance.getEntriesByType("navigation")[0];return n?{domInteractive:n.domInteractive,domContentLoaded:n.domContentLoadedEventEnd,load:n.loadEventEnd}:null})()');
    reports.push({ label: 'startup', elapsedMs: startup.protocolReadyMs, phases: startup }); console.log('ARTBOARD_STARTUP ' + JSON.stringify(reports.at(-1)));
    hostRecord ??= json(join(runtime, 'host.json'));
    const setup = await main.evaluate('(' + preparePostRunner.toString() + ')(' + JSON.stringify(resolve('.')) + ',' + JSON.stringify(workspace) + ',' + JSON.stringify(agent.id) + ')');
    reports.push({ label: 'post-probe-setup', ...setup }); console.log('ARTBOARD_SETUP ' + JSON.stringify(reports.at(-1)));
    const handlers = await main.evaluate('(' + startMainMonitor.toString() + ')()');
    demand(handlers.every(present => present === BASELINE), 'native ArtBoard handler presence control'); reports.push({ label: 'path-control', baseline: BASELINE, handlers });
    await page.evaluate('(()=>{window.__artboardWire={maxBytes:0,forbidden:0,pages:0,items:0,invalidPages:0,oversizedEvents:0};window.genieLocalProtocol.onFrame((action,_handle,text)=>{if(action!=="frame")return;const m=JSON.parse(text),s=window.__artboardWire,n=new TextEncoder().encode(text).length;s.maxBytes=Math.max(s.maxBytes,n);if(m.kind==="result"&&Array.isArray(m.value?.items)&&m.value.items.some(item=>item.artifact)){s.pages++;s.items+=m.value.items.length;if(m.value.items.length>128||new TextEncoder().encode(JSON.stringify(m.value)).length>524288)s.invalidPages++;}if(m.kind==="event"){if(n>524288)s.oversizedEvents++;if(m.channel==="snapshot"||m.channel==="activity"||m.channel==="local-activity"||m.channel?.startsWith("agent:")||m.channel?.startsWith("terminal-"))s.forbidden++;}});return true;})()');
    const run = input => page.evaluate('(' + measureArtboardPage.toString() + ')(' + JSON.stringify({ workspaceId: 'tynn', ...input }) + ')');
    async function measure(label, input, beforeRead = async () => ({})) {
        await page.evaluate('Object.assign(window.__artboardWire,{maxBytes:0,forbidden:0,pages:0,items:0,invalidPages:0,oversizedEvents:0});true');
        await main.evaluate('(()=>{const s=globalThis.__artboardMain;s.methods={};s.gap=0;s.worstGap=null;s.lastMethod=null;s.startedMs=s.last=performance.now();s.startedWallMs=Date.now();s.rssBefore=s.rss=process.memoryUsage().rss;s.ticksBefore=s.ticks;s.maxCallBytes=0;s.oversizedCalls=0;s.handles=[];globalThis.__artboardPhases={events:[],dropped:0};return true;})()');
        await page.evaluate('(()=>{const s=window.__artboardRow={ticks:0,last:performance.now(),maxGapMs:0};s.timer=setInterval(()=>{const now=performance.now();s.maxGapMs=Math.max(s.maxGapMs,now-s.last);s.last=now;s.ticks++;},16);return true;})()');
        const stateBefore = await page.evaluate('window.genieTest.localProtocol.state()'), extra = await beforeRead(), value = await run(input), wire = await page.evaluate('window.__artboardWire');
        const native = await main.evaluate('((s)=>({startedMs:s.startedMs,startedWallMs:s.startedWallMs,endedMs:performance.now(),endedWallMs:Date.now(),ticks:s.ticks,ticksBefore:s.ticksBefore,maxGapMs:s.gap,worstGap:s.worstGap,rssBefore:s.rssBefore,rssPeak:Math.max(s.rss,process.memoryUsage().rss),methods:s.methods,maxCallBytes:s.maxCallBytes,oversizedCalls:s.oversizedCalls,connections:s.handles.length,artboardPhases:globalThis.__artboardPhases}))(globalThis.__artboardMain)');
        const stateAfter = await page.evaluate('window.genieTest.localProtocol.state()');
        const rowClock = await page.evaluate('(()=>{const s=window.__artboardRow;clearInterval(s.timer);return {ticks:s.ticks,maxGapMs:Math.max(s.maxGapMs,performance.now()-s.last)};})()');
        const row = { label, ...value, wire, native, rowClock, ...extra }; reports.push(row); console.log('ARTBOARD ' + JSON.stringify(row));
        demand(value.heartbeat.before > 0 && value.heartbeat.after > 0 && value.concurrentSettings.ok && native.ticks > native.ticksBefore, 'ArtBoard live clock and concurrent settings controls');
        demand(stateBefore.phase === 'ready' && stateAfter.phase === 'ready' && stateBefore.revision === stateAfter.revision, 'the app keeps its same ready page connection');
        demand(wire.maxBytes <= 1048576 && wire.forbidden === 0 && wire.invalidPages === 0 && wire.oversizedEvents === 0 && native.oversizedCalls === 0, 'ArtBoard frame/content/metadata limits');
        if (!BASELINE) {
            demand(native.artboardPhases?.dropped === 0 && ['metadata-build', 'artifact-open', 'projection'].every(phase => native.artboardPhases.events.some(event => event.phase === phase)) && !native.artboardPhases.events.some(event => event.phase === 'native-build' || event.phase === 'resolve-board'), 'ArtBoard metadata/file-source timing positive controls');
            demand(native.methods['artboard.read'] === 1 && native.methods['blob.open'] > 0 && wire.pages >= 2 && wire.items === 100 && native.connections === 1, 'ArtBoard metadata pages and blobs use the app connection');
            demand(native.maxGapMs < 250 && value.heartbeat.maxGapMs < 250 && rowClock.maxGapMs < 250 && native.rssPeak - native.rssBefore < 100 * 1024 * 1024, 'ArtBoard transfer blocked a clock or retained excessive main memory');
        }
        return row;
    }
    await measure('open-image-2MiB', { postId: 'initial-image', expect: { bytes: image.length, sha256: imageHash, count: 100 } });
    await measure('list-100-posts', { expect: { bytes: boardBytes.length, sha256: sha(boardBytes), count: 100 } });
    await measure('post-image-2MiB', { postId: 'posted-image', expect: { bytes: image.length, sha256: imageHash, count: 100 } }, async () => {
        const posting = await main.evaluate('globalThis.__artboardPost.run()');
        demand(posting.result?.ok === true && posting.result.result?.id === 'posted-image', 'the native agent image-post runner succeeds');
        demand(sha(readFileSync(join(board, 'posted-image.png'))) === imageHash, 'the native image post copied every byte');
        const stored = json(join(board, 'index.json')); demand(stored.posts.length === 100 && stored.posts[0].id === 'posted-image' && stored.posts[0].agentId === agent.id && stored.posts[0].askVerdict === false, 'native post cap, identity and opt-in verdict semantics');
        return { posting };
    });
    let broke = false; try { await run({ postId: 'posted-image', expect: { sha256: '0'.repeat(64) } }); } catch (error) { demand(/hash differs/i.test(error.message), 'negative ArtBoard hash failed for another reason'); broke = true; }
    demand(broke, 'deliberate ArtBoard hash mismatch must fail'); reports.push({ label: 'negative-hash-control', passed: true }); code = 0;
} catch (error) { failure = error.stack ?? String(error); console.error(failure); }
finally {
    if (TRACE) {
        try {
            const trace = await main?.evaluate('globalThis.__artboardTrace?.snapshot()');
            if (trace) { reports.push({ label: 'main-trace', ...trace }); console.log('ARTBOARD_TRACE ' + JSON.stringify(trace)); }
            validateArtboardMainTrace(trace);
        } catch (error) { code = 1; failure ??= error.stack ?? String(error); }
        try { await main?.evaluate('globalThis.__artboardTrace?.stop();true'); } catch {}
    }
    try { await page?.evaluate('clearInterval(window.__artboardRow?.timer);true'); } catch {}
    try { await main?.evaluate('(async()=>{await globalThis.__artboardPost?.stop();delete globalThis.__artboardPost;globalThis.__artboardMain?.stop();return true;})()'); } catch {}
    try { await main?.evaluate('process.getBuiltinModule("node:module").createRequire(process.execPath)("electron").app.quit();true'); } catch {}
    for (const session of sessions) session.socket.close(); await sleep(1000); if (app?.exitCode === null) { try { app.kill('SIGTERM'); } catch {} }
    const record = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null;
    if (hostRecord && record?.pid === hostRecord.pid && record.startedAt === hostRecord.startedAt && Number.isFinite(record.startedAt) && record.startedAt >= started) { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
    const finalHead = head(); if (initialHead && finalHead && initialHead !== finalHead) { code = 1; failure = 'checkout HEAD changed during the measurement'; }
    const scriptHashes = {}; for (const path of ['scripts/artboard-cdp.mjs', 'scripts/artboard-measure-page.mjs', 'scripts/artboard-main-trace.mjs', 'src/main/official-tools.ts', 'src/main/stall-profile.ts']) { try { scriptHashes[path] = sha(readFileSync(path)); } catch { scriptHashes[path] = null; } }
    const result = { code, baseline: BASELINE, traceMain: TRACE, platform: process.platform, head: finalHead, initialHead, scriptHashes, root, failure, reports, startup,
        limits: ['P4 server stays in main', 'startup and one-time scoped native-runner import reported separately', 'direct existing native plugin runner in owned Electron main; MCP/provider dispatch unmeasured', 'oracle hash verification outside transfer latency', '16ms sampled main RSS; transient peak and genie-host peak unmeasured', 'physical VM and installed-ASAR gates remain coordinator-owned'] };
    mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'artboard-result.json'), JSON.stringify(result, null, 2));
    for (const [name, path] of [['lifecycle', root ? join(root, '.genie', 'runtime', 'lifecycle.log') : null], ['electron', ownedElectronLog ? join(OUT, 'artboard-electron.log') : null]]) {
        try { const tail = logTail(path); writeFileSync(join(OUT, 'artboard-' + name + '-tail.log'), tail); console.log('ARTBOARD_LOG_TAIL ' + name + ' ' + JSON.stringify(tail)); } catch { console.log('ARTBOARD_LOG_TAIL ' + name + ' unavailable'); }
    }
    console.log('ARTBOARD_RESULT ' + JSON.stringify(result)); process.exitCode = code;
}

#!/usr/bin/env node
/**
 * VM-only Files consumer measurement. Built checkout, both baseline b156ebcf and reviewed7C:
 *   GENIE_FILES_MEASURE_ALLOW=1 node scripts/files-content-cdp.mjs
 * Calls the actual pageBridge through genieTest only. No second door or source probe.
 * The coordinator runs it once per OS/head and compares smoke-out/files-content-result.json.
 * Draft attachment/ArtBoard/paste consumers and per-view watches are explicitly later gates.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SourceMap } from 'node:module';
import { measureFilesPage } from './files-content-measure-page.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { builtFramePath } from './built-frame-path.mjs';

const WIN = process.platform === 'win32', started = Date.now(), OUT = resolve('smoke-out');
const PORT = 9344, INSPECT = 9345, reports = [], sessions = [];
const STAGE_PROFILE = process.argv.includes('--stage-profile');
const PROFILE = process.argv.includes('--profile') || STAGE_PROFILE, profiles = [], sourceMaps = new Map();
let profileTools, profiled = false, sample = 0;
let root, app, page, main, hostRecord;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const demand = (value, why) => { if (!value) throw new Error(why); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const targets = async port => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30000) {
    const end = Date.now() + ms; let error;
    while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch (e) { error = e.message; } await sleep(100); }
    throw new Error(`${label} was not ready: ${error ?? 'no result'}`);
}
class Cdp {
    next = 0; pending = new Map();
    static async connect(url) {
        const c = new Cdp(); c.socket = new WebSocket(url);
        c.socket.addEventListener('message', event => { const f = JSON.parse(event.data); const done = c.pending.get(f.id); if (typeof done === 'function') { c.pending.delete(f.id); done(f); } });
        c.socket.addEventListener('close', () => { for (const done of c.pending.values()) done({ error: { message: 'CDP closed' } }); c.pending.clear(); });
        let timer;
        try { await Promise.race([new Promise((resolve, reject) => { c.socket.addEventListener('open', resolve, { once: true }); c.socket.addEventListener('error', reject, { once: true }); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP connect timed out')), 10000); })]); }
        finally { clearTimeout(timer); }
        sessions.push(c); return c;
    }
    async command(method, params = {}, ms = 30000) {
        const id = ++this.next; let timer;
        try {
            const f = await Promise.race([new Promise(resolve => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP operation timed out')), ms); })]);
            if (f.error) throw new Error(f.error.message); return f.result;
        } finally { clearTimeout(timer); this.pending.delete(id); }
    }
    async evaluate(expression, ms = 30000) {
        const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
        return result.result.value;
    }
}
function cpuSummary(profile) {
    // Map only this checkout's own built files. No paths from a profile can escape dist.
    for (const node of profile.nodes) {
        const frame = node.callFrame; const path = builtFramePath(frame.url); if (!path || !existsSync(path + '.map')) continue;
        let map = sourceMaps.get(path); if (!map) { map = new SourceMap(json(path + '.map')); sourceMaps.set(path, map); }
        const entry = map.findEntry(frame.lineNumber, frame.columnNumber);
        if (entry.originalSource) { frame.url = entry.originalSource; frame.lineNumber = entry.originalLine; }
    }
    return profileTools.summarizeCpuProfile(profile);
}
async function measure(label, input) {
    await page.evaluate('window.__filesMeasure.reset()'); await main.evaluate('globalThis.__filesMeasure.reset()');
    if (STAGE_PROFILE) for (const connection of [main, page]) await connection.evaluate('globalThis.__filesStageCounters.reset();true');
    if (profiled) {
        await main.evaluate('globalThis.__filesCounters.reset();globalThis.__filesCounters.resume();true');
        await page.evaluate('window.__filesCounters.reset();window.__filesCounters.pause();true');
        await Promise.all([main.command('Profiler.start'), page.command('Profiler.start')]);
    }
    const value = await page.evaluate(`(${measureFilesPage.toString()})(${JSON.stringify({ ...input, returnContent: false, profile: profiled })})`, 60000);
    let profile;
    if (profiled) {
        await main.evaluate('globalThis.__filesCounters.pause();true');
        const [hostCpu, pageCpu] = await Promise.all([main.command('Profiler.stop'), page.command('Profiler.stop')]);
        const hostCounters = await main.evaluate('({counters:globalThis.__filesCounters.summary(),calls:globalThis.__filesCounters.calls()})');
        const pageCounters = await page.evaluate('({counters:window.__filesCounters.summary(),calls:window.__filesCounters.calls()})');
        profile = { main: { ...hostCounters, cpu: cpuSummary(hostCpu.profile) }, renderer: { ...pageCounters, cpu: cpuSummary(pageCpu.profile) } };
        profiles.push({ label, sample, ...profile });
        for (const side of ['main', 'renderer']) console.log(`FILES_PROFILE ${JSON.stringify({ label, sample, side, counters: profile[side].counters, calls: profile[side].calls, cpu: profile[side].cpu.frames.slice(0, 20) })}`);
    }
    const renderer = await page.evaluate('window.__filesMeasure.summary()'), native = await main.evaluate('globalThis.__filesMeasure.summary()');
    let staging;
    if (STAGE_PROFILE) {
        staging = {};
        for (const [side, connection] of [['main', main], ['renderer', page]]) {
            staging[side] = await connection.evaluate('globalThis.__filesStageCounters.summary()');
            demand(staging[side].ticks > 0, `${side} staging heartbeat positive control`);
            console.log(`FILES_STAGING ${JSON.stringify({ label, sample, side, ...staging[side] })}`);
        }
        if (input.method === 'write') demand(staging.main.events.some(event => event.operation === 'file.write'), 'staged-write native filesystem instrumentation positive control');
    }
    demand(value.heartbeat.before > 0 && value.heartbeat.after > 0, 'heartbeat before/after positive controls');
    demand(value.concurrentSettings.ok, 'same page connection settings control');
    demand(renderer.maxBytes <= 1048576 && native.maxBytes <= 1048576, 'actual local frames exceed1MiB');
    const row = { label, ...value, ...(PROFILE ? { sample, profiled } : {}), ...(staging ? { staging } : {}), localFrames: { toPage: renderer, toHost: native }, mainRssPeak: native.rssPeak };
    reports.push(row); console.log(`FILES ${label} ${JSON.stringify(row)}`); return row;
}
const textAt = suffix => `${'雪'.repeat(Math.floor(2 * 1024 * 1024 / 3))}${suffix}\n`;

let code = 1, failure = null;
try {
    demand(process.env.CI === 'true' || process.env.GENIE_FILES_MEASURE_ALLOW === '1' || (process.platform === 'linux' && process.env.USER === 'genie'), 'refused: Electron launches only in CI or an explicitly allowed test VM');
    if (PROFILE) profileTools = await import('./files-content-profile.mjs');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT]) {
        let occupied = false; try { await targets(port); occupied = true; } catch (e) { if (e.name === 'TimeoutError') occupied = true; }
        demand(!occupied, `debugger port${port} occupied; no existing app touched`);
    }
    root = mkdtempSync(join(tmpdir(), 'genie-files-content-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace); mkdirSync(OUT, { recursive: true });
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1' };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15000 });
    writeFileSync(join(root, '.genie', 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'tynn', path: workspace }]));
    const original = textAt('a'), changed = textAt('b'); writeFileSync(join(workspace, 'text.txt'), original);
    const image = Buffer.alloc(2 * 1024 * 1024); Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=', 'base64').copy(image); writeFileSync(join(workspace, 'image.png'), image);
    const git = args => execFileSync('git', ['-c', 'user.name=Files fixture', '-c', 'user.email=files@example.test', ...args], { cwd: workspace, encoding: 'utf8', stdio: 'pipe', timeout: 15000, windowsHide: true });
    git(['init']); git(['add', 'text.txt']); git(['commit', '-m', 'measurement baseline']); writeFileSync(join(workspace, 'text.txt'), changed);
    for (let i = 0; i < 6000; i++) writeFileSync(join(workspace, `entry-${String(i).padStart(5, '0')}-${'x'.repeat(150)}.txt`), '');
    const fd = openSync(join(OUT, 'files-content-electron.log'), 'w'), electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`];
    if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', fd, fd] }); closeSync(fd);
    app.on('error', error => console.error(`owned app launch failed: ${error.message}`));
    const target = await until('owned app page', async () => (await targets(PORT)).find(t => t.type === 'page' && /index\.html/.test(t.url)), 60000);
    page = await Cdp.connect(target.webSocketDebuggerUrl); main = await Cdp.connect((await until('owned app inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl);
    await waitForPageProbe(page); await until('ready app connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"'));
    hostRecord = json(join(root, '.genie', 'runtime', 'host.json'));
    if (STAGE_PROFILE) for (const connection of [main, page]) await connection.evaluate(`globalThis.__filesStageCounters=(${profileTools.installFilesStageCounters.toString()})(globalThis);true`);
    await page.evaluate(`(() => {
        const s = window.__filesMeasure = { count:0,maxBytes:0,handles:new Set(),kinds:{} };
        s.reset = () => { s.count=0;s.maxBytes=0;s.handles.clear();s.kinds={}; };
        s.summary = () => ({count:s.count,maxBytes:s.maxBytes,handles:[...s.handles],kinds:s.kinds,heapBytes:performance.memory?.usedJSHeapSize??null});
        window.genieLocalProtocol.onFrame((action,handle,text) => { if(action!=='frame')return;s.count++;s.handles.add(handle);s.maxBytes=Math.max(s.maxBytes,new TextEncoder().encode(text).length);const m=JSON.parse(text);s.kinds[m.kind]=(s.kinds[m.kind]??0)+1; }); return true;
    })()`);
    const handlerState = await main.evaluate(`(() => {
        const electron=process.getBuiltinModule('node:module').createRequire(process.execPath)('electron'),ipc=electron.ipcMain;
        const s=globalThis.__filesMeasure={count:0,maxBytes:0,rssPeak:process.memoryUsage().rss,methods:{}};
        s.reset=()=>{s.count=0;s.maxBytes=0;s.rssPeak=process.memoryUsage().rss;s.methods={};};
        s.summary=()=>({count:s.count,maxBytes:s.maxBytes,rssPeak:s.rssPeak,methods:s.methods});
        s.listen=(_event,action,_handle,text)=>{if(action!=='frame')return;s.count++;s.maxBytes=Math.max(s.maxBytes,Buffer.byteLength(text));const m=JSON.parse(text);if(m.method)s.methods[m.method]=(s.methods[m.method]??0)+1;};
        ipc.on('genie:local-frame',s.listen);s.timer=setInterval(()=>{s.rssPeak=Math.max(s.rssPeak,process.memoryUsage().rss);},100);
        s.stop=()=>{clearInterval(s.timer);ipc.removeListener('genie:local-frame',s.listen);};
        return {nativeFilesOpen:ipc._invokeHandlers.has('genie:files-open'),nativeWatch:ipc._invokeHandlers.has('genie:files-watch'),snapshotControl:ipc._invokeHandlers.has('genie:snapshot')};
    })()`);
    demand(handlerState.snapshotControl && handlerState.nativeWatch === process.argv.includes('--baseline'), 'snapshot retained; watch moved after7D (baseline flag for earlier native path)');
    reports.push({ label: 'path-control', ...handlerState, fixtureRoot: root, actualFixtureFiles: readdirSync(workspace).filter(n => n.startsWith('entry-')).length });
    // Same hash gauge must reject a corrupted expected result before normal rows may count.
    let rejected = false; try { await measure('intentional-hash-break', { method: 'open', args: ['tynn', 'text.txt'], expect: { sha256: '0'.repeat(64) } }); } catch (e) { rejected = /hash differs/.test(e.message); }
    demand(rejected, 'negative hash control must fail for the intended reason'); reports.push({ label: 'hash-break-control', passed: true });
    if (PROFILE) console.log(`FILES_APIS ${JSON.stringify(await page.evaluate('({toBase64:typeof Uint8Array.prototype.toBase64,fromBase64:typeof Uint8Array.fromBase64})'))}`);
    for (sample = 0; sample < (PROFILE ? 6 : 1); sample++) {
    profiled = PROFILE && sample >= 3;
    if (profiled && sample === 3) {
        for (const connection of [main, page]) {
            await connection.command('Profiler.enable'); await connection.command('Profiler.setSamplingInterval', { interval: 1000 });
            await connection.evaluate(`globalThis.__filesCounters=(${profileTools.installFilesCounters.toString()})(globalThis);globalThis.__filesCounters.pause();true`);
        }
    }
    writeFileSync(join(workspace, 'text.txt'), changed);
    await measure('text2MiB', { method: 'open', args: ['tynn', 'text.txt'], expect: { sha256: sha(changed) } });
    await measure('media2MiB', { method: 'readMedia', args: ['tynn', 'image.png'], expect: { sha256: sha(image) } });
    await measure('committed2MiB', { method: 'lastCommitted', args: ['tynn', 'text.txt'], expect: { sha256: sha(original) } });
    await measure('root-children6000', { method: 'children', args: ['tynn', ''], expect: { fixtureCount: 6000 } });
    await measure('tree-root6000', { method: 'tree', args: ['tynn'], expect: { fixtureCount: 6000 } });
    const diff = await measure('repo-diff', { method: 'repo', args: ['diff', 'tynn', '', 'text.txt', false] }); demand(diff.ok && diff.bytes > 2 * 1024 * 1024, 'complete native repo diff is measured');
    const conflict = await measure('text-conflict2MiB', { method: 'write', args: ['tynn', 'text.txt', original, 'stale-sha'], expect: { sha256: sha(changed) } }); demand(!conflict.ok, 'stale SHA remains a conflict');
    const saved = await measure('text-write2MiB', { method: 'write', args: ['tynn', 'text.txt', original, sha(changed)] }); demand(saved.ok && saved.nativeSha === sha(original), 'write SHA is exact');
    demand(sha(readFileSync(join(workspace, 'text.txt'))) === sha(original), 'actual disk bytes match write');
    }
    reports.push({ label: 'later-gates', unmeasured: ['100MiB draft consumer', 'ArtBoard image consumer', 'draft paste responsiveness', 'per-view watch changes', 'host-process peak RSS'], reason: '7E/7F and7D consumers are outside7C; P4 server is Electron main' });
    code = 0;
} catch (e) { failure = e.stack ?? String(e); console.error(failure); }
finally {
    try { await page?.evaluate('window.__filesStageCounters?.stop();true', 3000); } catch {}
    try { await main?.evaluate('globalThis.__filesStageCounters?.stop();true', 3000); } catch {}
    try { await page?.evaluate('window.__filesCounters?.stop();true', 3000); } catch {}
    try { await main?.evaluate('globalThis.__filesCounters?.stop();true', 3000); } catch {}
    try { await main?.evaluate('globalThis.__filesMeasure?.stop();true', 3000); } catch {}
    try { await main?.evaluate("process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').app.quit();true", 3000); } catch {}
    for (const session of sessions) session.socket.close();
    await sleep(1000); if (app?.exitCode === null) { try { app.kill('SIGTERM'); } catch {} }
    // The isolated root did not exist before this run. Only its newly created host record is eligible, never enumeration.
    const ownedRecord = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null;
    if (hostRecord && ownedRecord?.pid === hostRecord.pid && ownedRecord.startedAt === hostRecord.startedAt && Number.isFinite(ownedRecord.startedAt) && ownedRecord.startedAt >= started) { try { process.kill(ownedRecord.pid, 'SIGTERM'); } catch {} }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'files-content-result.json'), JSON.stringify({ code, platform: process.platform, head: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding:'utf8' }).trim(); } catch { return null; } })(), root, failure, reports }, null, 2));
    if (PROFILE) writeFileSync(join(OUT, 'files-content-profiles.json'), JSON.stringify({ note: 'Counters exclude renderer gauge hashing; CPU samples also include the harness before/after heartbeat and gauge. Inclusive call times overlap; do not sum them as CPU.', profiles }, null, 2));
    // Preserve this run's isolated files and logs for review; no recursive deletion is needed.
    process.exitCode = code;
}

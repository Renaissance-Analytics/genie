#!/usr/bin/env node
/** VM/CI only. Candidate: no flag. Copy to the7C baseline with --baseline. Existing pageBridge only. */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { measureFilesWatchPage } from './files-watch-measure-page.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';

const WIN = process.platform === 'win32', BASELINE = process.argv.includes('--baseline'), OUT = resolve('smoke-out'), PORT = 9344, INSPECT = 9345, started = Date.now(), sessions = [], reports = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const demand = (ok, reason) => { if (!ok) throw new Error(reason); };
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const targets = async port => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await read().catch(() => null); if (value) return value; await sleep(100); } throw new Error(`${label} was not ready`); }
class Cdp {
    next = 0; pending = new Map();
    static async connect(url) {
        const c = new Cdp(); c.socket = new WebSocket(url);
        c.socket.addEventListener('message', event => { const frame = JSON.parse(event.data); c.pending.get(frame.id)?.(frame); c.pending.delete(frame.id); });
        c.socket.addEventListener('close', () => { for (const done of c.pending.values()) done({ error: { message: 'CDP closed' } }); c.pending.clear(); });
        let timer;
        try { await Promise.race([new Promise((resolve, reject) => { c.socket.addEventListener('open', resolve, { once: true }); c.socket.addEventListener('error', reject, { once: true }); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP connect timed out')), 10000); })]); }
        finally { clearTimeout(timer); }
        sessions.push(c); return c;
    }
    async evaluate(expression) {
        const id = ++this.next; let timer;
        try {
            const frame = await Promise.race([new Promise(resolve => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP operation timed out')), 30000); })]);
            if (frame.error || frame.result?.exceptionDetails) throw new Error(frame.error?.message ?? frame.result.exceptionDetails.exception?.description ?? 'page exception');
            return frame.result.result.value;
        } finally { clearTimeout(timer); this.pending.delete(id); }
    }
}
let app, page, main, root, hostRecord, failure = null, code = 1;
try {
    demand(process.env.CI === 'true' || process.env.GENIE_FILES_MEASURE_ALLOW === '1' || (process.platform === 'linux' && process.env.USER === 'genie'), 'refused: run only in CI or an explicitly allowed test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT]) { let occupied = false; try { await targets(port); occupied = true; } catch (e) { if (e.name === 'TimeoutError') occupied = true; } demand(!occupied, `debugger port ${port} occupied; no app touched`); }
    root = mkdtempSync(join(tmpdir(), 'genie-files-watch-')); const workspace = join(root, 'workspace'); mkdirSync(workspace); mkdirSync(OUT, { recursive: true });
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1' };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15000, windowsHide: true });
    writeFileSync(join(root, '.genie', 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'tynn', path: workspace }])); writeFileSync(join(root, '.genie', 'runtime', 'agents.json'), '[]');
    const git = args => execFileSync('git', ['-c', 'user.name=Watch fixture', '-c', 'user.email=watch@example.test', ...args], { cwd: workspace, encoding: 'utf8', stdio: 'pipe', timeout: 15000, windowsHide: true });
    writeFileSync(join(workspace, 'watched.txt'), 'baseline'); git(['init']); git(['add', '.']); git(['commit', '-m', 'watch baseline']);
    for (let i = 0; i < 6000; i++) writeFileSync(join(workspace, `entry-${String(i).padStart(5, '0')}-${'x'.repeat(150)}.txt`), '');
    const fd = openSync(join(OUT, 'files-watch-electron.log'), 'w'), electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`]; if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', fd, fd] }); closeSync(fd); app.on('error', e => console.error(e.message));
    const target = await until('owned app page', async () => (await targets(PORT)).find(t => t.type === 'page' && /index\.html/.test(t.url)), 60000);
    page = await Cdp.connect(target.webSocketDebuggerUrl); main = await Cdp.connect((await until('owned main inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl);
    await waitForPageProbe(page); await until('same ready page connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"'));
    hostRecord = json(join(root, '.genie', 'runtime', 'host.json'));
    const handlers = await main.evaluate(`(() => { const ipc=process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').ipcMain;
        const s=globalThis.__watchMain={ticks:0,gap:0,last:performance.now(),rss:process.memoryUsage().rss,methods:{}};
        s.timer=setInterval(()=>{const now=performance.now();s.gap=Math.max(s.gap,now-s.last);s.last=now;s.ticks++;s.rss=Math.max(s.rss,process.memoryUsage().rss);},16);
        s.listener=(_event,action,_handle,text)=>{if(action==='frame'){const m=JSON.parse(text);if(m.method)s.methods[m.method]=(s.methods[m.method]??0)+1;}};
        ipc.on('genie:local-frame',s.listener);s.stop=()=>{clearInterval(s.timer);ipc.removeListener('genie:local-frame',s.listener);};
        return {watch:ipc._invokeHandlers.has('genie:files-watch'),unwatch:ipc._invokeHandlers.has('genie:files-unwatch'),snapshot:ipc._invokeHandlers.has('genie:snapshot')}; })()`);
    demand(handlers.watch === BASELINE && handlers.unwatch === BASELINE && handlers.snapshot, 'native-handler presence control'); reports.push({ label: 'path-control', baseline: BASELINE, handlers });
    await page.evaluate(`(() => { const s=window.__watchWire={files:0,refetch:0,maxBytes:0,forbidden:0};
        window.genieLocalProtocol.onFrame((action,_handle,text)=>{if(action!=='frame')return;const m=JSON.parse(text);s.maxBytes=Math.max(s.maxBytes,new TextEncoder().encode(text).length);
        if(m.kind==='event'&&m.channel==='local-files'){s.files++;if(m.payload?.changed==='refetch')s.refetch++;}
        if(m.kind==='event'&&(m.channel==='snapshot'||m.channel==='activity'||m.channel==='local-activity'||m.channel?.startsWith('agent:')||m.channel?.startsWith('terminal-')))s.forbidden++;});return true; })()`);
    const run = input => page.evaluate(`(${measureFilesWatchPage.toString()})(${JSON.stringify(input)})`);
    for (const views of [0, 1, 2]) {
        await run({ action: 'start', workspaceId: 'tynn', views, git: true }); await sleep(500);
        await page.evaluate('Object.assign(window.__watchWire,{files:0,refetch:0,maxBytes:0,forbidden:0});window.__filesWatchRun.started=performance.now();true');
        await main.evaluate('globalThis.__watchMain.methods={};globalThis.__watchMain.gap=0;true');
        writeFileSync(join(workspace, 'watched.txt'), `phase-${views}`);
        if (!views) { await sleep(700); const value = await run({ action: 'summary' }), wire = await page.evaluate('window.__watchWire'); demand(value.calls.length === 0 && wire.files === 0, 'zero explicit views'); reports.push({ label: 'zero-views', ...value, wire }); continue; }
        // Independent native git after the edit: its full ordered result is the correctness oracle, not a UI count alone.
        const entries = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']).split('\0').filter(Boolean);
        const expected = Object.fromEntries(entries.map(entry => [entry.slice(3), entry[0] === '?' ? 'untracked' : entry[0] === 'A' ? 'added' : entry[0] === 'D' || entry[1] === 'D' ? 'deleted' : 'modified']));
        const expectedHash = createHash('sha256').update(JSON.stringify(expected)).digest('hex'); demand(Object.keys(expected).length >= 6001 && Buffer.byteLength(JSON.stringify(expected)) > 512 * 1024, 'actual oversized git fixture');
        const value = await until('complete watched git snapshot', async () => { const value = await run({ action: 'summary' }); return value.treeSha256 === expectedHash && value.paths.includes('watched.txt') && value.calls.every(n => n >= 2) ? value : null; });
        demand(value.treeCount === Object.keys(expected).length && value.ticks > 0 && value.concurrentSettings.ok, 'full git/count/liveness controls');
        let broke = false; try { demand(value.treeSha256 === '0'.repeat(64), 'intentional watch hash mismatch'); } catch { broke = true; } demand(broke, 'negative watch hash control');
        const wire = await page.evaluate('window.__watchWire'), native = await main.evaluate('({ticks:globalThis.__watchMain.ticks,maxGapMs:globalThis.__watchMain.gap,rssPeak:globalThis.__watchMain.rss,methods:globalThis.__watchMain.methods})');
        demand(wire.maxBytes <= 1048576 && wire.forbidden === 0 && native.ticks > 0, 'actual frame and main heartbeat controls');
        if (!BASELINE) demand(wire.refetch === 1 && native.methods['files.watchState'] === 1, 'one oversized batch/refetch for all views');
        const row = { label: `${views}-views`, ...value, wire, native }; reports.push(row); console.log(`FILES_WATCH ${JSON.stringify(row)}`);
    }
    await run({ action: 'stop' }); await sleep(500); const before = await page.evaluate('window.__watchWire.files'); writeFileSync(join(workspace, 'watched.txt'), 'released'); await sleep(1000);
    if (!BASELINE) { demand(await page.evaluate('window.__watchWire.files') === before, 'last release leaves no Files frames after a positive batch'); reports.push({ label: 'last-release-quiet', passed: true }); }
    else reports.push({ label: 'last-release-quiet', measured: false, reason: 'baseline native IPC is outside the frame gauge' });
    code = 0;
} catch (e) { failure = e.stack ?? String(e); console.error(failure); }
finally {
    try { await page?.evaluate('window.__filesWatchRun&&(window.__filesWatchRun.live=false,window.__filesWatchRun.offs.forEach(off=>off()),clearInterval(window.__filesWatchRun.timer));true'); } catch {}
    try { await main?.evaluate('globalThis.__watchMain?.stop();true'); } catch {}
    try { await main?.evaluate("process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').app.quit();true"); } catch {}
    for (const session of sessions) session.socket.close(); await sleep(1000); if (app?.exitCode === null) { try { app.kill('SIGTERM'); } catch {} }
    const record = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null;
    if (hostRecord && record?.pid === hostRecord.pid && record.startedAt === hostRecord.startedAt && Number.isFinite(record.startedAt) && record.startedAt >= started) { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
    mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'files-watch-result.json'), JSON.stringify({ code, baseline: BASELINE, platform: process.platform, head: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; } })(), root, failure, reports, limits: ['P4 server stays main', 'unit hub counts git runs; VM frame counts do not', 'native git oracle adds workload', 'host peak RSS unmeasured', 'installed app and physical VM gates remain coordinator-owned'] }, null, 2)); process.exitCode = code;
}

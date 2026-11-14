#!/usr/bin/env node
/** CI/test VM only. Copy both draft scripts to the pinned 7D baseline and add --baseline there. */
import { mainWindow } from './cdp-main-window.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { measureChatDraftsPage } from './chat-drafts-measure-page.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';

const WIN = process.platform === 'win32', BASELINE = process.argv.includes('--baseline'), OUT = resolve('smoke-out'), PORT = 9344, INSPECT = 9345, started = Date.now(), sessions = [], reports = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const demand = (ok, reason) => { if (!ok) throw new Error(reason); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function logTail(path) {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 32768)); let at = 0;
        while (at < bytes.length) { const count = readSync(fd, bytes, at, bytes.length - at, size - bytes.length + at); if (!count) break; at += count; }
        return bytes.subarray(0, at).toString('utf8');
    } finally { closeSync(fd); }
}
const targets = async port => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await read().catch(() => null); if (value) return value; await sleep(100); } throw new Error(`${label} was not ready`); }
class Cdp {
    next = 0; pending = new Map();
    static async connect(url) {
        const c = new Cdp(); c.socket = new WebSocket(url);
        c.socket.addEventListener('message', event => { const frame = JSON.parse(event.data); { const done = c.pending.get(frame.id); if (typeof done === 'function') done(frame); } c.pending.delete(frame.id); });
        c.socket.addEventListener('close', () => { for (const done of c.pending.values()) done({ error: { message: 'CDP closed' } }); c.pending.clear(); });
        let timer;
        try { await Promise.race([new Promise((resolve, reject) => { c.socket.addEventListener('open', resolve, { once: true }); c.socket.addEventListener('error', reject, { once: true }); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP connect timed out')), 10000); })]); }
        finally { clearTimeout(timer); }
        sessions.push(c); return c;
    }
    async evaluate(expression) {
        const id = ++this.next; let timer;
        try {
            const frame = await Promise.race([new Promise(resolve => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CDP operation timed out')), 120000); })]);
            if (frame.error || frame.result?.exceptionDetails) throw new Error(frame.error?.message ?? frame.result.exceptionDetails.exception?.description ?? 'page exception');
            return frame.result.result.value;
        } finally { clearTimeout(timer); this.pending.delete(id); }
    }
}
let app, page, main, root, hostRecord, failure = null, code = 1, ownedElectronLog = false;
const startup = {};
try {
    demand(process.env.CI === 'true' || process.env.GENIE_DRAFTS_MEASURE_ALLOW === '1' || (process.platform === 'linux' && process.env.USER === 'genie'), 'refused: run only in CI or an explicitly allowed test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT]) { let occupied = false; try { await targets(port); occupied = true; } catch (e) { if (e.name === 'TimeoutError') occupied = true; } demand(!occupied, `debugger port ${port} occupied; no app touched`); }
    root = mkdtempSync(join(tmpdir(), 'genie-chat-drafts-')); const workspace = join(root, 'workspace'), runtime = join(root, '.genie', 'runtime'); mkdirSync(workspace); mkdirSync(OUT, { recursive: true });
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1' };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15000, windowsHide: true });
    const template = json(join(runtime, 'agents.json'))[0], agents = [], drafts = {}, attachment = new Uint8Array(100 * 1024 * 1024).fill(0xa5), ref = randomUUID();
    mkdirSync(join(runtime, 'chat-drafts')); writeFileSync(join(runtime, 'chat-drafts', ref), attachment);
    for (let i = 0; i < 301; i++) {
        const id = `agent_${i.toString(16).padStart(32, '0')}`; agents.push({ ...template, id, name: `Draft fixture ${i}` });
        drafts[id] = { v: 1, text: `${i}: ${'雪'.repeat(1200)}`, pills: [{ kind: 'text', id: 'p1', text: `kept paste ${i}`, label: `label ${i}` }], attachments: i === 0 ? [{ id: 'file1', name: '100MiB.bin', type: 'application/octet-stream', bytes: attachment.byteLength, ref }] : [] };
    }
    writeFileSync(join(runtime, 'agents.json'), JSON.stringify(agents)); writeFileSync(join(runtime, 'chat-drafts.json'), JSON.stringify(drafts));
    const attachmentHash = sha(attachment), listBytes = Buffer.from(JSON.stringify(drafts)), paste = { v: 1, text: 'look at \u2063paste\u2063', pills: [{ kind: 'text', id: 'paste', text: 'x'.repeat(2 * 1024 * 1024), label: '2 MiB paste' }], attachments: [] };
    const fd = openSync(join(OUT, 'chat-drafts-electron.log'), 'w'), electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    ownedElectronLog = true;
    const args = ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`]; if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, launchStarted = Date.now();
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', fd, fd] }); closeSync(fd); app.on('error', e => console.error(e.message));
    // Startup is measured separately (#1587); it is not part of any content row's elapsed time.
    const target = await until('owned app page', async () => mainWindow(await targets(PORT)), 240000);
    startup.pageTargetMs = Date.now() - launchStarted;
    page = await Cdp.connect(target.webSocketDebuggerUrl); main = await Cdp.connect((await until('owned main inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl);
    startup.inspectorsConnectedMs = Date.now() - launchStarted;
    await waitForPageProbe(page); startup.pageBridgeMs = Date.now() - launchStarted;
    await until('ready page connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"'));
    startup.protocolReadyMs = Date.now() - launchStarted;
    startup.navigation = await page.evaluate('(()=>{const n=performance.getEntriesByType("navigation")[0];return n?{domInteractive:n.domInteractive,domContentLoaded:n.domContentLoadedEventEnd,load:n.loadEventEnd}:null})()');
    reports.push({ label: 'startup', elapsedMs: startup.protocolReadyMs, phases: startup }); console.log(`DRAFT_STARTUP ${JSON.stringify(reports.at(-1))}`);
    hostRecord = json(join(runtime, 'host.json'));
    const handlers = await main.evaluate(`(() => { const ipc=process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').ipcMain;
        const rss=process.memoryUsage().rss,s=globalThis.__draftMain={ticks:0,ticksBefore:0,gap:0,last:performance.now(),rss,rssBefore:rss,methods:{}};
        s.timer=setInterval(()=>{const now=performance.now();s.gap=Math.max(s.gap,now-s.last);s.last=now;s.ticks++;s.rss=Math.max(s.rss,process.memoryUsage().rss);},16);
        s.listener=(_event,action,_handle,text)=>{if(action==='frame'){const m=JSON.parse(text);if(m.method)s.methods[m.method]=(s.methods[m.method]??0)+1;}};
        ipc.on('genie:local-frame',s.listener);s.stop=()=>{clearInterval(s.timer);ipc.removeListener('genie:local-frame',s.listener);};
        return {drafts:['load','save','put-file','read-file','release'].map(op=>ipc._invokeHandlers.has('genie:chat-drafts-'+op)),windowRead:ipc._invokeHandlers.has('genie:window-overlay-colors-current')}; })()`);
    demand(handlers.windowRead && handlers.drafts.every(present => present === BASELINE), 'native draft-handler presence control'); reports.push({ label: 'path-control', baseline: BASELINE, handlers });
    await page.evaluate(`(() => { window.__draftWire={maxBytes:0,forbidden:0,pages:0,invalidPages:0}; window.genieLocalProtocol.onFrame((action,_handle,text)=>{if(action!=='frame')return;const m=JSON.parse(text),s=window.__draftWire;s.maxBytes=Math.max(s.maxBytes,new TextEncoder().encode(text).length);
        if(m.kind==='result'&&Array.isArray(m.value?.items)){s.pages++;if(m.value.items.length>128||new TextEncoder().encode(JSON.stringify(m.value)).length>524288)s.invalidPages++;}
        if(m.kind==='event'&&(m.channel==='snapshot'||m.channel==='activity'||m.channel==='local-activity'||m.channel?.startsWith('agent:')||m.channel?.startsWith('terminal-')))s.forbidden++;}); return true; })()`);
    const run = input => page.evaluate(`(${measureChatDraftsPage.toString()})(${JSON.stringify({ workspaceId: 'tynn', ...input })})`);
    const rows = [
        { label: 'attachment-100MiB', method: 'readFile', args: [ref], expect: { bytes: attachment.byteLength, sha256: attachmentHash } },
        { label: 'load-all-301', method: 'load', args: [], expect: { bytes: listBytes.length, sha256: sha(listBytes), count: 301 } },
        { label: 'paste-2MiB', method: 'save', args: [agents[0].id, paste], expect: { bytes: Buffer.byteLength(JSON.stringify(paste)), sha256: sha(JSON.stringify(paste)) } },
    ];
    for (const input of rows) {
        await page.evaluate('Object.assign(window.__draftWire,{maxBytes:0,forbidden:0,pages:0,invalidPages:0});true'); await main.evaluate('(()=>{const s=globalThis.__draftMain;s.methods={};s.gap=0;s.last=performance.now();s.rssBefore=s.rss=process.memoryUsage().rss;s.ticksBefore=s.ticks;return true;})()');
        const value = await run(input), wire = await page.evaluate('window.__draftWire'), native = await main.evaluate('((s)=>({ticks:s.ticks,ticksBefore:s.ticksBefore,maxGapMs:s.gap,rssBefore:s.rssBefore,rssPeak:Math.max(s.rss,process.memoryUsage().rss),methods:s.methods}))(globalThis.__draftMain)');
        demand(value.heartbeat.before > 0 && value.heartbeat.after > 0 && value.concurrentSettings.ok && native.ticks > native.ticksBefore && wire.maxBytes <= 1048576 && wire.forbidden === 0 && wire.invalidPages === 0, 'draft completeness/frame/heartbeat/settings controls');
        if (!BASELINE && input.method === 'load') demand(native.methods['blob.open'] === 1 && wire.pages >= 3, 'one blob and count-bounded pages for all drafts');
        if (!BASELINE && input.method === 'save') demand(native.methods['localUpload.begin'] === 1 && native.methods['localUpload.chunk'] > 1, 'large paste uses bounded local staging');
        const row = { label: input.label, ...value, wire, native }; reports.push(row); console.log(`CHAT_DRAFTS ${JSON.stringify(row)}`);
        if (!BASELINE && input.method === 'readFile') demand(native.maxGapMs < 250 && native.rssPeak - native.rssBefore < 100 * 1024 * 1024, `100MiB attachment blocked main or retained its bytes: gap=${native.maxGapMs}ms RSS growth=${native.rssPeak - native.rssBefore}B`);
    }
    let broke = false; try { await run({ method: 'load', args: [], expect: { sha256: '0'.repeat(64) } }); } catch (e) { demand(/hash differs/.test(e.message), 'negative draft hash failed for another reason'); broke = true; }
    demand(broke, 'deliberate draft hash mismatch must fail'); reports.push({ label: 'negative-hash-control', passed: true }); code = 0;
} catch (e) { failure = e.stack ?? String(e); console.error(failure); }
finally {
    try { await main?.evaluate('globalThis.__draftMain?.stop();true'); } catch {}
    try { await main?.evaluate("process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').app.quit();true"); } catch {}
    for (const session of sessions) session.socket.close(); await sleep(1000); if (app?.exitCode === null) { try { app.kill('SIGTERM'); } catch {} }
    const record = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null;
    if (hostRecord && record?.pid === hostRecord.pid && record.startedAt === hostRecord.startedAt && Number.isFinite(record.startedAt) && record.startedAt >= started) { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
    const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; } })();
    const result = { code, baseline: BASELINE, platform: process.platform, head, root, failure, reports, limits: ['server stays in main', 'startup measured separately; #1587 remains separate', 'save read-back/hash verification outside save latency', 'whole attachment SHA checked; peak host RSS unmeasured', 'physical VM and installed-ASAR gates remain coordinator-owned'] };
    mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'chat-drafts-result.json'), JSON.stringify(result, null, 2));
    for (const [name, path] of [['lifecycle', root ? join(root, '.genie', 'runtime', 'lifecycle.log') : null], ['electron', ownedElectronLog ? join(OUT, 'chat-drafts-electron.log') : null]]) {
        try { const tail = logTail(path); writeFileSync(join(OUT, `chat-drafts-${name}-tail.log`), tail); console.log(`DRAFT_LOG_TAIL ${name} ${JSON.stringify(tail)}`); }
        catch { console.log(`DRAFT_LOG_TAIL ${name} unavailable`); }
    }
    console.log(`DRAFT_RESULT ${JSON.stringify(result)}`); process.exitCode = code;
}

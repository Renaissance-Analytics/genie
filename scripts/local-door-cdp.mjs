#!/usr/bin/env node
/**
 * Native P4 door proof. Run from a built tree on CI/a test VM only:
 *   node scripts/local-door-cdp.mjs
 * LOCAL_DOOR_CDP_ALLOW=1 permits the Windows VM. Never run on the owner's desktop.
 * Own temporary home/profile/workspace, real app, preload, IPC receiver and provider driver.
 * Main's inspector observes actual accepted sockets (no product probe). Outbound size tests
 * call that actual door socket's send; they do not manufacture a large business result.
 * Child checks distinguish absent native APIs from receiver calls with real child identities.
 * Exit0 all measured/pass;1 a failed assertion;2 unavailable coverage/environment. UNMEASURED
 * is never PASS. --break-admission deliberately removes main's admission before row1, to
 * prove this after-the-feature harness fails on broken native admission. Nothing in src changes.
 */
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIN = process.platform === 'win32';
const started = Date.now();
const reports = [];
const sessions = [];
const agents = [];
const providerPids = new Set();
let phase = 'safety gate';
let app, inspector, main, remote, server, root, childEnv, mainId, hostPid;
let cleaned = false;
const PORT = Number(process.env.CDP_PORT ?? 9334);
const INSPECT = Number(process.env.LOCAL_DOOR_CDP_INSPECT ?? 9335);
const OUT = resolve('smoke-out');
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
const BREAK = process.argv.includes('--break-admission');
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Unmeasured extends Error {}
function demand(ok, message) { if (!ok) throw new Error(message); }
function result(number, status, message) {
    reports.push({ number, status, message });
    log(`${status} ${number}: ${message}`);
}
async function row(number, label, fn) {
    phase = `${number} ${label}`; log(`ROW ${phase}`);
    try { result(number, 'PASS', `${label}: ${await fn() ?? 'measured'}`); }
    catch (error) { result(number, error instanceof Unmeasured ? 'UNMEASURED' : 'FAIL', `${label}: ${error.message}`); }
}
function within(ms, label, promise) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline ${ms}ms`)), ms); })]).finally(() => clearTimeout(timer));
}
async function until(label, fn, ms = 20_000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        try { const value = await within(Math.min(6_000, Math.max(1, end - Date.now())), label, fn()); if (value) return value; }
        catch (error) { last = error.message; }
        await sleep(200);
    }
    throw new Error(`${label}: no positive result in ${ms}ms${last ? ` (${last})` : ''}`);
}
const alive = (pid) => { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

class Cdp {
    socket; next = 0; pending = new Map();
    static async connect(url) {
        const c = new Cdp(); c.socket = new WebSocket(url);
        c.socket.addEventListener('message', (event) => {
            const frame = JSON.parse(event.data); const done = c.pending.get(frame.id);
            if (done) { c.pending.delete(frame.id); done(frame); }
        });
        c.socket.addEventListener('close', () => { for (const done of c.pending.values()) done({ error: { message: 'CDP closed' } }); c.pending.clear(); });
        await within(10_000, 'CDP connect', new Promise((resolve, reject) => {
            c.socket.addEventListener('open', resolve, { once: true }); c.socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
        }));
        sessions.push(c); return c;
    }
    async send(method, params = {}, ms = 15_000) {
        const id = ++this.next;
        const response = await within(ms, method, new Promise((resolve) => { this.pending.set(id, resolve); this.socket.send(JSON.stringify({ id, method, params })); })).finally(() => this.pending.delete(id));
        if (response.error) throw new Error(`${method}: ${response.error.message}`);
        return response.result;
    }
    async evaluate(expression, ms = 15_000) {
        const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        return response.result.value;
    }
    close() { try { this.socket.close(); } catch { /* already closed */ } }
}
const targets = async (port = PORT) => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
async function pageFor(predicate) { return until('page target', async () => (await targets()).find((t) => t.webSocketDebuggerUrl && predicate(t)), 60_000); }
const evaluateFn = (cdp, fn, arg) => cdp.evaluate(`(${fn.toString()})(${JSON.stringify(arg)})`);

// Observe the real preload after it is ready, before opening an explicit native probe connection.
function browserProbe() {
    const attach = () => {
        if (!window.genieLocalProtocol) return;
        clearInterval(timer);
        const state = window.__doorCdp = { total: 0, frames: [], welcome: null, handle: null, next: 1_000_000 };
        window.genieLocalProtocol.onFrame((action, handle, text) => {
            let frame = null;
            if (action === 'frame') { try { frame = JSON.parse(text); } catch { /* measured as a frame nonetheless */ } }
            state.total++;
            state.frames.push({ seq: state.total, action, handle, bytes: new TextEncoder().encode(text).length, frame, reason: action === 'closed' ? text : null });
            if (state.frames.length > 32) state.frames.shift();
            if (frame?.kind === 'welcome') { state.welcome = frame; state.handle = handle; }
        });
        state.wait = async (after, predicate) => {
            const end = Date.now() + 8_000;
            while (Date.now() < end) {
                const found = state.frames.find((f) => f.seq > after && predicate(f));
                if (found) return found;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error('native frame response did not arrive');
        };
        state.call = async (method, args) => {
            const id = ++state.next, after = state.total;
            window.genieLocalProtocol.send('frame', state.handle, JSON.stringify({ kind: 'call', id, method, args }));
            return (await state.wait(after, (f) => f.frame?.kind === 'result' && f.frame.id === id)).frame;
        };
    };
    const timer = setInterval(attach, 5);
    attach(); setTimeout(() => clearInterval(timer), 10_000);
}
async function attachPage(cdp) {
    await cdp.send('Page.reload');
    await until('native preload after reload', () => cdp.evaluate('typeof window.genieLocalProtocol === "object" && document.readyState === "complete"'), 30_000);
    await cdp.evaluate(`(${browserProbe.toString()})()`);
    const answer = await cdp.evaluate(`(async () => {
        const s=window.__doorCdp, after=s.total, handle='cdp_'+crypto.randomUUID();
        window.genieLocalProtocol.send('open',handle,'');
        window.genieLocalProtocol.send('frame',handle,JSON.stringify({kind:'hello',auth:{kind:'local'},label:'native door probe'}));
        return (await s.wait(after,f=>f.handle===handle&&(f.frame?.kind==='welcome'||f.frame?.kind==='refused'))).frame;
    })()`);
    demand(answer.kind === 'welcome' && answer.isOwner, `actual refusal: ${answer.reason ?? 'no owner welcome'}`);
    if (cdp === main) {
        // Opening replaces the App's connection. Restore it using the real UI, so later tab
        // creation still uses the product's stable family bridge. Other probe windows use
        // their explicit native connection directly and are reported as such.
        await until('actual main Retry button after replacement', () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="alert"] button')).some(b=>b.textContent.trim()==='Retry')`));
        await cdp.evaluate(`(async () => {
            const s=window.__doorCdp, after=s.total;
            Array.from(document.querySelectorAll('[role="alert"] button')).find(b=>b.textContent.trim()==='Retry').click();
            await s.wait(after,f=>f.frame?.kind==='welcome');
            return true;
        })()`);
    }
}
const call = (cdp, method, args) => evaluateFn(cdp, ({ method, args }) => window.__doorCdp.call(method, args), { method, args });
const welcome = (cdp) => cdp.evaluate('window.__doorCdp?.welcome');

// Inspect the real registered receiver's closure. No new export/probe in the product.
async function doorScopes() {
    const f = await inspector.send('Runtime.evaluate', { expression: `process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').ipcMain.listeners('genie:local-frame')[0]` });
    demand(f.result?.objectId, 'the real local-frame receiver must exist');
    const props = await inspector.send('Runtime.getProperties', { objectId: f.result.objectId });
    const scopes = props.internalProperties?.find((p) => p.name === '[[Scopes]]')?.value.objectId;
    demand(scopes, 'V8 exposes receiver scopes to the inspector');
    const list = await inspector.send('Runtime.getProperties', { objectId: scopes, ownProperties: true });
    for (const scope of list.result) {
        if (!scope.value?.objectId) continue;
        const vars = (await inspector.send('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true })).result;
        const admitted = vars.find((v) => v.name === 'admitted')?.value.objectId;
        const listeners = vars.find((v) => v.name === 'listeners')?.value.objectId;
        if (admitted && listeners) return { admitted, listeners, receiver: f.result.objectId };
    }
    throw new Error('the native receiver closure has no admitted Map/listeners Set');
}
async function observeDoor(refs) {
    const r = await inspector.send('Runtime.callFunctionOn', { objectId: refs.listeners,
        arguments: [{ objectId: refs.admitted }, { objectId: refs.receiver }], returnByValue: true,
        functionDeclaration: `function(admitted, receiver) {
            const s = globalThis.__doorNative = { admitted, receiver, records: [], released: [], total: 0 };
            const observer = (socket) => {
                const record = { socket, closed: false, connectionId: null, frames: 0 };
                s.records.push(record);
                const send = socket.send;
                socket.send = (text) => {
                    record.frames++; s.total++;
                    try { const f = JSON.parse(text); if (f.kind === 'welcome') { record.connectionId = f.connectionId; record.owner = f.isOwner; record.hasToken = Object.hasOwn(f, 'token'); } } catch {}
                    return send(text);
                };
                socket.onClose(() => { record.closed = true; s.released.push({ connectionId: record.connectionId, count: s.records.filter((r) => !r.closed).length }); });
            };
            this.add(observer); s.detach = () => this.delete(observer);
            s.summary = () => ({ total: s.total, live: s.records.filter((r) => !r.closed).length, records: s.records.map(({ connectionId, closed, frames, owner, hasToken }) => ({ connectionId, closed, frames, owner, hasToken })), released: s.released });
            return true;
        }` });
    demand(r.result?.value === true, 'actual socket observer installed');
}
const nativeSummary = () => inspector.evaluate('globalThis.__doorNative.summary()');

async function cleanup() {
    if (cleaned) return; cleaned = true;
    log('cleanup: only this run’s agent, app tree and isolated-home host');
    if (main) for (const id of agents) { try { await main.evaluate(`window.genie.stopAgent(${JSON.stringify(id)}); true`, 5_000); } catch { /* dead page */ } }
    try { await inspector?.evaluate('globalThis.__doorNative?.detach(); true', 3_000); } catch { /* gone */ }
    for (const c of sessions) c.close(); remote?.close();
    if (app?.pid) {
        try { if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { timeout: 15_000, stdio: 'ignore' }); else process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    if (root) {
        const record = readJson(join(root, '.genie', 'runtime', 'host.json'));
        // A fresh private home had no record before launch; never enumerate or kill other Genies.
        hostPid ??= record?.pid;
        if (alive(hostPid)) { try { process.kill(hostPid, 'SIGTERM'); } catch { /* gone */ } }
        for (let i = 0; i < 20 && alive(hostPid); i++) await sleep(250);
        if (alive(hostPid)) { try { process.kill(hostPid, 'SIGKILL'); } catch { /* gone */ } }
    }
    for (const pid of providerPids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { if (readFileSync(TICKER, 'utf8').trim() === String(process.pid)) rmSync(TICKER); } catch { /* not ours */ }
    server?.close();
}

let exiting = false;
async function finish() {
    if (exiting) return; exiting = true;
    clearTimeout(watchdog); await cleanup();
    for (let n = 1; n <= 10; n++) if (!reports.some((r) => r.number === n)) result(n, 'UNMEASURED', `not reached after ${phase}`);
    const code = reports.some((r) => r.status === 'FAIL') ? 1 : reports.some((r) => r.status === 'UNMEASURED') ? 2 : 0;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, BREAK ? 'local-door-break-result.json' : 'local-door-result.json'), JSON.stringify({ code, breakAdmission: BREAK, reports }, null, 2));
    log(`LOCAL DOOR ${code === 0 ? 'ALL MEASURED/PASS' : code === 1 ? 'FAILED' : 'INCOMPLETE'}; exit ${code}`);
    process.exit(code);
}
const watchdog = setTimeout(() => {
    result(Number.parseInt(phase) || 1, 'FAIL', `watchdog at ${phase}`);
    setTimeout(() => process.exit(1), 45_000).unref(); void finish();
}, Number(process.env.LOCAL_DOOR_CDP_DEADLINE_MS ?? 240_000));

try {
    const user = process.env.USER ?? process.env.USERNAME ?? '';
    if (process.env.CI !== 'true' && process.env.LOCAL_DOOR_CDP_ALLOW !== '1' && !(process.platform === 'linux' && user === 'genie')) throw new Unmeasured('refused: launches Electron; CI or an explicitly allowed test VM only');
    demand(existsSync('dist/main/entry.js') && existsSync('scripts/smoke-seed.mjs'), 'run from a built Genie checkout');
    // Refuse occupied ports; never attach to an app we did not launch.
    for (const port of [PORT, INSPECT]) {
        let busy = false;
        try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) }); busy = true; } catch (e) { if (e.name === 'TimeoutError') busy = true; }
        demand(!busy, `debugger port ${port} is occupied; no existing app was touched`);
    }
    root = mkdtempSync(join(tmpdir(), 'genie-local-door-'));
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local door panel</title><p>door control</p>'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    childEnv = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1', GENIE2_CODEX_BINARY: resolve('scripts/stub-codex.mjs') };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env: childEnv, timeout: 15_000, stdio: 'pipe' });
    // Only the manifest just created in this private workspace is extended; the checkout is untouched.
    const manifest = readJson(join(workspace, 'project.json'));
    demand(manifest, 'private workspace seed manifest exists');
    writeFileSync(join(workspace, 'project.json'), JSON.stringify({ ...manifest, name: 'Local door', sites: { doorpanelaaaaaaaa: { repo: '', name: 'doorpanel', genName: 'doorpanel.gen', kind: 'http', runMode: 'host', hostPort: server.address().port, enabled: true } } }));
    writeFileSync(join(root, '.genie', 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'tynn', path: workspace }]));
    // Use the normal preference in this private fixture, so row9 measures actual tailnet availability.
    const settingsFile = join(root, '.genie', 'runtime', 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ ...readJson(settingsFile), remote_access: true }));
    // Ticker ownership is checked; a concurrent harness is not overwritten.
    let marker; try { marker = Number(readFileSync(TICKER, 'utf8').trim()); } catch { /* absent */ }
    demand(!alive(marker), 'another live harness owns the provider ticker');
    writeFileSync(TICKER, String(process.pid));
    mkdirSync(OUT, { recursive: true });
    const fd = openSync(join(OUT, BREAK ? 'local-door-break-electron.log' : 'local-door-electron.log'), 'w');
    const electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`];
    if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    log(`launcher: ${needsXvfb ? 'xvfb-run (no display)' : 'Electron directly (existing display or non-Linux)'}`);
    app = spawn(needsXvfb ? 'xvfb-run' : electron,
        needsXvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args,
        { env: childEnv, detached: !WIN, windowsHide: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    app.on('error', (error) => log(`launch error: ${error.message}`));
    phase = '1 launch and inspect';
    const target = await pageFor((t) => t.type === 'page' && /index\.html/.test(t.url));
    main = await Cdp.connect(target.webSocketDebuggerUrl);
    inspector = await Cdp.connect((await until('main inspector', async () => (await targets(INSPECT))[0], 30_000)).webSocketDebuggerUrl);
    await until('preload/door registration', () => main.evaluate('typeof window.genieLocalProtocol === "object" && typeof window.genie === "object"'), 60_000);
    await until('real composed services', () => main.evaluate('window.genie.features.snapshot().then(d=>!!d.remote)'), 60_000);
    const refs = await doorScopes(); await observeDoor(refs);
    mainId = await inspector.evaluate(`(() => { const { BrowserWindow } = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron'); return BrowserWindow.getAllWindows().find((w) => /index\\.html/.test(w.webContents.getURL())).webContents.id; })()`);
    if (BREAK) await inspector.evaluate(`(() => { for (const wc of globalThis.__doorNative.admitted.keys()) if (wc.id === ${mainId}) globalThis.__doorNative.admitted.delete(wc); return true; })()`);
    await row(1, 'CONTROL actual main preload owner welcome without a token', async () => {
        await attachPage(main);
        const w = await welcome(main);
        demand(w?.isOwner === true && !Object.hasOwn(w, 'token'), 'welcome must be owner and have no token');
        const summary = await nativeSummary(); demand(summary.live >= 1 && summary.records.some((r) => r.connectionId === w.connectionId && r.owner && !r.hasToken), 'accepted native socket must be observed');
        return `owner=true; token absent; live native sockets=${summary.live}`;
    });
    if (reports.some((r) => r.number === 1 && r.status !== 'PASS')) throw new Error('main control failed; later absence rows cannot be trusted');

    await row(2, 'family1 settings crosses the door; old IPC removed', async () => {
        const r = await call(main, 'workspaces.settings', ['tynn']);
        demand(r.ok && r.value?.ok && typeof r.value.values.workspace_tabs === 'string', 'real settings response expected');
        const handlers = await inspector.evaluate(`(() => { const h = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').ipcMain._invokeHandlers; return { available: typeof h?.has === 'function', control: h?.has('genie:snapshot'), removed: h?.has('genie:workspace-settings') }; })()`);
        demand(handlers.available && handlers.control === true && handlers.removed === false, 'existing snapshot handler controls old-handler absence');
        return 'settings result received; snapshot IPC present; workspace-settings IPC absent';
    });

    const windows = {};
    for (const [kind, open, matches] of [
        ['files', `window.genie.files.windows.popOut('tynn')`, (t) => /genie:\/\/files\//.test(t.url)],
        ['flow', `window.genie.features.act({kind:'flows.newFlow',workspaceId:'tynn'})`, (t) => /genie:\/\/flow\//.test(t.url)],
    ]) await row(3, `${kind} product window owner welcome`, async () => {
        await main.evaluate(`${open}; true`);
        const target = await pageFor(matches), cdp = await Cdp.connect(target.webSocketDebuggerUrl);
        await attachPage(cdp); windows[kind] = cdp;
        demand((await welcome(cdp))?.isOwner === true && !Object.hasOwn(await welcome(cdp), 'token'), 'owner/no-token welcome');
        return `${kind} connected via its real preload`;
    });

    await row(3, 'take-over product window owner welcome, if available', async () => {
        const snap = await main.evaluate('window.genie.snapshot()');
        const id = snap.agents.find((a) => a.provider === 'codex')?.id;
        if (!id) throw new Unmeasured('seed has no suitable take-over agent');
        const r = await main.evaluate(`window.genie.takeOver(${JSON.stringify(id)})`);
        if (!r?.ok) throw new Unmeasured(`takeOver refused: ${r?.reason ?? 'no result'}`);
        const cdp = await Cdp.connect((await pageFor((t) => /take-?over/i.test(t.url))).webSocketDebuggerUrl);
        await attachPage(cdp);
        const w = await welcome(cdp); demand(w?.isOwner && !Object.hasOwn(w, 'token'), 'take-over owner/no-token welcome');
        windows.takeOver = cdp; return 'take-over connected via its own preload';
    });

    await row(4, 'actual panel and subframe API absence + real receiver identity refusals', async () => {
        const step = async (label, run) => {
            log(`  4 ${label}`);
            try { return await run(); } catch (error) { throw new Error(`${label}: ${error.message}`); }
        };
        const site = await until('declared fixture site', async () => (await main.evaluate('window.genie.features.snapshot()')).hosting?.sites?.find((s) => s.host === 'doorpanel.gen'), 30_000);
        await step('start declared fixture site', () => main.evaluate(`window.genie.features.act({kind:'hosting.startSite',siteId:${JSON.stringify(site.id)}})`));
        const before = await inspector.evaluate(`process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').webContents.getAllWebContents().map((w) => w.id)`);
        const tabs = { tabs: [{ id: 'door-tab', name: 'Door panel', layout: 'single', cells: [{ kind: 'site', ref: 'doorpanel.gen' }] }] };
        const r = await step('write the real site tab', () => call(main, 'workspaces.setSetting', ['tynn', 'workspace_tabs', JSON.stringify(tabs)]));
        demand(r.ok && r.value?.ok, 'real settings write builds the site tab');
        await main.evaluate(`location.hash='#genie://workspace/tynn?view=tab:door-tab'; true`);
        await until('real site panel box', () => main.evaluate('!!document.querySelector("[data-site-panel-box]")'), 30_000);
        const panelId = await until('native contents created by the panel', async () => {
            // Both WebContentsView and webview are found by role/creation, not a particular type name.
            return inspector.evaluate(`(() => {
                const { webContents, BrowserWindow } = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
                const roots = new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.id));
                const candidates = webContents.getAllWebContents().filter((w) => !${JSON.stringify(before)}.includes(w.id) && !roots.has(w.id) && w.getType() !== 'remote');
                return candidates.length === 1 ? candidates[0].id : null;
            })()`);
        }, 30_000);
        let lastPanelState;
        await step('panel document readiness', () => until('loaded fixture panel', async () => {
            const state = await inspector.evaluate(`(() => {
                const w = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').webContents.fromId(${panelId});
                return { url:w.getURL(), loading:w.isLoading(), mainLoading:w.isLoadingMainFrame() };
            })()`);
            const summary = JSON.stringify(state);
            if (summary !== lastPanelState) log(`  4 panel state: ${summary}`);
            lastPanelState = summary;
            return !state.loading && new URL(state.url || 'about:blank').hostname === 'doorpanel.gen';
        }, 20_000));
        await main.evaluate(`(() => { const frame = document.createElement('iframe'); frame.id='door-child-control'; document.body.appendChild(frame); return true; })()`);
        await until('blank child document ready', () => main.evaluate(`document.querySelector('#door-child-control')?.contentDocument?.readyState === 'complete'`));
        await until('native child frame', () => inspector.evaluate(`(() => {
            const wc = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').webContents.fromId(${mainId});
            return wc.mainFrame.framesInSubtree.some((f) => f !== wc.mainFrame);
        })()`));
        const expression = '({port:typeof window.genieLocalProtocol,ipc:typeof window.ipcRenderer,node:typeof require,body:document.body?.textContent})';
        const absence = {};
        for (const kind of ['panel', 'subframe']) absence[kind] = await step(`${kind} native API evaluation`, () => inspector.evaluate(`(async () => {
            const { webContents } = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
            const wc = webContents.fromId(${kind === 'panel' ? panelId : mainId});
            const frame = ${kind === 'panel' ? 'wc.mainFrame' : 'wc.mainFrame.framesInSubtree.find(f=>f!==wc.mainFrame)'};
            let timer;
            try { return await Promise.race([frame.executeJavaScript(${JSON.stringify(expression)}), new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('native frame evaluation deadline; url='+frame.url)),5_000); })]); }
            finally { clearTimeout(timer); }
        })()`));
        demand(absence.panel.body?.includes('door control'), 'panel loaded the actual fixture document');
        const measured = await step('actual receiver calls with native child identities', () => inspector.evaluate(`(() => {
            const { webContents } = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
            const main = webContents.fromId(${mainId}), panel = webContents.fromId(${panelId});
            const child = main.mainFrame.framesInSubtree.find((f) => f !== main.mainFrame);
            const reject = (sender, frame, handle) => {
                const replies = [], original = frame.send;
                const observed = function(channel, action, id, text) { if (channel === 'genie:local-frame-back' && id === handle) replies.push({action, text}); return original.call(this, channel, action, id, text); };
                frame.send = observed;
                if (frame.send !== observed) throw new Error('cannot observe actual child frame replies');
                try { globalThis.__doorNative.receiver({sender, senderFrame:frame}, 'open', handle, ''); }
                finally { frame.send = original; }
                return replies.map((r) => ({action:r.action, ...(r.action === 'frame' ? JSON.parse(r.text) : {reason:r.text})}));
            };
            return { panel: reject(panel,panel.mainFrame,'panel_identity_probe'), subframe: reject(main,child,'subframe_identity_probe') };
        })()`));
        for (const [kind, expected] of [['panel', /not an admitted/], ['subframe', /top.level/]]) {
            demand(absence[kind].port === 'undefined' && absence[kind].ipc === 'undefined' && absence[kind].node === 'undefined', `${kind} has no native preload IPC/Node API`);
            demand(measured[kind].some((f) => f.kind === 'refused' && expected.test(f.reason)) && measured[kind].some((f) => f.action === 'closed'), `${kind} actual receiver must refuse and close`);
        }
        log(`  4 native API absence: ${JSON.stringify(absence)}`);
        return `receiver checks (not child-originated IPC): ${measured.panel.find((f) => f.kind === 'refused').reason}; ${measured.subframe.find((f) => f.kind === 'refused').reason}`;
    });

    await row(5, 'reload releases the old real socket and a new owner connects', async () => {
        const old = await welcome(main), before = await nativeSummary();
        demand(before.live >= 1 && before.records.some((r) => r.connectionId === old.connectionId && !r.closed), 'positive live socket before reload');
        await attachPage(main);
        const next = await welcome(main), after = await nativeSummary();
        const released = after.released.find((r) => r.connectionId === old.connectionId);
        demand(released && released.count === before.live - 1, 'release callback count must fall by exactly one');
        demand(next.connectionId !== old.connectionId && after.live === before.live && after.records.some((r) => r.connectionId === next.connectionId && !r.closed), 'replacement restores native count with a different connection');
        return `live ${before.live} → ${released.count} → ${after.live}; different connection id`;
    });
    await row(6, 'second hello on the live native connection is refused', async () => {
        const r = await main.evaluate(`(async () => { const s=window.__doorCdp, after=s.total; window.genieLocalProtocol.send('frame',s.handle,JSON.stringify({kind:'hello',auth:{kind:'local'}})); return (await s.wait(after,f=>f.frame?.kind==='refused')).frame; })()`);
        demand(r.kind === 'refused' && /already.*hello/.test(r.reason), 'second-hello reason required');
        const control = await call(main, 'workspaces.settings', ['tynn']); demand(control.ok && control.value?.ok, 'live connection still answers a valid call');
        return r.reason;
    });
    await row(7, 'UTF-8 frame boundary in both directions, with exact-size controls', async () => {
        for (const bytes of [1024 * 1024, 1024 * 1024 + 1]) {
            const input = await evaluateFn(main, async (bytes) => {
                const s=window.__doorCdp, id=++s.next, after=s.total;
                const frame={kind:'call',id,method:'workspaces.settings',args:['tynn'],padding:''};
                const n=bytes-new TextEncoder().encode(JSON.stringify(frame)).length;
                frame.padding='€'.repeat(Math.floor(n/3))+'x'.repeat(n%3);
                const text=JSON.stringify(frame), actual=new TextEncoder().encode(text).length;
                window.genieLocalProtocol.send('frame',s.handle,text);
                const response=await s.wait(after,f=>bytes===1048576 ? f.frame?.kind==='result'&&f.frame.id===id : f.action==='closed');
                return {actual, response};
            }, bytes);
            demand(input.actual === bytes, 'incoming UTF-8 gauge exact');
            if (bytes === 1048576) demand(input.response.frame.ok && input.response.frame.value?.ok, 'exact 1MiB valid settings call accepted');
            else demand(input.response.action === 'closed' && /1 MiB/.test(input.response.reason), 'one extra input byte closes with cap reason');
        }
        await attachPage(main);
        for (const bytes of [1024 * 1024, 1024 * 1024 + 1]) {
            const w = await welcome(main), after = await main.evaluate('window.__doorCdp.total');
            const actual = await inspector.evaluate(`(() => {
                const record=globalThis.__doorNative.records.find(r=>r.connectionId===${JSON.stringify(w.connectionId)});
                if (!record || record.closed) throw new Error('no actual live native socket');
                const frame={kind:'event',channel:'door-boundary-control',payload:''};
                const n=${bytes}-Buffer.byteLength(JSON.stringify(frame),'utf8');
                frame.payload='€'.repeat(Math.floor(n/3))+'x'.repeat(n%3);
                const text=JSON.stringify(frame); record.socket.send(text); return Buffer.byteLength(text,'utf8');
            })()`);
            const response = await evaluateFn(main, async ({ after, bytes }) => window.__doorCdp.wait(after, f=>bytes===1048576 ? f.frame?.channel==='door-boundary-control' : f.action==='closed'), { after, bytes });
            demand(actual === bytes, 'outgoing UTF-8 gauge exact');
            if (bytes === 1048576) demand(response.bytes === bytes && response.frame.channel === 'door-boundary-control', 'exact output frame crosses actual preload');
            else demand(response.action === 'closed' && /1 MiB/.test(response.reason), 'one extra output byte refuses/closes actual socket');
        }
        await attachPage(main);
        return '1048576 accepted, 1048577 refused/closed each way (multibyte text)';
    });
    await row(8, 'one native window changes settings; the other receives and reads them without restart', async () => {
        demand(windows.files, 'files window is the second-window positive control');
        const b = windows.files, beforeWelcome = await welcome(b);
        const mark = await b.evaluate('window.__doorCdp.total');
        const value = '{"tabs":[],"doorNativeControl":true}';
        const r = await call(main, 'workspaces.setSetting', ['tynn', 'workspace_tabs', value]); demand(r.ok && r.value?.ok, 'write through main door');
        const event = await evaluateFn(b, async (mark) => window.__doorCdp.wait(mark, f=>f.frame?.kind==='event'&&f.frame.channel==='workspace-settings-changed'&&f.frame.payload==='tynn'), mark);
        demand(event.frame.payload === 'tynn', 'settings event reaches second actual preload');
        const read = await call(b, 'workspaces.settings', ['tynn']); demand(read.ok && read.value.values.workspace_tabs === value, 'second door reads changed store');
        const resetMark = await main.evaluate('window.__doorCdp.total');
        const reset = await call(b, 'workspaces.resetSetting', ['tynn', 'workspace_tabs']); demand(reset.ok && reset.value?.ok, 'reset through second window');
        await evaluateFn(main, async (mark) => window.__doorCdp.wait(mark, f=>f.frame?.channel==='workspace-settings-changed'), resetMark);
        const now = await call(main, 'workspaces.settings', ['tynn']); demand(now.ok && !now.value.overridden.includes('workspace_tabs'), 'override removed after reset');
        demand((await welcome(b)).connectionId === beforeWelcome.connectionId, 'second window never restarted/reconnected');
        return 'set/event/read, reset/event/read; second connection unchanged';
    });

    await row(9, 'local write under a real paired remote baton and lock, when tailnet is available', async () => {
        let access;
        try {
            access = await until('real tailnet availability', async () => {
                const state = await main.evaluate('window.genie.features.snapshot().then(d=>d.remote)');
                return state?.url || (state?.unavailable && !['not started', 'stopped'].includes(state.unavailable)) ? state : null;
            }, 75_000);
        } catch { throw new Unmeasured('the enabled fixture tailnet listener did not settle within 75s'); }
        const url = access.url;
        if (!url) throw new Unmeasured(access.unavailable ?? 'no advertised tailnet endpoint');
        const label = `door-native-${process.pid}`;
        const issued = await main.evaluate(`window.genie.features.act({kind:'remote.issuePin'})`);
        demand(issued.remote?.pin?.code, 'native pairing PIN issued (not printed)');
        remote = new WebSocket(url);
        const frames = [];
        remote.addEventListener('message', (event) => { frames.push(JSON.parse(event.data)); if (frames.length > 64) frames.shift(); });
        await within(10_000, 'real remote socket', new Promise((resolve, reject) => { remote.addEventListener('open',resolve,{once:true}); remote.addEventListener('error',()=>reject(new Unmeasured('advertised tailnet endpoint unreachable')),{once:true}); }));
        remote.send(JSON.stringify({kind:'hello',auth:{kind:'pin',code:issued.remote.pin.code},label}));
        await until('pairing request', async () => frames.find(f=>f.kind==='pairing'));
        const waiting = await until('own native Allow request', async () => (await main.evaluate('window.genie.features.snapshot()')).remote.pairRequests.find(p=>p.label===label));
        await main.evaluate(`window.genie.features.act({kind:'remote.answerPair',id:${JSON.stringify(waiting.id)},allow:true})`);
        await until('real remote owner welcome', async () => frames.find(f=>f.kind==='welcome'&&f.isOwner));
        let next=0;
        const rpc = async (method) => { const id=++next; remote.send(JSON.stringify({kind:'call',id,method,args:[]})); return until(method,async()=>frames.find(f=>f.kind==='result'&&f.id===id)); };
        try {
            demand((await rpc('baton.take')).ok && (await rpc('host.lock')).ok, 'remote really holds baton and lock');
            const before = await rpc('baton.status'); demand(before.value.mine && before.value.locked, 'remote status is the positive control');
            const value = '{"tabs":[],"remoteDoorControl":true}';
            const write = await call(main,'workspaces.setSetting',['tynn','workspace_tabs',value]); demand(write.ok&&write.value?.ok,'local write passes remote baton+lock');
            demand((await call(main,'workspaces.settings',['tynn'])).value.values.workspace_tabs===value,'store actually changed');
            const after = await rpc('baton.status'); demand(after.value.mine&&after.value.locked&&after.value.driver===before.value.driver,'remote holder and lock preserved');
            await call(main,'workspaces.resetSetting',['tynn','workspace_tabs']);
        } finally { await rpc('host.unlock').catch(()=>{}); await rpc('baton.release').catch(()=>{}); remote.close(); }
        return 'real remote status held throughout actual local store write';
    });
    await row(10, 'streaming positive control with zero frames on the app\'s own connection', async () => {
        let marker; try { marker = Number(readFileSync(TICKER,'utf8').trim()); } catch { /* absent */ }
        demand(marker===process.pid, 'this run owns ticker provider mode');
        const added = await main.evaluate(`window.genie.addAgent('tynn',{name:${JSON.stringify(`door-ticker-${process.pid}`)},purpose:'Native local-door streaming check',provider:'codex'})`);
        demand(added?.ok, `agent added: ${added?.reason??'no result'}`); agents.push(added.id);
        // Earlier admission/lifetime probes may replace the app's connection. Restore that
        // same pageBridge through its own recovery, observed by the existing preload listener.
        await waitForPageProbe(main);
        await main.evaluate('window.genieTest.localProtocol.retry()');
        const restarted = await main.evaluate(`window.genieTest.agents.restart(${JSON.stringify(added.id)},'graceful')`);
        demand(restarted?.ok, `start through app bridge: ${restarted?.reason??'no result'}`);
        demand(await main.evaluate('window.genieTest.localProtocol.state().phase === "ready"'), 'app owns a ready connection');
        // Off the workspace Dashboard: this view must have no activity subscription.
        await main.evaluate("location.hash='#genie://settings'; true");
        await until('streaming agent ready',()=>main.evaluate(`window.genie.agentDetail(${JSON.stringify(added.id)}).then(d=>d?.session?.running===true)`),30_000);
        const prompt = await main.evaluate(`window.genie.prompt(${JSON.stringify(added.id)},'Stream ticks until stopped.')`); demand(prompt?.ok,'real driver accepted prompt');
        const ticks = async () => main.evaluate(`window.genie.agentDetail(${JSON.stringify(added.id)}).then(d=>JSON.stringify(d?.rows??[]))`);
        const count = (text) => [...text.matchAll(/tick (\d+) pid (\d+)/g)].map(m=>{ providerPids.add(Number(m[2])); return Number(m[1]); });
        const frameMetadata = (from, to) => main.evaluate(`window.__doorCdp.frames.filter(r=>r.seq>${from}&&r.seq<=${to}).map(r=>({seq:r.seq,action:r.action,kind:r.frame?.kind??null,channel:r.frame?.channel??null}))`);
        await until('at least four real provider ticks',async()=>count(await ticks()).length>=4,30_000);
        // Positive frame gauge immediately before the silent streaming interval.
        const gaugeStart = await main.evaluate('window.__doorCdp.total');
        demand((await main.evaluate("window.genieTest.workspaces.settings('tynn')"))?.ok,'app bridge result positive control before absence');
        demand(await main.evaluate(`window.__doorCdp.total > ${gaugeStart}`),'the observer sees a result on the app connection');
        await sleep(500);
        const beforeTicks = Math.max(...count(await ticks()));
        const frameStart = await main.evaluate('window.__doorCdp.total');
        const appWelcome = await welcome(main);
        const nativeStart = await nativeSummary();
        await until('eight more provider ticks',async()=>Math.max(...count(await ticks()))>=beforeTicks+8,20_000);
        const afterTicks = Math.max(...count(await ticks()));
        const frameEnd = await main.evaluate('window.__doorCdp.total');
        const w = await welcome(main), nativeEnd = await nativeSummary();
        demand(w.connectionId===appWelcome.connectionId, 'the app connection is unchanged throughout streaming');
        demand(await main.evaluate('window.genieTest.localProtocol.state().phase === "ready"'), 'app connection stays ready');
        demand(nativeEnd.records.some(r=>r.connectionId===w.connectionId&&!r.closed),'native connection remains live');
        demand(frameEnd===frameStart,`no frame reached connected main preload while ledger grew${frameEnd===frameStart?'':`; observed ${JSON.stringify(await frameMetadata(frameStart,frameEnd))}`}`);
        demand(nativeEnd.records.find(r=>r.connectionId===w.connectionId).frames===nativeStart.records.find(r=>r.connectionId===w.connectionId).frames,'actual server socket also sent no frame');
        // Positive activity gauge on that SAME app connection, then a second absence interval.
        const activityAgent = await main.evaluate(`window.genie.addAgent('tynn',{name:${JSON.stringify(`door-activity-${process.pid}`)},purpose:'Native activity subscription positive control',provider:'codex'})`);
        demand(activityAgent?.ok, `activity control agent added: ${activityAgent?.reason??'no result'}`); agents.push(activityAgent.id);
        await main.evaluate(`window.__doorActivitySeen=0; window.__doorActivityOff=window.genieTest.activity.subscribe(feed=>{if(feed.agentId===${JSON.stringify(activityAgent.id)})window.__doorActivitySeen++}); true`);
        try {
            // A ticker appends to one reply: its first-line feed may stay identical. A real
            // new agent's first session changes the feed while the original ticker keeps going.
            const activityStart = await main.evaluate(`window.genieTest.agents.restart(${JSON.stringify(activityAgent.id)},'graceful')`);
            demand(activityStart?.ok,'own new agent started while its activity view watches');
            await until('activity control agent ready',()=>main.evaluate(`window.genie.agentDetail(${JSON.stringify(activityAgent.id)}).then(d=>d?.session?.running===true)`),30_000);
            demand((await main.evaluate(`window.genie.prompt(${JSON.stringify(activityAgent.id)},'Stream ticks for the activity positive control.')`))?.ok,'activity control driver accepts its prompt');
            await until('activity control provider has four real ticks',async()=>count(await main.evaluate(`window.genie.agentDetail(${JSON.stringify(activityAgent.id)}).then(d=>JSON.stringify(d?.rows??[]))`)).length>=4,30_000);
            await until('watched activity callback',()=>main.evaluate('window.__doorActivitySeen>=1'),20_000);
            demand(await main.evaluate('window.__doorCdp.frames.some(r=>r.frame?.kind==="event"&&r.frame.channel==="local-activity")'),'watched activity traverses the actual app frame channel');
            const watched = await nativeSummary();
            demand((await welcome(main)).connectionId===w.connectionId,'watch uses the unchanged app connection');
            demand(watched.records.find(r=>r.connectionId===w.connectionId).frames>nativeEnd.records.find(r=>r.connectionId===w.connectionId).frames,'native socket also measures watched activity frames');
        } finally { await main.evaluate('window.__doorActivityOff?.(); delete window.__doorActivityOff; true'); }
        await sleep(500);
        const unwatchTicks = Math.max(...count(await ticks())), unwatchStart = await main.evaluate('window.__doorCdp.total'), unwatchNative = await nativeSummary();
        // Coordinator5200/5202 probe: deliberately overlap a real check with this interval.
        // Keep strict zero until the actual unexpected channel has been measured on CI.
        demand(await inspector.evaluate(`(() => {
            const { Menu, BrowserWindow } = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
            const find = (items) => { for (const item of items) { if (item.label === 'Check for updates') return item; const nested = find(item.submenu?.items ?? []); if (nested) return nested; } return null; };
            const item = find(Menu.getApplicationMenu()?.items ?? []);
            if (!item) return false;
            item.click(item, BrowserWindow.getAllWindows().find(w=>w.webContents.id===${mainId}), {});
            return true;
        })()`), 'probe fired the real application-menu update check inside the zero interval');
        await until('eight more unwatched provider ticks',async()=>Math.max(...count(await ticks()))>=unwatchTicks+8,20_000);
        const unwatchEnd = await nativeSummary();
        const unwatchFrameEnd = await main.evaluate('window.__doorCdp.total');
        demand(unwatchFrameEnd===unwatchStart,`unwatched app receives zero frames again${unwatchFrameEnd===unwatchStart?'':`; observed ${JSON.stringify(await frameMetadata(unwatchStart,unwatchFrameEnd))}`}`);
        demand(unwatchEnd.records.find(r=>r.connectionId===w.connectionId).frames===unwatchNative.records.find(r=>r.connectionId===w.connectionId).frames,'native socket also sends zero frames after unwatch');
        demand((await welcome(main)).connectionId===w.connectionId,'unwatch keeps the same app connection');
        return `app connection ${w.connectionId}; ticks ${beforeTicks} → ${afterTicks}; page/native frame deltas=0/0; watched local-activity positive; unwatched page/native=0/0`;
    });
} catch (error) {
    if (!reports.some((r) => r.status === 'FAIL')) result(Number.parseInt(phase) || 1, error instanceof Unmeasured ? 'UNMEASURED' : 'FAIL', error.message);
}
await finish();

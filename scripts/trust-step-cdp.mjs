#!/usr/bin/env node
/**
 * THE TRUST STEP, AS A PERSON SEES IT, in the real app (the owner: acceptance is what a person sees, not return codes).
 *
 *   node scripts/trust-step-cdp.mjs            (Linux: under xvfb-run)
 *
 * It starts the app itself, with a home folder and a debugger port of its own, so it touches neither the other smokes nor
 * anything of the person's. Run on CI and the test VMs, never on a desktop.
 *
 *   add a workspace with a hook on its list → the step at the top names the hook → a yes that cannot be saved says why and
 *   offers Retry, still untrusted → Retry shows progress, the step goes, Genie's files go in → after a relaunch it reads
 *   trusted. A second workspace nobody trusted is the control: the step still shows for it, in both runs.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
// The feature snapshot is read on the page's own bridge now (P4 family 11): window.genieTest needs this.
process.env.GENIE_PAGE_PROBE ??= '1';

const PORT = Number(process.env.TRUST_CDP_PORT ?? 9344);
const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), 'trust-step-'));
const home = join(root, 'home');
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
const log = join(root, 'electron.log');
const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
};
const electron = createRequire(import.meta.url)('electron');

function launch() {
    const out = openSync(log, 'a');
    const args = ['.', `--remote-debugging-port=${PORT}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
    return spawn(electron, args, { env, stdio: ['ignore', out, out], detached: process.platform !== 'win32', windowsHide: false });
}
/** This run's genie-host, by its own record (`<genieHome>/runtime/host.json`): its pid, or null. */
function hostPid() {
    try {
        const raw = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'host.json'), 'utf8'));
        return typeof raw.pid === 'number' ? raw.pid : null;
    } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
/**
 * genie-host is detached: it outlives the window by design. The relaunch must boot a NEW host on both systems (the verdicts
 * then come from its first pass, the path a restart takes), so the host this run started is stopped by the pid in its own
 * record — never by a pattern. Windows' taskkill /T already reaches it (its parent pid is the window); Linux's group signal
 * does not (it is in its own session).
 */
async function stopHost(pid) {
    if (pid === null || !alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* it has gone */ }
    for (const end = Date.now() + 15_000; alive(pid) && Date.now() < end;) await sleep(100);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* it has gone */ } }
    for (const end = Date.now() + 5_000; alive(pid) && Date.now() < end;) await sleep(100);
}
async function stop(app) {
    const host = hostPid();
    const gone = new Promise((r) => { if (app.exitCode !== null) r(); else app.once('exit', r); });
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* it has gone */ }
    } else {
        try { process.kill(-app.pid, 'SIGTERM'); } catch { /* it has gone */ }
    }
    await Promise.race([gone, sleep(20_000)]);
    if (app.exitCode === null && process.platform !== 'win32') {
        try { process.kill(-app.pid, 'SIGKILL'); } catch { /* it has gone */ }
    }
    await stopHost(host);
    stopped.push({ host, gone: host === null ? null : !alive(host) });
    // The debugger port and the single-instance lock are free before the next launch.
    await sleep(2000);
}
/** Each stop's host and whether it went: the relaunch rows read them. */
const stopped = [];

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect() {
        const until = Date.now() + 90_000;
        let page = null;
        let last = 'no attempt';
        while (Date.now() < until && !page) {
            try {
                // Bounded (Tynn #692: on the Azure Windows VM this row printed its title and nothing for 60 minutes).
                const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
                page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
                last = `no page yet (${targets.length})`;
            } catch (error) { last = String(error); }
            if (!page) await sleep(500);
        }
        if (!page) throw new Error(`no window on the debugger port: ${last}`);
        const c = new Cdp();
        c.#ws = new WebSocket(page.webSocketDebuggerUrl);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`the page's debugger socket did not open within 15 s (${page.url?.slice(0, 80)})`)), 15_000);
            c.#ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
            c.#ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP socket error')); }, { once: true });
        });
        return c;
    }
    /** Every request is answered or fails within 120 s, naming what it asked: a page that stops answering is a failure. */
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r, rej) => {
            const timer = setTimeout(() => { this.#pending.delete(id); rej(new Error(`no answer to ${method} within 120 s${params.expression ? `: ${String(params.expression).slice(0, 120)}` : ''}`)); }, 120_000);
            this.#pending.set(id, (f) => { clearTimeout(timer); r(f); });
            this.#ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (f.error) throw new Error(`CDP: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result.result.value;
    }
    /** A function in the page, its values passed as data: nothing of them becomes code. */
    async call(functionDeclaration, ...args) {
        const page = await this.send('Runtime.evaluate', { expression: 'globalThis' });
        const f = await this.send('Runtime.callFunctionOn', { functionDeclaration, objectId: page.result.result.objectId, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
        if (f.error) throw new Error(`CDP: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result.result.value;
    }
    close() { this.#ws.close(); }
}
async function waitFor(cdp, expression, ms = 30_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await cdp.evaluate(expression)) return true;
        await sleep(200);
    }
    return false;
}

function workspaceFolder(name, hook) {
    const folder = join(root, name);
    mkdirSync(join(folder, '.claude'), { recursive: true });
    writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook }] }] } }));
    execFileSync('git', ['init', '-q'], { cwd: folder, windowsHide: true, stdio: 'ignore', timeout: 30_000 });
    return folder;
}
/** A workspace id, as text in an expression: only a word, or this stops here. */
const word = (id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`not a workspace id: ${String(id)}`);
    return id;
};
/*
 * Go to a workspace, and stay there: just after a launch the app lands on its own route (the Dashboard, and after a host
 * that did not end cleanly, the safe-mode notice with it), which can replace an address set a moment before. So the
 * address is set again until the workspace's page is what shows (15 s).
 */
const open = async (cdp, id) => {
    const there = `window.location.hash.includes('workspace/${word(id)}') && Boolean(document.querySelector('[data-surface="workspace"]'))`;
    for (const end = Date.now() + 15_000; Date.now() < end;) {
        await cdp.evaluate(`window.location.hash = '#genie://workspace/${word(id)}'; true`);
        if (await waitFor(cdp, there, 1_000)) return true;
    }
    return false;
};
const stepFor = (id) => `document.querySelector('[data-trust-step="${word(id)}"]')`;
/*
 * Adding a folder is the window's call over its local door (the host split: genie-host keeps the workspaces). A call of
 * this run's own replaces the app's connection for its length, so the app's own Retry brings that back afterwards.
 */
const addAll = (cdp, paths) => cdp.evaluate(`(async () => {
    const door = window.genieLocalProtocol;
    if (!door) return JSON.stringify({ refused: 'no local door in this window' });
    const handle = 'trust_step_' + Date.now();
    const frames = [];
    door.onFrame((action, h, text) => { if (h !== handle || action !== 'frame') return; try { frames.push(JSON.parse(text)); } catch { /* not a frame of ours */ } });
    const wait = async (match) => {
        const end = Date.now() + 15000;
        while (Date.now() < end) { const found = frames.find(match); if (found) return found; await new Promise((r) => setTimeout(r, 25)); }
        throw new Error('the local door did not answer');
    };
    door.send('open', handle, '');
    door.send('frame', handle, JSON.stringify({ kind: 'hello', auth: { kind: 'local' }, label: 'trust step' }));
    const hello = await wait((f) => f.kind === 'welcome' || f.kind === 'refused');
    if (hello.kind !== 'welcome') return JSON.stringify([hello]);
    const out = [];
    let id = 1;
    for (const path of ${JSON.stringify(paths)}) {
        const n = id++;
        door.send('frame', handle, JSON.stringify({ kind: 'call', id: n, method: 'workspaces.confirmAdd', args: [path] }));
        out.push(await wait((f) => f.kind === 'result' && f.id === n));
    }
    door.send('close', handle, '');
    return JSON.stringify(out);
})()`);
/** The app's own connection, back through its own Retry (it was replaced by this run's call). */
const reconnect = async (cdp) => {
    const retry = `Array.from(document.querySelectorAll('[role="alert"] button')).find((b) => b.textContent.trim() === 'Retry')`;
    if (await waitFor(cdp, `Boolean(${retry})`, 15_000)) await cdp.evaluate(`${retry}.click(); true`);
    return waitFor(cdp, `Boolean(document.querySelector('[data-route]')) && !(${retry})`, 30_000);
};
/** The id the window's registry gives a folder: it reaches the window from the host, so it is waited for (10 s). */
const idOf = async (cdp, path) => {
    for (const end = Date.now() + 10_000; ;) {
        const id = await idOnce(cdp, path);
        if (id !== null || Date.now() > end) return id;
        await new Promise((r) => setTimeout(r, 200));
    }
};
const idOnce = async (cdp, path) => cdp.call('function (path) { return window.genie.snapshot().then((s) => s.workspaces.find((w) => w.path === path)?.id ?? null); }', path);

console.log('\nTHE TRUST STEP — what a person sees, in the real app\n');
const record = join(home, '.genie', 'runtime', 'workspace-trust.json');
const acme = workspaceFolder('acme', 'echo trust-step-probe');
const other = workspaceFolder('still-waiting', 'echo control-probe');

let app = launch();
let cdp = null;
try {
    cdp = await Cdp.connect();
    await cdp.evaluate('document.readyState');
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 60_000), '0. the app is up, on a home of its own');

    console.log(`  add: ${String(await addAll(cdp, [acme, other])).slice(0, 320)}`);
    check(await reconnect(cdp), '0b. the app has its own connection back');
    const acmeId = await idOf(cdp, acme);
    const otherId = await idOf(cdp, other);
    check(typeof acmeId === 'string' && typeof otherId === 'string', '1. two workspaces added', `${acmeId}, ${otherId}`);

    await open(cdp, acmeId);
    check(await waitFor(cdp, `Boolean(${stepFor(acmeId)})`), '2. the step is at the top of the workspace');
    check(await cdp.evaluate(`(${stepFor(acmeId)}?.textContent ?? '').includes('echo trust-step-probe')`), '3. it names what would run');
    check(await cdp.evaluate(`Boolean(document.querySelector('[data-trust-first]'))`), '4. it says it is not trusted yet');
    check(await cdp.evaluate(`document.querySelector('[data-surface="workspace"]').firstElementChild === ${stepFor(acmeId)}`), '5. it comes first on the page');

    // A YES THAT CANNOT BE SAVED: something is in the way of the record.
    rmSync(record, { force: true });
    mkdirSync(record, { recursive: true });
    writeFileSync(join(record, 'in-the-way'), 'x');
    await cdp.evaluate(`document.querySelector('[data-action="trust-workspace"]').click(); true`);
    const refused = await waitFor(cdp, `Boolean(${stepFor(acmeId)}?.querySelector('[role="alert"]'))`, 30_000);
    if (!refused) {
        // What the page and main say, on the way to a failure: the first thing wanted when this row goes red.
        const seen = await cdp.evaluate(`(window.genieTest ?? window.genie).features.snapshot().then((data) => JSON.stringify({ step: Boolean(${stepFor(acmeId)}), busy: Boolean(document.querySelector('[data-trust-busy]')), route: document.querySelector('[data-route]')?.textContent ?? null, steps: (data.trust ?? []).map((row) => row.workspaceId) }))`);
        console.log(`  at the failure: ${seen}; the record there now: ${existsSync(record) ? (readdirSync(record, { withFileTypes: false }).join(',') || 'an empty folder') : 'nothing'}`);
    }
    check(refused, '6. a yes that cannot be saved says why');
    check(await cdp.evaluate(`Boolean(document.querySelector('[data-action="trust-workspace-retry"]'))`), '7. and offers Retry');
    check(await cdp.evaluate(`Boolean(${stepFor(acmeId)})`), '8. and the workspace is still not trusted');

    // THE YES, WITH THE WAY CLEAR.
    rmSync(record, { recursive: true, force: true });
    await cdp.evaluate(`(() => {
        window.__trustBusy = false;
        new MutationObserver(() => { if (document.querySelector('[data-trust-busy]')) window.__trustBusy = true; }).observe(document.body, { childList: true, subtree: true });
        document.querySelector('[data-action="trust-workspace-retry"]').click();
        return true;
    })()`);
    check(await waitFor(cdp, `!${stepFor(acmeId)}`), '9. the step goes');
    check(await cdp.evaluate('window.__trustBusy === true'), '10. it showed progress on the way');
    check(existsSync(record), '11. the yes was saved', existsSync(record) ? readFileSync(record, 'utf8').slice(0, 120) : 'no record');

    await open(cdp, otherId);
    check(await waitFor(cdp, `Boolean(${stepFor(otherId)})`), '12. CONTROL: the workspace nobody trusted still has its step');
    cdp.close();
    cdp = null;
    await stop(app);

    app = launch();
    cdp = await Cdp.connect();
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 60_000), '13. relaunched');
    // The relaunch is against a NEW genie-host: the one before it is gone, and the record names another.
    const before = stopped.at(-1) ?? { host: null, gone: null };
    let after = hostPid();
    for (const end = Date.now() + 20_000; (after === null || after === before.host) && Date.now() < end;) { await sleep(200); after = hostPid(); }
    check(before.host !== null && before.gone === true && after !== null && after !== before.host, '13b. on a new genie-host (the old one stopped)', `${before.host} -> ${after}`);
    await open(cdp, otherId);
    const stillAsks = await waitFor(cdp, `Boolean(${stepFor(otherId)})`);
    if (!stillAsks) {
        // What the page and main say, on the way to a failure: the first thing wanted when this row goes red.
        const seen = await cdp.evaluate(`(window.genieTest ?? window.genie).features.snapshot().then((data) => JSON.stringify({ hash: window.location.hash, trust: (data?.trust ?? []).map((s) => s.workspaceId ?? s.id ?? '?'), surface: (document.querySelector('[data-surface]')?.getAttribute('data-surface') ?? 'none'), text: (document.body?.innerText ?? '').slice(0, 200) }))`);
        console.log(`  at the failure: ${String(seen).slice(0, 600)}`);
        // genie-host's own words: it keeps the verdicts, and a relaunch may have started a new one.
        const hostLog = join(home, '.genie', 'logs', 'genie-host.log');
        const lines = existsSync(hostLog) ? readFileSync(hostLog, 'utf8').split(/\r?\n/).filter((l) => /trust|host|ready|workspace/i.test(l)).slice(-25) : ['no host log at ' + hostLog];
        console.log(`  genie-host.log (filtered):\n    ${lines.map((l) => l.slice(0, 220)).join('\n    ')}`);
    }
    check(stillAsks, '14. CONTROL: after the relaunch that one still asks, so a missing step below means something');
    await open(cdp, acmeId);
    check(await waitFor(cdp, `document.querySelector('[data-surface="workspace"]')?.getAttribute('data-workspace') === '${word(acmeId)}'`), '15. the trusted workspace opens');
    // Long enough for a step that was coming to have come: the control above came in this run.
    await sleep(3000);
    check(await cdp.evaluate(`!${stepFor(acmeId)}`), '16. it reads trusted after a relaunch');
} catch (error) {
    check(false, 'the run did not finish', error instanceof Error ? error.message : String(error));
} finally {
    if (cdp) {
        try {
            const text = await cdp.evaluate(`document.querySelector('[data-surface]')?.innerText?.slice(0, 400) ?? '(no surface)'`);
            if (failures.length > 0) console.log(`  on screen: ${String(text).replace(/\s+/g, ' ')}`);
        } catch { /* the page has gone */ }
        cdp.close();
    }
    await stop(app);
    if (failures.length > 0 && existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
    if (failures.length > 0) {
        // Where the record really is: a home the app did not take would make the obstacle above stand in nothing's way.
        const found = [];
        const look = (dir, depth) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.name === 'workspace-trust.json') found.push(`${path}${entry.isDirectory() ? ' (folder)' : ''}`);
                if (entry.isDirectory() && depth < 5) look(path, depth + 1);
            }
        };
        try { look(home, 0); } catch (error) { console.log(`  could not look: ${String(error)}`); }
        console.log(`  the record: expected ${record}; found ${found.join(', ') || 'none under the home'}; os home in this script ${homedir()}`);
    }
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}

if (failures.length > 0) {
    console.log(`\nTRUST STEP FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nTRUST STEP OK');
process.exit(0);

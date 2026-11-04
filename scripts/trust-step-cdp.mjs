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
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
async function stop(app) {
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
    // The debugger port and the single-instance lock are free before the next launch.
    await sleep(2000);
}

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect() {
        const until = Date.now() + 90_000;
        let page = null;
        let last = 'no attempt';
        while (Date.now() < until && !page) {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
                page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
                last = `no page yet (${targets.length})`;
            } catch (error) { last = String(error); }
            if (!page) await sleep(500);
        }
        if (!page) throw new Error(`no window on the debugger port: ${last}`);
        const c = new Cdp();
        c.#ws = new WebSocket(page.webSocketDebuggerUrl);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (r) { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => {
            c.#ws.addEventListener('open', res, { once: true });
            c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true });
        });
        return c;
    }
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); });
    }
    async evaluate(expression) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
    execFileSync('git', ['init', '-q'], { cwd: folder, windowsHide: true, stdio: 'ignore' });
    return folder;
}
const open = (cdp, id) => cdp.evaluate(`window.location.hash = '#genie://workspace/' + ${JSON.stringify(id)}; true`);
const stepFor = (id) => `document.querySelector('[data-trust-step=' + ${JSON.stringify(JSON.stringify(id))} + ']')`;
const add = (cdp, path) => cdp.evaluate(`window.genie.workspaces.confirmAdd(${JSON.stringify(path)}).then((r) => JSON.stringify(r))`);
const idOf = async (cdp, path) => cdp.evaluate(`window.genie.snapshot().then((s) => s.workspaces.find((w) => w.path === ${JSON.stringify(path)})?.id ?? null)`);

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

    console.log(`  add: ${String(await add(cdp, acme)).slice(0, 160)}`);
    console.log(`  add: ${String(await add(cdp, other)).slice(0, 160)}`);
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
    check(await waitFor(cdp, `Boolean(${stepFor(acmeId)}?.querySelector('[role="alert"]'))`), '6. a yes that cannot be saved says why');
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
    await open(cdp, otherId);
    check(await waitFor(cdp, `Boolean(${stepFor(otherId)})`), '14. CONTROL: after the relaunch that one still asks, so a missing step below means something');
    await open(cdp, acmeId);
    check(await waitFor(cdp, `document.querySelector('[data-surface="workspace"]')?.getAttribute('data-workspace') === ${JSON.stringify(acmeId)}`), '15. the trusted workspace opens');
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
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}

if (failures.length > 0) {
    console.log(`\nTRUST STEP FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nTRUST STEP OK');
process.exit(0);

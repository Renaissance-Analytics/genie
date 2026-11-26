#!/usr/bin/env node
/**
 * WHERE THE FANCY DEV KIT SWITCH IS (genie#2129, shipped in beta.66; the owner could not find it): the real app on a home
 * of its own with the smoke seed's workspace and agent, photographed at 1050x720 and 1280x800 on (a) the agent's Settings tab, its
 * "MCP servers" section, and (b) the workspace's Settings, its MCP default. Beside each photograph it prints whether the
 * words "Fancy Dev Kit" are on the page, and the MCP section's text.
 *
 *   node scripts/mcp-shots-cdp.mjs     (a test VM only)
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew, seedWhatsNewSeen } from './cdp-whats-new.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { endOwnRun } from './end-own-tree.mjs';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.GENIE_TEST_MACHINE !== '1' && !['genie'].includes(process.env.USERNAME ?? process.env.USER ?? '')) {
    console.error('refusing: test machines only (GENIE_TEST_MACHINE=1)');
    process.exit(2);
}

const PORT = Number(process.env.MCP_SHOTS_CDP_PORT ?? 9362);
const PREFIX = process.env.SHOTS_PREFIX ?? 'shot';
const OUT = join('ci-out', 'toolchain-shots');
const RUN_BEGAN = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (line) => console.log(`  ${line}`);

// The page's full bridge as window.genieTest (preload.ts: --genie-page-probe), as the other *-cdp rows have it.
process.env.GENIE_PAGE_PROBE ??= '1';
const root = mkdtempSync(join(tmpdir(), 'mcp-shots-'));
const home = join(root, 'home');
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
seedWhatsNewSeen(join(home, '.genie'));
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
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'GENIE_HOME']) delete env[key];
const electron = createRequire(import.meta.url)('electron');

function launch() {
    const out = openSync(log, 'a');
    const args = ['.', `--remote-debugging-port=${PORT}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE ?? '')) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    return spawn(electron, args, { env, stdio: ['ignore', out, out], detached: process.platform !== 'win32', windowsHide: false });
}
function hostPid() {
    try {
        const raw = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'host.json'), 'utf8'));
        return typeof raw.pid === 'number' ? raw.pid : null;
    } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
async function stop(app) {
    const host = hostPid();
    const gone = new Promise((r) => { if (app.exitCode !== null) r(); else app.once('exit', r); });
    if (process.platform === 'win32') {
        const ended = await endOwnRun({ app, hostPid: host, since: RUN_BEGAN });
        if (!ended.ok) problems.push(`left running: ${ended.words}`);
    } else {
        try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ }
    }
    await Promise.race([gone, sleep(20_000)]);
    if (app.exitCode === null && process.platform !== 'win32') { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (host !== null && alive(host)) {
        try { process.kill(host, 'SIGTERM'); } catch { /* gone */ }
        for (const end = Date.now() + 15_000; alive(host) && Date.now() < end;) await sleep(100);
        if (alive(host)) { try { process.kill(host, 'SIGKILL'); } catch { /* gone */ } }
    }
}

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect() {
        const until = Date.now() + 90_000;
        let page = null;
        let last = 'no attempt';
        while (Date.now() < until && !page) {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
                page = mainWindow(targets);
                last = `no page yet (${targets.length})`;
            } catch (error) { last = String(error); }
            if (!page) await sleep(500);
        }
        if (!page) throw new Error(`no window on the debugger port: ${last}`);
        const c = new Cdp();
        c.#ws = new WebSocket(page.webSocketDebuggerUrl);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('the debugger socket did not open within 15 s')), 15_000);
            c.#ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
            c.#ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP socket error')); }, { once: true });
        });
        return c;
    }
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r, rej) => {
            const timer = setTimeout(() => { this.#pending.delete(id); rej(new Error(`no answer to ${method} within 120 s`)); }, 120_000);
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
    close() { this.#ws.close(); }
}
async function waitFor(cdp, expression, ms = 30_000, every = 250) {
    for (const until = Date.now() + ms; Date.now() < until;) {
        if (await cdp.evaluate(expression)) return true;
        await sleep(every);
    }
    return false;
}
/** A real mouse click on what the selector finds, scrolled into view first; false when the mouse would not reach it. */
async function click(cdp, selector) {
    await closeWhatsNew((expression) => cdp.evaluate(expression));
    const at = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, reaches: Boolean(hit && (hit === el || el.contains(hit))), under: hit ? hit.outerHTML.slice(0, 120) : null };
    })()`);
    if (!at) { note(`no ${selector} on the page`); return false; }
    if (!at.reaches) { note(`the mouse at ${selector} would reach: ${at.under}`); return false; }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return true;
}



const workspace = join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15000, windowsHide: true });
const AGENT = `agent_${'a1b2c3d4'.repeat(4)}`;
let app = launch();
let cdp = null;
let shots = 0;
try {
    cdp = await Cdp.connect();
    if (!(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 90_000))) throw new Error('the app did not come up');
    // Each page at the owner's window (1050x720, the chat open) and at 1280x800, as it opens: nothing scrolled.
    for (const [w, h] of [[1050, 720], [1280, 800]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        for (const [name, hash] of [['mcp-agent', `#genie://agent/${AGENT}?tab=settings`], ['mcp-workspace', '#genie://workspace/tynn?view=settings']]) {
            await closeWhatsNew((expression) => cdp.evaluate(expression));
            await cdp.evaluate(`window.location.hash = ${JSON.stringify(hash)}; true`);
            await sleep(4000);
            if (name === 'mcp-agent') {
                note(`tabs: ${await cdp.evaluate(`[...document.querySelectorAll('[data-settings-tab]')].map((t) => t.getAttribute('data-settings-tab') + '=' + t.textContent.trim()).join(' ')`)}`);
                // Its own "MCP servers" tab (Tynn #1062); before it, the switches were on the "Skills" tab.
                const tab = (await cdp.evaluate(`Boolean(document.querySelector('[data-settings-tab="mcp"]'))`)) ? 'mcp' : 'skills';
                if (await waitFor(cdp, `Boolean(document.querySelector('[data-settings-tab="${tab}"]'))`, 15_000, 500)) await click(cdp, `[data-settings-tab="${tab}"]`);
                await sleep(1500);
            }
            await waitFor(cdp, `/Fancy Dev Kit/.test(document.body.innerText)`, 20_000, 500);
            await cdp.evaluate(`(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop) el.scrollTop = 0; } return true; })()`);
            await sleep(800);
            const seen = await cdp.evaluate(`JSON.stringify((() => {
                const row = document.querySelector('[data-mcp-server="fancy-ui"]');
                const r = row?.getBoundingClientRect();
                return { route: location.hash, fancyRow: Boolean(row), fancyVisibleWithoutScrolling: Boolean(r && r.top >= 0 && r.bottom <= innerHeight && r.width > 0), at: r ? [Math.round(r.left), Math.round(r.top)] : null };
            })())`);
            note(`MCP ${name} ${w}x${h} ${seen}`);
            const file = `${PREFIX}-${name}-${w}x${h}.png`;
            const shotData = await cdp.send('Page.captureScreenshot', { format: 'png' });
            if (shotData.result?.data) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, file), Buffer.from(shotData.result.data, 'base64')); note(`screenshot: ${join(OUT, file)}`); shots++; }
        }
    }
} catch (error) {
    problems.push(`the run did not finish: ${error instanceof Error ? error.message : String(error)}`);
} finally {
    if (cdp) cdp.close();
    await stop(app);
    if (problems.length > 0 && existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}
console.log(`### mcp-shots ${shots === 4 ? 'DONE' : 'INCOMPLETE'} ${shots} photographs${problems.length ? `; ${problems.join('; ')}` : ''}`);
process.exit(shots === 4 ? 0 : 1);

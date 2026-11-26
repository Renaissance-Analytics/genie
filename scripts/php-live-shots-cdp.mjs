#!/usr/bin/env node
/**
 * PHP STAYS ON THE NEWEST PATCH OF ITS LINE, AS IT LOOKS (Tynn #1066). The real app on a home of its own, on a test VM
 * (never the owner's desktop), with a Genie-managed PHP 8.4.27 on disk — the PHP2Shell fix this Genie release bakes in.
 * php.net has released newer 8.4 security patches since; with no Genie update:
 *
 *   1. BEFORE: Settings → Toolchain → PHP lists 8.4.27 marked as missing a php.net security release, with the newest 8.4
 *      patch (from php.net's LIVE data) on its patch button;
 *   2. Genie's own pass (a minute after start) installs that patch BY ITSELF, real download, checksum-verified;
 *   3. AFTER: the panel lists the new patch, and the Deck says what Genie installed.
 *
 *   node scripts/php-live-shots-cdp.mjs      (Windows test VM: GENIE_TEST_MACHINE=1)
 *
 * PNGs go to ci-out/php-live-shots/<os>-<w>x<h>-<before|after|deck>.png, with what each shows measured beside it.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew, seedWhatsNewSeen } from './cdp-whats-new.mjs';
import { spawn } from 'node:child_process';
import { endOwnRun } from './end-own-tree.mjs';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.GENIE_TEST_MACHINE !== '1' && !['genie'].includes(process.env.USERNAME ?? process.env.USER ?? '')) {
    console.error('refusing: this installs PHP; test machines only (GENIE_TEST_MACHINE=1)');
    process.exit(2);
}

const PORT = Number(process.env.PHP_SHOTS_CDP_PORT ?? 9362);
const OS = process.platform === 'win32' ? 'windows' : 'linux';
const OUT = join('ci-out', 'php-live-shots');
const RUN_BEGAN = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (line) => console.log(`  ${line}`);

const root = mkdtempSync(join(tmpdir(), 'php-live-shots-'));
const home = join(root, 'home');
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
seedWhatsNewSeen(join(home, '.genie'));
// A managed PHP 8.4.27 as Genie lists one: its directory with a php-cgi in it (listing runs nothing from it).
const old = join(home, '.genie', 'genie2-toolchain', 'php-versions', '8.4.27');
mkdirSync(old, { recursive: true });
writeFileSync(join(old, OS === 'windows' ? 'php-cgi.exe' : 'php-cgi'), '');
const log = join(root, 'electron.log');
const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
};
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'GENIE_HOME']) delete env[key];
const electron = createRequire(import.meta.url)('electron');

function launch() {
    const out = openSync(log, 'a');
    const args = ['.', `--remote-debugging-port=${PORT}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
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
    if (!at.reaches) {
        // Off the visible part of a scrolled container (the cramped Toolchain on this base, Tynn #1062): a DOM click.
        note(`the mouse at ${selector} would reach: ${at.under}; clicking it in the page instead`);
        return cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return true;
}
const PANEL = `[data-toolchain-panel="php"]`;
/** What the PHP panel shows, as data: the versions listed, each one's advisory, the patch buttons, what can be installed. */
const MEASURE = `JSON.stringify((() => {
    const panel = document.querySelector('${PANEL}');
    if (!panel) return { panel: false };
    const versions = [...panel.querySelectorAll('[data-php-version]')].map((li) => ({ version: li.getAttribute('data-php-version'), text: li.innerText.replace(/\\s+/g, ' ').slice(0, 300) }));
    const patches = [...panel.querySelectorAll('[data-patch-update]')].map((b) => b.getAttribute('data-patch-update') + ' -> ' + b.getAttribute('data-version'));
    const installs = [...panel.querySelectorAll('[data-php-install]')].map((b) => b.getAttribute('data-php-install'));
    return { panel: true, versions, patches, installs };
})())`;
async function shot(cdp, name) {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!s.result?.data) { problems.push(`no screenshot for ${name}`); return; }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64'));
    note(`screenshot: ${join(OUT, name)}`);
}
async function openPhpPanel(cdp) {
    await cdp.evaluate(`window.location.hash = '#genie://settings/toolchain'; true`);
    if (!(await waitFor(cdp, `Boolean(document.querySelector('[data-surface="toolchain"] [data-tool-card="php"]'))`, 180_000, 1000))) throw new Error('the Toolchain never drew its PHP card');
    if (!(await cdp.evaluate(`Boolean(document.querySelector('${PANEL}'))`))) await click(cdp, `[data-select-tool="php"]`);
    if (!(await waitFor(cdp, `Boolean(document.querySelector('${PANEL}'))`, 15_000))) throw new Error('the PHP panel did not open');
    await cdp.evaluate(`document.querySelector('${PANEL}')?.scrollIntoView({ block: 'start' }); true`);
}
async function shootAt(cdp, label, sizes) {
    for (const [w, h] of sizes) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(1000);
        await openPhpPanel(cdp);
        await sleep(600);
        note(`MEASURE ${label} ${w}x${h} ${await cdp.evaluate(MEASURE)}`);
        await shot(cdp, `${OS}-${w}x${h}-${label}.png`);
    }
}

const SIZES = [[1600, 900], [1280, 800]];
let app = launch();
let cdp = null;
let shots = 0;
try {
    cdp = await Cdp.connect();
    if (!(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 90_000))) throw new Error('the app did not come up');
    for (let i = 0; i < 3 && (await cdp.evaluate(`Boolean(document.querySelector('[aria-modal="true"]'))`)); i++) {
        for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(500);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await openPhpPanel(cdp);
    // BEFORE: php.net's live data reached the panel (a patch above 8.4.27 on its button), and nothing installed yet.
    const offered = await waitFor(cdp, `Boolean(document.querySelector('${PANEL} [data-patch-update="php:8.4.27"]'))`, 45_000, 1000);
    if (!offered) problems.push('no live patch button on 8.4.27 within 45 s');
    const target = await cdp.evaluate(`document.querySelector('${PANEL} [data-patch-update="php:8.4.27"]')?.getAttribute('data-version') ?? null`);
    note(`the live patch for 8.4.27: ${target}`);
    await shootAt(cdp, 'before', SIZES);
    shots += SIZES.length;

    // Genie's own pass installs it by itself (a minute after start, then the download and its checksum).
    const installed = target !== null && (await waitFor(cdp, `(() => { const p = document.querySelector('${PANEL}'); if (!p) { document.querySelector('[data-select-tool="php"]')?.click(); return false; } return Boolean(p.querySelector('[data-php-version=${JSON.stringify(String(target))}]')); })()`, 10 * 60_000, 3000));
    if (!installed) problems.push(`PHP ${target} was not installed by itself within 10 min`);
    note(installed ? `PHP ${target} installed by itself` : 'not installed');
    await shootAt(cdp, 'after', SIZES);
    shots += SIZES.length;

    // THE DECK: what the person is told.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`window.location.hash = '#genie://dashboard'; true`);
    await sleep(2500);
    const deck = await cdp.evaluate(`(document.body.innerText.match(/PHP [0-9.]+ installed: a security release[^\\n]*\\n?[^\\n]*/) ?? [null])[0]`);
    note(`Deck text: ${deck}`);
    if (!deck) problems.push('the Deck does not show the PHP security update');
    await shot(cdp, `${OS}-1280x800-deck.png`);
    shots++;
} catch (error) {
    problems.push(`the run did not finish: ${error instanceof Error ? error.message : String(error)}`);
    try { if (cdp) await shot(cdp, `${OS}-error.png`); } catch { /* gone */ }
} finally {
    if (cdp) cdp.close();
    await stop(app);
    const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
    for (const line of logText.split(/\r?\n/).filter((l) => /php (updates|releases)/.test(l))) note(`log: ${line}`);
    if (problems.length > 0) console.log(logText.slice(-2000));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}
const want = SIZES.length * 2 + 1;
console.log(`### php-live-shots ${shots === want && problems.length === 0 ? 'DONE' : 'INCOMPLETE'} ${shots} photographs${problems.length ? `; ${problems.join('; ')}` : ''}`);
process.exit(shots === want && problems.length === 0 ? 0 : 1);

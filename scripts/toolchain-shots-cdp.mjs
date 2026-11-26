#!/usr/bin/env node
/**
 * THE TOOLCHAIN, AS IT LOOKS (Tynn #1062; the owner, 2026-11-26: "ALWAYS get visual proof ... the toolchain is barely
 * useable"). The real app on a home of its own, Settings → Toolchain, photographed at the window sizes people use:
 * 1050x720 (the owner's window, the chat open beside it), 1280x800 and 1600x900, each with a tool's panel open and closed.
 *
 *   node scripts/toolchain-shots-cdp.mjs           (a test VM only: it installs a Genie-managed language)
 *
 * Before the photographs it makes the state the owner's screenshot had: a Genie-managed language installed and made the
 * default (PHP on Windows, Node on Linux; TOOLCHAIN_SHOTS_INSTALL names another), and on Windows "Genie's defaults in
 * every terminal" turned on. PNGs go to ci-out/toolchain-shots/<SHOTS_PREFIX>-<os>-<w>x<h>-<panel|grid>.png.
 *
 * Beside each photograph it MEASURES what the owner complained of, so a layout claim is a number, not an eyeball:
 *   - how many "Toolchain" titles are on screen;
 *   - the card grid's width and the panel's (and whether they sit side by side);
 *   - every element whose text is cut off (scrollWidth > clientWidth with an ellipsis);
 *   - any visible text holding the home folder.
 * It exits 0 when it photographed every size; the judgement of the pictures is a person's.
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
    console.error('refusing: this installs a language and changes the user PATH; test machines only (GENIE_TEST_MACHINE=1)');
    process.exit(2);
}

const PORT = Number(process.env.TOOLCHAIN_SHOTS_CDP_PORT ?? 9361);
const PREFIX = process.env.SHOTS_PREFIX ?? 'shot';
const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const INSTALL = process.env.TOOLCHAIN_SHOTS_INSTALL ?? (OS === 'windows' ? 'php' : 'node');
const SIZES = [[1050, 720], [1280, 800], [1600, 900]];
const OUT = join('ci-out', 'toolchain-shots');
const RUN_BEGAN = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (line) => console.log(`  ${line}`);

// The page's full bridge as window.genieTest (preload.ts: --genie-page-probe), as the other *-cdp rows have it.
process.env.GENIE_PAGE_PROBE ??= '1';
const root = mkdtempSync(join(tmpdir(), 'toolchain-shots-'));
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
/** Every scroll container back at its top, so each photograph starts where a person lands. */
const TO_TOP = `(() => { for (const el of document.querySelectorAll('[data-surface="toolchain"], [data-surface="toolchain"] *, [data-settings-page], [data-settings-page] *')) { if (el.scrollTop) el.scrollTop = 0; if (el.scrollLeft) el.scrollLeft = 0; } return true; })()`;
const MEASURE = (homeDir) => `JSON.stringify((() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
    const surface = document.querySelector('[data-surface="toolchain"]');
    const titles = [...document.querySelectorAll('h1, h2, h3')].filter((h) => visible(h) && h.textContent.trim() === 'Toolchain').length;
    const grid = surface?.querySelector('[data-card-group]')?.parentElement ?? null;
    const panel = surface?.querySelector('[data-toolchain-panel]') ?? null;
    const truncated = [];
    for (const el of surface ? surface.querySelectorAll('*') : []) {
        if (!visible(el) || el.children.length > 0) continue;
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis') truncated.push(el.textContent.trim().slice(0, 80));
    }
    const text = surface?.innerText ?? '';
    const homeShown = ${JSON.stringify(homeDir)}.length > 0 && text.toLowerCase().includes(${JSON.stringify(homeDir.toLowerCase())});
    const chat = document.querySelector('[data-dock-frame="chat"]');
    return { viewport: [innerWidth, innerHeight], titles, surface: box(surface), grid: box(grid), panel: box(panel), chat: box(chat), truncated, homeShown };
})())`;
async function shot(cdp, name) {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!s.result?.data) { problems.push(`no screenshot for ${name}`); return; }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64'));
    note(`screenshot: ${join(OUT, name)}`);
}
async function measureAndShoot(cdp, name) {
    await cdp.evaluate(TO_TOP);
    await sleep(700);
    const seen = JSON.parse(await cdp.evaluate(MEASURE(home)));
    note(`MEASURE ${name} ${JSON.stringify(seen)}`);
    await shot(cdp, name);
}

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
    await cdp.evaluate(`window.location.hash = '#genie://settings/toolchain'; true`);
    if (!(await waitFor(cdp, `Boolean(document.querySelector('[data-surface="toolchain"] [data-tool-card]'))`, 180_000, 1000))) throw new Error('the Toolchain never drew its cards');
    note(`cards: ${await cdp.evaluate(`[...document.querySelectorAll('[data-tool-card]')].map((c) => c.getAttribute('data-tool-card') + ':' + c.getAttribute('data-card-state')).join(' ')`)}`);

    // THE OWNER'S STATE: a Genie-managed language, its default; on Windows, Genie's defaults in every terminal.
    const card = `[data-tool-card=${JSON.stringify(INSTALL)}]`;
    // Through the action the card's button sends (the photographs need the state, not a test of the click; the 2026-11-26
    // BEFORE run's click left PHP uninstalled with nothing said). The outcome and any refusal are printed.
    const version = await cdp.evaluate(`document.querySelector('${card} [data-card-primary="install"]')?.getAttribute('data-version') ?? null`);
    const kind = { php: 'toolchain.installPhp', node: 'toolchain.installNode', python: 'toolchain.installPython', go: 'toolchain.installGo' }[INSTALL];
    if (version && kind) {
        note(`installing ${INSTALL} ${version}`);
        const outcome = await cdp.evaluate(`(window.genieTest ?? window.genie).features.act(${JSON.stringify({ kind, version, consent: true })}).then((r) => JSON.stringify(r ?? null)).catch((e) => 'threw: ' + String(e))`);
        note(`install answered: ${String(outcome).slice(0, 300)}`);
        const done = await waitFor(cdp, `(() => { const c = document.querySelector('${card}'); return Boolean(c && !c.querySelector('[data-card-progress]') && c.getAttribute('data-card-state') !== 'missing' && !c.querySelector('[data-card-primary="install"]')); })()`, 420_000, 2000);
        const refusals = await cdp.evaluate(`(window.genieTest ?? window.genie).features.snapshot().then((d) => JSON.stringify({ refusals: d?.toolchain?.refusals ?? [], result: d?.toolchain?.result ?? null, defaults: d?.toolchain?.defaults ?? null }))`);
        note(`${INSTALL} ${done ? 'installed' : 'NOT installed in 7 min'}: ${String(refusals).slice(0, 400)}`);
        if (!done) problems.push(`${INSTALL} install did not finish`);
        // Made the default, as the owner's PHP was.
        const lang = INSTALL;
        await cdp.evaluate(`(window.genieTest ?? window.genie).features.act(${JSON.stringify({ kind: 'toolchain.setDefault', lang, version })}).then(() => true).catch(() => false)`);
    } else {
        note(`no install offered on the ${INSTALL} card: ${await cdp.evaluate(`document.querySelector('${card}')?.innerText.replace(/\\s+/g, ' ') ?? 'no card'`)}`);
    }
    if (OS === 'windows' && (await cdp.evaluate(`Boolean(document.querySelector('[data-machine-path-apply]'))`))) {
        if (await click(cdp, '[data-machine-path-apply]')) {
            const on = await waitFor(cdp, `Boolean(document.querySelector('[data-machine-path="on"]'))`, 60_000, 1000);
            note(on ? "Genie's defaults are on in every terminal" : 'the machine PATH did not turn on in 60 s');
        }
    }
    await sleep(2000);

    for (const [w, h] of SIZES) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await sleep(1200);
        // The panel CLOSED, then OPEN on the language installed above.
        if (await cdp.evaluate(`Boolean(document.querySelector('[data-toolchain-panel]'))`)) {
            const closer = (await cdp.evaluate(`Boolean(document.querySelector('[data-panel-close]'))`)) ? '[data-panel-close]' : '[data-toolchain-panel] [aria-label="Close"]';
            await click(cdp, closer);
            await sleep(800);
        }
        const closed = !(await cdp.evaluate(`Boolean(document.querySelector('[data-toolchain-panel]'))`));
        if (!closed) note('the panel does not close: the "grid" photograph has it open');
        await measureAndShoot(cdp, `${PREFIX}-${OS}-${w}x${h}-grid.png`);
        shots++;
        if (await click(cdp, `[data-select-tool=${JSON.stringify(INSTALL)}]`)) {
            await waitFor(cdp, `Boolean(document.querySelector('[data-toolchain-panel=${JSON.stringify(INSTALL)}]'))`, 10_000);
        }
        await measureAndShoot(cdp, `${PREFIX}-${OS}-${w}x${h}-panel.png`);
        shots++;
    }
} catch (error) {
    problems.push(`the run did not finish: ${error instanceof Error ? error.message : String(error)}`);
    try { if (cdp) await shot(cdp, `${PREFIX}-${OS}-error.png`); } catch { /* gone */ }
} finally {
    if (cdp) cdp.close();
    await stop(app);
    if (problems.length > 0 && existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}
console.log(`### toolchain-shots ${shots === SIZES.length * 2 ? 'DONE' : 'INCOMPLETE'} ${shots} photographs${problems.length ? `; ${problems.join('; ')}` : ''}`);
process.exit(shots === SIZES.length * 2 ? 0 : 1);

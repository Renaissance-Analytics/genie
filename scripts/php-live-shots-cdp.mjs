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
 *
 * `--card`: A FRESH MACHINE (beta.66 on a fresh Windows VM could install NO PHP from the card: 8.5.12, 8.4.27, 8.3.36 and
 * 8.2.35 were all archived builds with no published checksum). No PHP on disk; the PHP card's Install, then the panel's
 * Install for every other supported line, each a real windows.php.net download checked against its published sha256 —
 * photographed after each, to ci-out/php-live-shots/<os>-card-<n>-<version>.png.
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
const CARD = process.argv.includes('--card');
if (!CARD) {
    // A managed PHP 8.4.27 as Genie lists one: its directory with a php-cgi in it (listing runs nothing from it).
    const old = join(home, '.genie', 'genie2-toolchain', 'php-versions', '8.4.27');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, OS === 'windows' ? 'php-cgi.exe' : 'php-cgi'), '');
    // A workspace with an agent, so the Dashboard is the Deck (an empty machine shows its first steps instead).
    const ws = join(root, 'shop');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'project.json'), JSON.stringify({ name: 'shop', repos: [] }));
    const runtime = join(home, '.genie', 'runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify([{ id: 'shop', path: ws }]));
    const at = new Date().toISOString();
    writeFileSync(join(runtime, 'agents.json'), JSON.stringify([{ id: `agent_${'c3d4e5f6'.repeat(4)}`, workspaceId: 'shop', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: at, lastUsedAt: null, mode: 'manual', accessScope: 'none' }]));
}
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

/**
 * A FRESH MACHINE, FROM THE CARD (`--card`): the PHP card's Install, then the panel's Install for each line still not
 * installed (its select offers the newest not-installed first), until every line php.net supports is installed. Each
 * is judged by the panel listing it, and photographed. Returns the photographs taken.
 */
let cardWant = 1;
async function cardRun(cdp) {
    let taken = 0;
    await cdp.evaluate(`window.location.hash = '#genie://settings/toolchain'; true`);
    if (!(await waitFor(cdp, `Boolean(document.querySelector('[data-surface="toolchain"] [data-tool-card="php"]'))`, 180_000, 1000))) throw new Error('the Toolchain never drew its PHP card');
    const primary = `[data-tool-card="php"] [data-card-primary="install"]`;
    if (!(await waitFor(cdp, `Boolean(document.querySelector('${primary}'))`, 45_000, 1000))) throw new Error('the PHP card offers no Install');
    const first = await cdp.evaluate(`document.querySelector('${primary}').getAttribute('data-version')`);
    note(`the card offers: ${await cdp.evaluate(`document.querySelector('${primary}').innerText`)} (${first})`);
    await shot(cdp, `${OS}-card-0-fresh.png`);
    taken++;
    const asked = [];
    let next = first;
    for (let n = 1; next && n <= 8; n++) {
        asked.push(next);
        if (n === 1) await click(cdp, primary);
        else await click(cdp, `${PANEL} [data-php-install=${JSON.stringify(next)}]`);
        note(`installing PHP ${next} (${n === 1 ? 'the card' : 'the panel'})`);
        const ok = await waitFor(cdp, `(() => { if (!document.querySelector('${PANEL}')) document.querySelector('[data-select-tool="php"]')?.click(); return Boolean(document.querySelector('${PANEL} [data-php-version=${JSON.stringify(next)}]')); })()`, 8 * 60_000, 3000);
        const refusal = await cdp.evaluate(`(document.querySelector('${PANEL}')?.innerText.match(/[^\\n]*(could not|will not|refus|no published checksum)[^\\n]*/i) ?? [null])[0]`);
        note(ok ? `PHP ${next} installed` : `PHP ${next} NOT installed${refusal ? `: ${refusal}` : ''}`);
        // A line offered LAST because this machine's Visual C++ runtime is too old for it (8.6, vs18) is reported, not a
        // failure of the card: every line that runs here was offered and installed before it.
        const runtimeBound = !ok && n > 1 && /Visual C\+\+ runtime/.test(refusal ?? '');
        if (!ok && !runtimeBound) problems.push(`PHP ${next} did not install from ${n === 1 ? 'the card' : 'the panel'}${refusal ? `: ${refusal}` : ''}`);
        if (runtimeBound) note(`PHP ${next} needs a newer Visual C++ runtime than this machine has; it was offered after every line that runs here`);
        await openPhpPanel(cdp);
        await sleep(800);
        note(`MEASURE card-${n} ${await cdp.evaluate(MEASURE)}`);
        await shot(cdp, `${OS}-card-${n}-${next}.png`);
        taken++;
        // The refusal's own button (Tynn #1066): "Install it (asks for administrator)" runs Microsoft's signed
        // redistributable, then that PHP. Clicked, and what came of it photographed.
        if (runtimeBound && (await cdp.evaluate(`Boolean(document.querySelector('${PANEL} [data-refusal-vcruntime]'))`))) {
            note(`the refusal shows: ${await cdp.evaluate(`document.querySelector('${PANEL} [data-refusal-vcruntime]').parentElement.innerText.split('\\n')[0]`)}`);
            await click(cdp, `${PANEL} [data-refusal-vcruntime]`);
            const done = await waitFor(cdp, `(() => { const p = document.querySelector('${PANEL}'); if (!p) return false; return Boolean(p.querySelector('[data-php-version=${JSON.stringify(next)}]')) || (!p.querySelector('[data-refusal-vcruntime]') ? false : !document.querySelector('[data-toolchain-busy]') && /restart|declined|exited/i.test(p.innerText)); })()`, 10 * 60_000, 3000);
            const result = await cdp.evaluate(`Boolean(document.querySelector('${PANEL} [data-php-version=${JSON.stringify(next)}]')) ? 'installed' : (document.querySelector('${PANEL}')?.innerText.match(/[^\\n]*(restart|declined|exited)[^\\n]*/i) ?? ['no answer'])[0]`);
            note(`after "Install it (asks for administrator)": PHP ${next} ${result}${done ? '' : ' (no answer within 10 min)'}`);
            await openPhpPanel(cdp);
            await sleep(800);
            await shot(cdp, `${OS}-card-${n}-${next}-after-runtime.png`);
            taken++;
        }
        if (!ok) break;
        const offered = await cdp.evaluate(`document.querySelector('${PANEL} [data-php-install]')?.getAttribute('data-php-install') ?? null`);
        next = offered && !asked.includes(offered) ? offered : null;
    }
    const lines = new Set(asked.map((v) => v.split('.').slice(0, 2).join('.')));
    note(`installed from the card and the panel: ${asked.join(', ')} — lines ${[...lines].join(', ')}`);
    if (lines.size < 4) problems.push(`only ${lines.size} PHP lines were installed (${asked.join(', ')}); php.net supports at least 8.2–8.5`);
    cardWant = taken;
    return taken;
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
    if (CARD) {
        shots += await cardRun(cdp);
    } else {
    await openPhpPanel(cdp);
    // BEFORE: php.net's live data reached the panel (a patch above 8.4.27 on its button), and nothing installed yet.
    const offered = await waitFor(cdp, `Boolean(document.querySelector('${PANEL} [data-patch-update="php:8.4.27"]'))`, 45_000, 1000);
    if (!offered) problems.push('no live patch button on 8.4.27 within 45 s');
    const target = await cdp.evaluate(`document.querySelector('${PANEL} [data-patch-update="php:8.4.27"]')?.getAttribute('data-version') ?? null`);
    note(`the live patch for 8.4.27: ${target}`);
    await shootAt(cdp, 'before', SIZES);
    shots += SIZES.length;

    // Genie's own pass installs it by itself (a minute after start, then the download and its checksum).
    // Any 8.4 newer than 8.4.27 listed as installed: the panel is pushed the new list (no click, no re-scan).
    const NEWER = `([...(document.querySelector('${PANEL}')?.querySelectorAll('[data-php-version]') ?? [])].map((li) => li.getAttribute('data-php-version')).find((v) => /^8[.]4[.]/.test(v) && Number(v.split('.')[2]) > 27) ?? null)`;
    const installed = await waitFor(cdp, `(() => { if (!document.querySelector('${PANEL}')) { document.querySelector('[data-select-tool="php"]')?.click(); return false; } return ${NEWER} !== null; })()`, 10 * 60_000, 3000);
    const got = installed ? await cdp.evaluate(NEWER) : null;
    if (!installed) problems.push(`no newer PHP 8.4 was installed by itself within 10 min (the patch button offered ${target})`);
    else if (target !== null && got !== target) problems.push(`the panel offered ${target} and Genie installed ${got}`);
    note(installed ? `PHP ${got} installed by itself` : 'not installed');
    await shootAt(cdp, 'after', SIZES);
    shots += SIZES.length;

    // THE DECK: what the person is told.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate(`window.location.hash = '#genie://dashboard'; true`);
    // The Genie row (items that belong to no agent) and its badge, opened to show the item.
    if (await waitFor(cdp, `Boolean(document.querySelector('[data-waiting-genie] [data-waiting-badge]'))`, 60_000, 1000)) {
        if (!(await cdp.evaluate(`Boolean(document.querySelector('[data-waiting-items="genie:"]'))`))) await click(cdp, '[data-waiting-genie] [data-waiting-badge]');
    } else note('no Genie row on the Dashboard');
    await waitFor(cdp, `/PHP [0-9.]+ installed: a security release/.test(document.body.innerText)`, 15_000, 1000);
    const deck = await cdp.evaluate(`(document.body.innerText.match(/PHP [0-9.]+ installed: a security release[^\\n]*\\n?[^\\n]*/) ?? [null])[0]`);
    note(`Deck text: ${deck}`);
    if (!deck) problems.push('the Deck does not show the PHP security update');
    await shot(cdp, `${OS}-1280x800-deck.png`);
    shots++;
    }
} catch (error) {
    problems.push(`the run did not finish: ${error instanceof Error ? error.message : String(error)}`);
    try { if (cdp) await shot(cdp, `${OS}-error.png`); } catch { /* gone */ }
} finally {
    if (cdp) cdp.close();
    await stop(app);
    const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
    // What Genie's host said about it: its lifecycle log, on this run's own home.
    const life = join(home, '.genie', 'runtime', 'lifecycle.log');
    const lifeText = existsSync(life) ? readFileSync(life, 'utf8') : '';
    for (const line of [...logText.split(/\r?\n/), ...lifeText.split(/\r?\n/)].filter((l) => /php (updates|releases)/.test(l))) note(`log: ${line}`);
    if (problems.length > 0) console.log(logText.slice(-2000));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}
const want = CARD ? cardWant : SIZES.length * 2 + 1;
console.log(`### php-live-shots ${shots === want && problems.length === 0 ? 'DONE' : 'INCOMPLETE'} ${shots} photographs${problems.length ? `; ${problems.join('; ')}` : ''}`);
process.exit(shots === want && problems.length === 0 ? 0 : 1);

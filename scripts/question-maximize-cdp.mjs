#!/usr/bin/env node
/**
 * THE WHOLE QUESTION MAXIMIZED, AS A PERSON SEES IT, in the real app (Tynn #1019; the owner: "make sure that FTQ windows
 * can be maximized, not just image previews in it").
 *
 *   node scripts/question-maximize-cdp.mjs            (Linux: under xvfb-run)
 *
 * It starts the app itself, with a home folder and a debugger port of its own. Run on CI and the test VMs, never on a
 * desktop.
 *
 *   A question is asked (reported as another machine's, through the main window's preload: the one way a script can put a
 *   question in the real question window without a running agent; maximize is the window's own call to main, the same
 *   for every question) → the question window opens at its normal size → a mouse click on the header's Maximize grows
 *   the WINDOW to the display's work area, the form leaving its reading column → Esc restores it to the size it had, and
 *   is not Later (the question is still shown) → Maximize again, and the same button restores it. Screenshots of the
 *   window at both sizes.
 */
import { isGeniePage, mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew } from './cdp-whats-new.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GENIE_PAGE_PROBE ??= '1';

const PORT = Number(process.env.QUESTION_MAXIMIZE_CDP_PORT ?? 9354);
const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), 'question-maximize-'));
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
/** genie-host is detached and outlives the window: this run's host is stopped by the pid in its own record, never a pattern. */
async function stopHost(pid) {
    if (pid === null || !alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* it has gone */ }
    for (const end = Date.now() + 15_000; alive(pid) && Date.now() < end;) await sleep(100);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* it has gone */ } }
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
    if (app.exitCode === null && process.platform !== 'win32') { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* it has gone */ } }
    await stopHost(host);
}

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();

class Cdp {
    #ws; #id = 1; #pending = new Map();
    /** The first target `pick` finds on the debugger port within `ms`. */
    static async connect(pick, what, ms = 90_000) {
        const until = Date.now() + ms;
        let page = null;
        let last = 'no attempt';
        while (Date.now() < until && !page) {
            try {
                const list = await targets();
                page = pick(list);
                last = `not there yet (${list.length} targets: ${list.map((t) => t.url).join(', ')})`;
            } catch (error) { last = String(error); }
            if (!page) await sleep(500);
        }
        if (!page) throw new Error(`no ${what} on the debugger port: ${last}`);
        const c = new Cdp();
        c.#ws = new WebSocket(page.webSocketDebuggerUrl);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`the ${what}'s debugger socket did not open within 15 s`)), 15_000);
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
async function waitFor(cdp, expression, ms = 30_000) {
    for (const until = Date.now() + ms; Date.now() < until;) {
        if (await cdp.evaluate(expression)) return true;
        await sleep(200);
    }
    return false;
}
/** A real click, as a person's: the mouse pressed and released at the middle of what the selector finds, refused unless the mouse there reaches it. */
async function click(cdp, selector) {
    const at = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, rect: [r.left, r.top, r.width, r.height].map(Math.round), reaches: Boolean(hit && (hit === el || el.contains(hit))), under: hit ? hit.outerHTML.slice(0, 120) : null };
    })()`);
    if (!at) { console.log(`  nothing matches ${selector}`); return false; }
    if (!at.reaches) { console.log(`  the mouse at ${selector} (rect ${JSON.stringify(at.rect)}) would reach: ${at.under}`); return false; }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return true;
}
async function escape(cdp) {
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
async function shot(cdp, name) {
    try {
        const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (s.result?.data) { mkdirSync('ci-out', { recursive: true }); writeFileSync(join('ci-out', name), Buffer.from(s.result.data, 'base64')); console.log(`  screenshot: ci-out/${name}`); }
    } catch (error) { console.log(`  screenshot: none (${String(error)})`); }
}

// A long question with options, as the owner's was: the room is what maximize is for.
const BODY = [
    '## Push s28 to the release line?',
    '',
    'The slice is green on its focused rows. Before it goes, read what it changes:',
    '',
    ...Array.from({ length: 14 }, (_, i) => `${i + 1}. A change to read before answering, long enough to wrap in the small window, so the room maximize gives is seen in the screenshot (line ${i + 1}).`),
].join('\n');
const ITEM = {
    id: 'ftq-1019', source: 'agent-question', agentId: 'agent_probe_1019', agentName: 'probe', workspaceId: null, workspaceName: 'Probe', title: 'Push s28',
    blocking: true, priority: 'normal', at: Date.now(), forwardedFrom: null,
    answer: { kind: 'form', fields: 1, questions: [{ header: 'Push', question: BODY, options: [{ label: 'Push it', description: 'Merge and push s28 now' }, { label: 'Hold', description: 'Keep it on its branch' }] }] },
};

/** The question window's size and the display's work area, as the page sees them. */
// VISIBLE-1019: what a person sees of the window is its INNER size. On Windows a resizable window carries an invisible
// resize border outside its visible edge (measured on a test VM: 8 px left, right and bottom, none on top; outer
// 576x528 around inner 560x520, and outer 1040x728 at x -8 around a visible 1024x720 that is exactly the work area). So
// "fills the work area" is asked of the visible rectangle, on all four sides: left (vl) and top (vt) from the window's
// position and that border, with its inner width and height. Where there is no such border they are the outer ones.
const SIZE = `JSON.stringify({ w: window.outerWidth, h: window.outerHeight, aw: screen.availWidth, ah: screen.availHeight, ax: screen.availLeft ?? 0, ay: screen.availTop ?? 0, x: window.screenX, y: window.screenY, iw: window.innerWidth, ih: window.innerHeight, vl: window.screenX + (window.outerWidth - window.innerWidth) / 2, vt: window.screenY + (window.outerHeight - window.innerHeight) - (window.outerWidth - window.innerWidth) / 2, max: document.querySelector('[data-question-window]')?.getAttribute('data-question-maximized') ?? null, form: document.querySelector('[data-deck-form]')?.getBoundingClientRect().width ?? null, formClass: document.querySelector('[data-deck-form]')?.className ?? '' })`;
const near = (a, b) => Math.abs(a - b) <= 4;
/** The visible window is the work area: each of its four sides within 4 px of the work area's. */
const fills = (s) => near(s.vl, s.ax) && near(s.vt, s.ay) && near(s.iw, s.aw) && near(s.ih, s.ah);
const FILLS = `((s) => s.max === 'on' && Math.abs(s.vl - s.ax) <= 4 && Math.abs(s.vt - s.ay) <= 4 && Math.abs(s.iw - s.aw) <= 4 && Math.abs(s.ih - s.ah) <= 4)`;

console.log('\nTHE WHOLE QUESTION MAXIMIZED — what a person sees, in the real app\n');
const MAX = '[data-question-drag] [data-action="question-maximize"]';
let app = launch();
let main = null;
let ask = null;
try {
    main = await Cdp.connect(mainWindow, 'main window');
    check(await waitFor(main, `Boolean(document.querySelector('[data-route]'))`, 60_000), '0. the app is up, on a home of its own');
    // What's new can open over a fresh home: a person closes it (its own Close), and any other modal with Escape.
    // Through the shared helper (scripts/cdp-whats-new.mjs): it throws if the dialog will not close, so no click goes through it.
    if (await waitFor(main, `Boolean(document.querySelector('[data-whats-new]'))`, 3_000)) {
        const closed = await closeWhatsNew((expression) => main.evaluate(expression));
        check(closed.closed, '0b. What’s new is closed');
    }
    for (let i = 0; i < 3 && (await main.evaluate(`Boolean(document.querySelector('[aria-modal="true"]'))`)); i++) { await escape(main); await sleep(500); }

    check(await main.evaluate(`typeof window.genie?.remoteQuestions?.report === 'function'`), '1. the main window can report a question');
    await main.evaluate(`window.genie.remoteQuestions.report('probe-host', [${JSON.stringify(ITEM)}]); true`);
    ask = await Cdp.connect((list) => list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && isGeniePage(t.url, 'question')) ?? null, 'question window', 30_000);
    // The window is shown without taking focus (it never takes the keyboard from a person typing); the run's keys reach it anyway.
    await ask.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    check(await waitFor(ask, `Boolean(document.querySelector('[data-question-window]:not([data-question-window="empty"])'))`, 20_000), '2. the question window opens and shows the question');
    check(await waitFor(ask, `Boolean(document.querySelector(${JSON.stringify(MAX)}))`, 5_000), '3. its header has the Maximize button');
    await sleep(500);
    const before = JSON.parse(await ask.evaluate(SIZE));
    console.log(`  normal: ${JSON.stringify(before)}`);
    check(before.max === 'off', '4a. it opens at its normal size (not maximized)', String(before.max));
    // POSITIVE CONTROL: the window starts well short of the work area, so "fills it" below is something that changed.
    // (The VM's display can be small: measured 512x384, where the normal window is clamped to 400x334.)
    check(before.w <= before.aw - 40 && before.h <= before.ah - 40, '4b. CONTROL: the normal window is at least 40 px short of the work area each way', `${before.w}x${before.h} of ${before.aw}x${before.ah}`);
    check(await ask.evaluate(`document.querySelector(${JSON.stringify(MAX)})?.getAttribute('title') ?? ''`) === 'Maximize', '4c. the button’s tooltip says Maximize');
    await shot(ask, 'question-maximize-1019-normal.png');

    check(await click(ask, MAX), '5. Maximize takes a mouse click');
    check(await waitFor(ask, `${FILLS}(${SIZE.replace(/^JSON\.stringify/, '')})`, 10_000), '6. the WINDOW grows to the display’s work area');
    await sleep(500);
    const big = JSON.parse(await ask.evaluate(SIZE));
    console.log(`  maximized: ${JSON.stringify(big)}`);
    check(fills(big), '6b. measured: the visible window is the work area, on all four sides', `${big.iw}x${big.ih} at ${big.vl},${big.vt} of ${big.aw}x${big.ah} at ${big.ax},${big.ay}`);
    check(big.w >= big.aw - 4 && big.h >= big.ah - 4, '6c. and its outer size is not short of it', `${big.w}x${big.h}`);
    check(!big.formClass.includes('max-w-[72ch]') && big.form > before.form, '7. the question uses the room: the form is wider than in the normal window', `${before.form} → ${big.form}`);
    check(await ask.evaluate(`document.querySelector(${JSON.stringify(MAX)})?.getAttribute('title') ?? ''`) === 'Restore (Esc)', '7b. the button now says Restore (Esc)');
    await shot(ask, 'question-maximize-1019-maximized.png');

    await escape(ask);
    check(await waitFor(ask, `(() => { const s = ${SIZE.replace(/^JSON\.stringify/, '')}; return s.max === 'off' && Math.abs(s.w - ${before.w}) <= 4 && Math.abs(s.h - ${before.h}) <= 4; })()`, 10_000), '8. Esc restores the window to the size it had');
    await sleep(500);
    check(await ask.evaluate(`Boolean(document.querySelector('[data-question-window]:not([data-question-window="empty"])'))`), '9. and Esc was not Later: the question is still shown');
    const back = JSON.parse(await ask.evaluate(SIZE));
    console.log(`  restored by Esc: ${JSON.stringify(back)}`);

    check(await click(ask, MAX), '10. Maximize again');
    check(await waitFor(ask, `document.querySelector('[data-question-window]')?.getAttribute('data-question-maximized') === 'on'`, 10_000), '10b. maximized');
    await sleep(500);
    check(await click(ask, MAX), '11. the same button, Restore, takes a click');
    check(await waitFor(ask, `(() => { const s = ${SIZE.replace(/^JSON\.stringify/, '')}; return s.max === 'off' && Math.abs(s.w - ${before.w}) <= 4 && Math.abs(s.h - ${before.h}) <= 4; })()`, 10_000), '12. and the window is back at the size it had');
    await sleep(500);
    console.log(`  restored by the button: ${await ask.evaluate(SIZE)}`);
    await shot(ask, 'question-maximize-1019-restored.png');
} catch (error) {
    check(false, 'the run did not finish', error instanceof Error ? error.message : String(error));
} finally {
    try { await main?.evaluate(`window.genie?.remoteQuestions?.report('', []); true`); } catch { /* the page has gone */ }
    for (const c of [ask, main]) {
        if (!c) continue;
        try {
            if (failures.length > 0) console.log(`  on screen: ${String(await c.evaluate(`document.body?.innerText?.slice(0, 600) ?? ''`)).replace(/\s+/g, ' ')}`);
        } catch { /* the page has gone */ }
        try { c.close(); } catch { /* closed */ }
    }
    await stop(app);
    if (failures.length > 0 && existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}

if (failures.length > 0) {
    console.log(`\nQUESTION MAXIMIZE FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nQUESTION MAXIMIZE OK');
process.exit(0);

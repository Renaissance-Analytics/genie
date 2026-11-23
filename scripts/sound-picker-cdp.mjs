#!/usr/bin/env node
/**
 * THE SOUND PICKER, AS A PERSON SEES IT, in the real app (Tynn #996; the owner: "the select sound ui is broken", then
 * "instead of a check, invert the colors").
 *
 *   node scripts/sound-picker-cdp.mjs            (Linux: under xvfb-run)
 *
 * It starts the app itself, with a home folder and a debugger port of its own. Run on CI and the test VMs, never on a
 * desktop.
 *
 *   Settings → Notifications → a sound's button takes a mouse click and opens the popover → a click on another sound's
 *   name chooses it and closes it → reopened: the chosen row is INVERTED (its computed background is not the other
 *   rows', and its text reads on it at >= 4.5:1), its play button included, in light AND dark → no check mark anywhere →
 *   every row is one height, and each name sits on one line.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew, forceWhatsNewOpenForProbe, seedWhatsNewSeen } from './cdp-whats-new.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GENIE_PAGE_PROBE ??= '1';

const PORT = Number(process.env.SOUND_PICKER_CDP_PORT ?? 9352);
const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), 'sound-picker-'));
const home = join(root, 'home');
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
// What's new for this version already seen: a fresh home would open it late, over Settings (Tynn #1009).
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
            const timer = setTimeout(() => rej(new Error('the page\'s debugger socket did not open within 15 s')), 15_000);
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
/**
 * A real click, as a person's: the mouse pressed and released at the middle of what the selector finds. The Settings page
 * can be a narrow pane whose controls sit in its sideways overflow (measured on the test VM: the sound button was under
 * the chat pane), so it is scrolled into the middle both ways first, as a person would, and the click is refused unless
 * the mouse there reaches the element itself. A fresh home can raise a modal at any moment of the first minute (measured:
 * one covered the Settings nav after the start-up Escape): a person closes it with Escape and clicks again; so does this.
 */
async function click(cdp, selector) {
    await closeWhatsNew((expression) => cdp.evaluate(expression));
    let at = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        at = await cdp.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const hit = document.elementFromPoint(x, y);
            const modal = hit && !el.closest('[role="dialog"], [aria-modal="true"]') ? hit.closest('[aria-modal="true"], [role="dialog"]:not([data-sound-popover]), [data-react-fancy-modal-header]')?.closest('[role="dialog"], [aria-modal="true"]') ?? hit.closest('[data-react-fancy-modal-header]')?.parentElement : null;
            return { x, y, rect: [r.left, r.top, r.width, r.height].map(Math.round), reaches: Boolean(hit && (hit === el || el.contains(hit))), under: hit ? hit.outerHTML.slice(0, 120) : null, modal: modal ? modal.innerText.replace(/\\s+/g, ' ').slice(0, 160) : null };
        })()`);
        if (!at || at.reaches || !at.modal) break;
        console.log(`  a modal covers ${selector}: "${at.modal}"; pressing Escape`);
        for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(600);
    }
    if (!at) return false;
    if (!at.reaches) { console.log(`  the mouse at ${selector} (rect ${JSON.stringify(at.rect)}) would reach: ${at.under}`); return false; }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return true;
}
async function shot(cdp, name) {
    try {
        const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (s.result?.data) { mkdirSync('ci-out', { recursive: true }); writeFileSync(join('ci-out', name), Buffer.from(s.result.data, 'base64')); console.log(`  screenshot: ci-out/${name}`); }
    } catch (error) { console.log(`  screenshot: none (${String(error)})`); }
}

/**
 * What the open popover looks like, measured. Colours are resolved through a 1x1 canvas, so oklch(), color() and rgb()
 * all come back as sRGB bytes; contrast is WCAG's ratio of relative luminances.
 */
const MEASURE = `JSON.stringify((() => {
    const pop = document.querySelector('[data-sound-popover]');
    if (!pop) return null;
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data]; };
    /** The colour actually behind an element: its own background, else the nearest ancestor's that is not transparent. */
    const behind = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) return c; } return [255, 255, 255, 255]; };
    const lum = ([r, gg, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b); };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const rows = [...pop.querySelectorAll('[data-sound-row]')].map((row) => {
        const v = row.getAttribute('data-sound-row');
        const name = row.querySelector('[data-sound-name]');
        const play = row.querySelector('[data-sound-play]');
        const label = name?.querySelector('[data-react-fancy-button-label]') ?? name;
        const lh = parseFloat(getComputedStyle(label).lineHeight) || parseFloat(getComputedStyle(label).fontSize) * 1.5;
        const r = row.getBoundingClientRect(), lr = label.getBoundingClientRect(), pr = play.getBoundingClientRect();
        return {
            v, selected: row.getAttribute('data-selected') === 'true',
            height: Math.round(r.height * 10) / 10,
            nameBg: behind(name), playBg: behind(play), rowBg: behind(row),
            nameContrast: Math.round(contrast(rgba(getComputedStyle(name).color), behind(name)) * 100) / 100,
            playContrast: Math.round(contrast(rgba(getComputedStyle(play).color), behind(play)) * 100) / 100,
            labelLines: Math.round(lr.height / lh),
            labelMid: lr.top + lr.height / 2, playMid: pr.top + pr.height / 2,
            icons: name ? name.querySelectorAll('svg, [data-icon], [data-react-fancy-icon]').length : -1,
        };
    });
    return { rows, theme: document.documentElement.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', checks: (pop.innerHTML.match(/check/gi) ?? []).length };
})())`;

function judge(seen, theme, chosen, n) {
    const same = (a, b) => a.slice(0, 3).every((x, i) => Math.abs(x - b[i]) <= 2);
    const sel = seen.rows.filter((r) => r.selected);
    const others = seen.rows.filter((r) => !r.selected);
    const s = sel[0];
    console.log(`  [${theme}] selected: ${JSON.stringify(s)}`);
    console.log(`  [${theme}] another: ${JSON.stringify(others[0])}`);
    check(sel.length === 1 && s.v === chosen, `${n}a. [${theme}] exactly one row is selected, and it is the sound chosen`, JSON.stringify(sel.map((r) => r.v)));
    if (!s) return;
    check(others.every((o) => !same(o.nameBg, s.nameBg)), `${n}b. [${theme}] the selected row is INVERTED: its background is not any other row's`, `${s.nameBg} vs ${others[0]?.nameBg}`);
    check(same(s.playBg, s.nameBg) && same(s.rowBg, s.nameBg), `${n}c. [${theme}] its play button is inverted with it (one background across the row)`, `row ${s.rowBg} name ${s.nameBg} play ${s.playBg}`);
    check(s.nameContrast >= 4.5 && s.playContrast >= 3, `${n}d. [${theme}] its text reads on it (name >= 4.5:1, play icon >= 3:1)`, `name ${s.nameContrast}, play ${s.playContrast}`);
    check(others.every((o) => o.nameContrast >= 4.5), `${n}e. [${theme}] CONTROL: the other rows read too`, String(Math.min(...others.map((o) => o.nameContrast))));
    check(seen.rows.every((r) => r.icons === 0) && seen.checks === 0, `${n}f. [${theme}] no check mark: nothing but the label in a name button`, `icons ${seen.rows.map((r) => r.icons).join('')}, "check" ${seen.checks}`);
    const heights = [...new Set(seen.rows.map((r) => r.height))];
    check(heights.length === 1, `${n}g. [${theme}] every row is one height`, JSON.stringify(heights));
    check(seen.rows.every((r) => r.labelLines === 1 && Math.abs(r.labelMid - r.playMid) <= 2), `${n}h. [${theme}] each name is on one line, level with its play button`, JSON.stringify(seen.rows.filter((r) => r.labelLines !== 1 || Math.abs(r.labelMid - r.playMid) > 2).map((r) => r.v)));
}

console.log('\nTHE SOUND PICKER — what a person sees, in the real app\n');
const TRIGGER = '[data-surface="settings"] [data-sound-picker]';
/**
 * In the page: whether the address is this workstation's own (`genie://<workstation>/<path>...`), the form the window
 * rewrites every route to once it has its snapshot; with `path`, whether it is at that page (or within it). The name is
 * the window's own snapshot's, so the test holds only once the rewrite has really happened.
 */
const ON_THIS_WORKSTATION = `async (path) => {
    let s = null;
    try { s = await (window.genieTest ?? window.genie).snapshot(); } catch { return false; }
    const w = String(s?.workstation?.name ?? '').toLowerCase();
    if (!w) return false;
    const h = decodeURIComponent(window.location.hash).toLowerCase();
    const at = '#genie://' + w + '/';
    if (!h.startsWith(at)) return false;
    const here = h.slice(at.length).split(/[?#]/)[0];
    return path === null || here === path || here.startsWith(path + '/');
}`;
const onThisWorkstation = (path) => `(${ON_THIS_WORKSTATION})(${JSON.stringify(path)})`;
let app = launch();
let cdp = null;
try {
    cdp = await Cdp.connect();
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 60_000), '0. the app is up, on a home of its own');
    // A fresh home can open with a modal over the window: a person closes it first, and so does this run.
    for (let i = 0; i < 3 && (await cdp.evaluate(`Boolean(document.querySelector('[aria-modal="true"]'))`)); i++) {
        for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(500);
    }
    await cdp.evaluate(`window.location.hash = '#genie://settings'; true`);
    await forceWhatsNewOpenForProbe((expression) => cdp.evaluate(expression));
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-settings-nav="notifications"]'))`, 30_000), '1. Settings is open, with its Notifications section');
    check(await click(cdp, '[data-settings-nav="notifications"]'), '2. Notifications takes a mouse click');
    check(await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(TRIGGER)}))`, 15_000), '3. the page has a sound button');
    // PINNED (Tynn #1023): this row navigates and clicks as early as a person can, before the window has its snapshot. A
    // late address rewrite used to undo both (gate 1122-020342-554d85: back to the Dashboard; rerun 1122-013356-260f53:
    // back to General). Neither is undone: the window ends at this workstation's own Settings → Notifications.
    check(await waitFor(cdp, onThisWorkstation('settings/notifications'), 30_000), '3b. the address is this workstation’s own Settings → Notifications: no late rewrite undid a navigation', await cdp.evaluate('window.location.hash'));
    const before = await cdp.evaluate(`document.querySelector(${JSON.stringify(TRIGGER)})?.textContent ?? ''`);
    check(await click(cdp, TRIGGER), '4. the sound button takes a mouse click');
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-sound-popover] [data-sound-row]'))`, 5_000), '5. the popover opens, with its rows');
    await sleep(400);
    // Where everything is, as drawn: the popover and its first rows' parts (a squeezed name button shows here first).
    console.log(`  drawn: ${await cdp.evaluate(`JSON.stringify((() => {
        const b = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
        const pop = document.querySelector('[data-sound-popover]');
        if (!pop) return null;
        return { viewport: [innerWidth, innerHeight], pop: b(pop), rows: [...pop.querySelectorAll('[data-sound-row]')].slice(0, 3).map((row) => ({ v: row.getAttribute('data-sound-row'), row: b(row), name: b(row.querySelector('[data-sound-name]')), label: b(row.querySelector('[data-react-fancy-button-label]')), play: b(row.querySelector('[data-sound-play]')), nameClass: row.querySelector('[data-sound-name]')?.className })) };
    })())`)}`);
    await shot(cdp, 'sound-picker-996-open.png');
    // Choose a sound that is not the current one, by its name, with the mouse.
    const chosen = await cdp.evaluate(`(() => { const cur = document.querySelector('[data-sound-popover] [data-sound-row][data-selected="true"]')?.getAttribute('data-sound-row'); const c = [...document.querySelectorAll('[data-sound-popover] [data-sound-row]')].map((e) => e.getAttribute('data-sound-row')).find((v) => v !== cur && v !== 'off' && v !== 'custom'); return c ?? null; })()`);
    check(Boolean(chosen), '6. there is another sound to choose', String(chosen));
    check(await click(cdp, `[data-sound-popover] [data-sound-name="${chosen}"]`), `7. a mouse click on "${chosen}" chooses it`);
    check(await waitFor(cdp, `!document.querySelector('[data-sound-popover]')`, 5_000), '8. and closes the popover');
    check(await waitFor(cdp, `(document.querySelector(${JSON.stringify(TRIGGER)})?.textContent ?? '') !== ${JSON.stringify(before)}`, 10_000), '9. the button now names the chosen sound', `${before} → ${await cdp.evaluate(`document.querySelector(${JSON.stringify(TRIGGER)})?.textContent ?? ''`)}`);
    check(await click(cdp, TRIGGER), '10. reopened with the mouse');
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-sound-popover] [data-sound-row][data-selected="true"]'))`, 5_000), '11. the popover is open on its selected row');
    await sleep(300);
    const wasDark = await cdp.evaluate(`document.documentElement.classList.contains('dark')`);
    for (const theme of ['light', 'dark']) {
        await cdp.evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'}); document.documentElement.setAttribute('data-theme', '${theme}'); document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* an endless one */ } }); true`);
        // ^ The switch's own transitions finished at once (Tynn #1009): gate 1122-000850-5f70c8 read 13c/14c mid-way (light
        //   read the dark colour) although two readings 300 ms apart agreed: a software-rendered window can hold one still.
        // Button's own transition-all (200 ms; slower on the VM's software renderer) and the mouse left on the row it
        // clicked can be read mid-change (measured: a light reading of 58,122,240 at 1.69:1 while the screenshot taken
        // just after showed the settled colours). The mouse rests on the group heading, and the reading is taken once two
        // in a row agree.
        const heading = await cdp.evaluate(`(() => { const h = document.querySelector('[data-sound-popover] [data-sound-group] > div'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (heading) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: heading.x, y: heading.y, button: 'none', clickCount: 0 });
        await cdp.evaluate(`document.getAnimations().forEach((a) => { try { a.finish(); } catch { /* an endless one */ } }); true`);
        let raw = await cdp.evaluate(MEASURE);
        for (let i = 0, prev = null; i < 15 && raw !== prev; i++) { prev = raw; await sleep(300); raw = await cdp.evaluate(MEASURE); }
        const seen = JSON.parse(raw);
        check(seen !== null && seen.theme === theme, `12. [${theme}] measured with the popover open`);
        if (seen) judge(seen, theme, chosen, theme === 'light' ? 13 : 14);
        await shot(cdp, `sound-picker-996-${theme}.png`);
    }
    await cdp.evaluate(`document.documentElement.classList.toggle('dark', ${wasDark}); true`);
} catch (error) {
    check(false, 'the run did not finish', error instanceof Error ? error.message : String(error));
} finally {
    if (cdp) {
        try {
            if (failures.length > 0) console.log(`  on screen: ${String(await cdp.evaluate(`document.body?.innerText?.slice(0, 600) ?? ''`)).replace(/\s+/g, ' ')}`);
        } catch { /* the page has gone */ }
        cdp.close();
    }
    await stop(app);
    if (failures.length > 0 && existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}

if (failures.length > 0) {
    console.log(`\nSOUND PICKER FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nSOUND PICKER OK');
process.exit(0);

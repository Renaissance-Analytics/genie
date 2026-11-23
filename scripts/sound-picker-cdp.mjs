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
 *
 *   Then SOUND VOLUME (Tynn #1022, checks V0-V22; the levels a CLIENT setting, kept in its localStorage, never the host's; the mouse is the required input, the keyboard an extra): the master slider and a kind's level moved with the mouse and saved on
 *   the host, mute inverted, Advanced listing every kind, and a preview played at master x level (the Audio's own volume).
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew, forceWhatsNewOpenForProbe, seedWhatsNewSeen } from './cdp-whats-new.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * SOUND VOLUME (Tynn #1022), on the same page: the master slider moved with the mouse is written to the HOST (it reads the
 * same after leaving Notifications and coming back); mute is a button that turns INVERTED; Advanced lists every alert kind;
 * a kind's level moved with the mouse, then its play button, plays at master x that level — read off the Audio element the
 * one player made (its `volume`), so the claim is about the gain applied, not about a number on the page.
 */
/**
 * A range input as a person's MOUSE moves it: where its track is drawn, measured (it must be wide enough to aim at, and the
 * mouse at its middle must reach the input itself, not a wrapper — the first VM run's bug), then pressed at `from` of its
 * width and DRAGGED, the button held, to `to`, and released there. Returns what was measured; the caller checks it.
 */
async function dragRange(cdp, selector, from, to) {
    const at = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const reach = (f) => { const hit = document.elementFromPoint(r.left + r.width * f, y); return hit === el ? 'input' : hit ? hit.outerHTML.slice(0, 100) : null; };
        const row = el.closest('[data-sound-master], [data-sound-level]');
        return { left: r.left, width: r.width, height: r.height, row: row ? row.getBoundingClientRect().width : 0, y, rect: [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10), reachFrom: reach(${from}), reachTo: reach(${to}) };
    })()`);
    if (!at) return null;
    console.log(`  ${selector}: rect ${JSON.stringify(at.rect)}, the mouse at ${from} reaches ${at.reachFrom}, at ${to} reaches ${at.reachTo}`);
    const before = await valueOf(cdp, selector);
    const x = (f) => at.left + at.width * f;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x(from), y: at.y, button: 'none', clickCount: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x(from), y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(100);
    const pressed = await valueOf(cdp, selector);
    for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x(from + ((to - from) * i) / 8), y: at.y, button: 'left', buttons: 1, clickCount: 0 });
        await sleep(30);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x(to), y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    return { width: at.width, height: at.height, row: at.row, reaches: at.reachFrom === 'input' && at.reachTo === 'input', before, pressed, after: await valueOf(cdp, selector) };
}
/**
 * THE HOST'S SETTINGS, as its files hold them: every settings.json under this run's own home, read from disk. The levels
 * are a CLIENT setting (the owner's ruling), so none of them may be here; the sound the picker chose above IS a host
 * setting today, and is the control that the right file was read.
 */
function hostSettings() {
    const files = readdirSync(home, { recursive: true }).map(String).filter((f) => f.replace(/[\\]/g, '/').endsWith('runtime/settings.json'));
    return files.map((f) => { try { return { file: f, text: readFileSync(join(home, f), 'utf8') }; } catch { return { file: f, text: '' }; } });
}
const CLIENT_KEPT = `JSON.parse(localStorage.getItem('genie.client.sound-volume') ?? '{}')`;
const valueOf = (cdp, selector) => cdp.evaluate(`Number(document.querySelector(${JSON.stringify(selector)})?.value ?? NaN)`);
async function volumeProof(cdp) {
    const MASTER = '[data-sound-master] input[type="range"]';
    const MUTE = '[data-action="sound-mute"]';
    const column = await cdp.evaluate(`Math.round(document.querySelector('[data-settings-page="notifications"]')?.parentElement?.clientWidth ?? 0)`);
    check(column >= 400, 'V0. the Notifications column is wide enough to use (>= 400 px as drawn)', `${column} px`);
    check(await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(MASTER)}))`, 10_000), 'V1. Notifications has a master volume slider');
    check((await valueOf(cdp, MASTER)) === 100, 'V2. a fresh home is at 100%', String(await valueOf(cdp, MASTER)));
    await cdp.evaluate(`document.querySelector('[data-sound-volume]')?.scrollIntoView({ block: 'start' }); true`);
    await shot(cdp, 'sound-volume-1022-master.png');
    // The master, moved with the mouse to about 40%.
    const m = await dragRange(cdp, MASTER, 0.7, 0.4);
    check(m !== null && m.width >= 120, 'V3. the master slider draws a track wide enough to aim at (>= 120 px)', String(m?.width));
    check(m !== null && m.reaches, 'V3b. the mouse on that track reaches the range input itself, not a wrapper');
    // What the layout fix is FOR (job 1122-021227-3c98b4: the old layout passed V3 with a fixed 129 x 8 px input in a 958 px row).
    check(m !== null && m.row > 0 && m.width >= m.row * 0.5, 'V3d. the track fills its row (>= half its width), not a fixed native width', `${Math.round(m?.width ?? 0)} of ${Math.round(m?.row ?? 0)} px`);
    check(m !== null && m.height >= 16, 'V3e. its hit box is at least 16 px tall, not the 8 px line', `${m?.height} px`);
    check(m !== null && m.pressed >= 63 && m.pressed <= 77, 'V3c. a mouse PRESS at 70% of it sets about 70%', String(m?.pressed));
    const master = await valueOf(cdp, MASTER);
    check(master >= 33 && master <= 47, 'V4. and a mouse DRAG, held, to 40% leaves it at about 40%', String(master));
    await sleep(800);
    // Written to the host: away to General and back, the page is drawn again from the host's settings.
    check(await click(cdp, '[data-settings-nav="general"]'), 'V5. away to General');
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(MASTER)})`, 5_000);
    check(await click(cdp, '[data-settings-nav="notifications"]'), 'V6. and back to Notifications');
    check(await waitFor(cdp, `Number(document.querySelector(${JSON.stringify(MASTER)})?.value) === ${master}`, 10_000), `V7. the master still reads ${master}%: it was kept`, String(await valueOf(cdp, MASTER)));
    const keptMaster = await cdp.evaluate(`${CLIENT_KEPT}.alert_volume ?? null`);
    check(keptMaster === String(master), `V7b. it is kept by THIS CLIENT (its localStorage holds ${master})`, String(keptMaster));
    const hs = hostSettings();
    check(hs.length > 0 && hs.some((h) => /"sound_[a-z]+"\s*:/.test(h.text)), 'V7c. CONTROL: the host\'s settings.json is found, and holds the sound chosen above (a host setting today)', hs.map((h) => h.file).join(', ') || 'none found');
    check(hs.length > 0 && hs.every((h) => !/"alert_(volume|muted|levels)"/.test(h.text)), 'V7d. and holds NONE of the levels: they never reach the host', hs.map((h) => `${h.file}: ${(h.text.match(/"alert_[a-z]+"/g) ?? []).join(' ') || 'no alert_ keys'}`).join('; '));
    // Mute: a button, inverted while on (its background is not the unmuted one), and saved.
    const bg = `(() => { const cv = document.createElement('canvas'); cv.width = cv.height = 1; const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillStyle = getComputedStyle(document.querySelector(${JSON.stringify(MUTE)})).backgroundColor; g.fillRect(0, 0, 1, 1); return [...g.getImageData(0, 0, 1, 1).data].join(','); })()`;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', clickCount: 0 });
    await sleep(400);
    const before = await cdp.evaluate(bg);
    check((await cdp.evaluate(`document.querySelector(${JSON.stringify(MUTE)})?.getAttribute('aria-pressed')`)) === 'false', 'V8. mute starts off');
    check(await click(cdp, MUTE), 'V9. mute takes a mouse click');
    check(await waitFor(cdp, `document.querySelector(${JSON.stringify(MUTE)})?.getAttribute('aria-pressed') === 'true'`, 10_000), 'V10. the host answers: muted');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', clickCount: 0 });
    let after = await cdp.evaluate(bg);
    for (let i = 0, prev = null; i < 10 && after !== prev; i++) { prev = after; await sleep(300); after = await cdp.evaluate(bg); }
    check(after !== before, 'V11. muted, the button is INVERTED (its background changed)', `${before} -> ${after}`);
    check((await valueOf(cdp, MASTER)) === master, 'V12. muting keeps the level where it was', String(await valueOf(cdp, MASTER)));
    await shot(cdp, 'sound-volume-1022-muted.png');
    // The one player's Audio elements, recorded from here on: their `volume` is the gain that was applied.
    await cdp.evaluate(`(() => { const A = window.Audio; window.__made = []; const W = function (url) { const a = new A(url); window.__made.push(a); return a; }; W.prototype = A.prototype; window.Audio = W; return true; })()`);
    // Advanced: every kind, its own level, its own play button.
    check(await click(cdp, '[data-action="sound-levels-toggle"]'), 'V13. Advanced takes a mouse click');
    check(await waitFor(cdp, `document.querySelectorAll('[data-sound-level]').length === 26`, 5_000), 'V14. it lists every alert kind (26), each with a level', String(await cdp.evaluate(`document.querySelectorAll('[data-sound-level]').length`)));
    const LEVEL = '[data-sound-level="finished"] input[type="range"]';
    const l = await dragRange(cdp, LEVEL, 0.2, 0.5);
    check(l !== null && l.width >= 120 && l.reaches, 'V15. "An agent finishes" draws a track the mouse reaches (>= 120 px, the input itself)', `${l?.width} px`);
    check(l !== null && l.row > 0 && l.width >= (l.row - 256) * 0.5 && l.height >= 16, 'V15c. a level track fills the row beside its label, and its hit box is >= 16 px tall', `${Math.round(l?.width ?? 0)} of ${Math.round(l?.row ?? 0)} px (label 256), ${l?.height} px tall`);
    check(l !== null && l.pressed >= 13 && l.pressed <= 27, 'V15b. a mouse press at 20% of it sets about 20%', String(l?.pressed));
    const level = await valueOf(cdp, LEVEL);
    check(level >= 43 && level <= 57, 'V16. and a mouse drag to 50% leaves it at about 50%', String(level));
    check(await click(cdp, '[data-sound-level-play="finished"]'), 'V17. its play button takes a mouse click (muted: a preview still plays, so a level is set by ear)');
    check(await waitFor(cdp, `(window.__made ?? []).length > 0`, 5_000), 'V18. the player made a sound');
    const vol = await cdp.evaluate(`window.__made.at(-1)?.volume ?? null`);
    const want = (master / 100) * (level / 100);
    // The gain must CHANGE: below full volume (100% x 100% = 1 is what no levels at all give too), and exactly master x level.
    check(typeof vol === 'number' && vol < 0.5 && Math.abs(vol - want) < 0.005, `V19. it played at master x level = ${master}% x ${level}% = ${want.toFixed(3)}`, String(vol));
    await sleep(800);
    const wasDarkV = await cdp.evaluate(`document.documentElement.classList.contains('dark')`);
    for (const theme of ['light', 'dark']) {
        await cdp.evaluate(`document.documentElement.classList.toggle('dark', ${theme === 'dark'}); document.documentElement.setAttribute('data-theme', '${theme}'); document.querySelector('[data-sound-volume]')?.scrollIntoView({ block: 'start' }); true`);
        await sleep(600);
        await shot(cdp, `sound-volume-1022-advanced-${theme}.png`);
    }
    await cdp.evaluate(`document.documentElement.classList.toggle('dark', ${wasDarkV}); true`);
    // The level was saved too: away and back, Advanced reopened, the kind reads the same.
    await click(cdp, '[data-settings-nav="general"]');
    await waitFor(cdp, `!document.querySelector('[data-sound-volume]')`, 5_000);
    await click(cdp, '[data-settings-nav="notifications"]');
    await waitFor(cdp, `Boolean(document.querySelector('[data-action="sound-levels-toggle"]'))`, 10_000);
    await click(cdp, '[data-action="sound-levels-toggle"]');
    check(await waitFor(cdp, `Number(document.querySelector(${JSON.stringify(LEVEL)})?.value) === ${level}`, 10_000), `V20. "An agent finishes" still reads ${level}%: it was kept`, String(await valueOf(cdp, LEVEL)));
    const keptLevels = await cdp.evaluate(`JSON.parse(${CLIENT_KEPT}.alert_levels ?? '{}').finished ?? null`);
    const keptMuted = await cdp.evaluate(`${CLIENT_KEPT}.alert_muted ?? null`);
    check(keptLevels === level && keptMuted === true, `V20b. the level and the mute are kept by THIS CLIENT (finished ${level}, muted)`, `finished ${keptLevels}, muted ${keptMuted}`);
    const hs2 = hostSettings();
    check(hs2.length > 0 && hs2.every((h) => !/"alert_(volume|muted|levels)"/.test(h.text)), 'V20c. and the host\'s settings.json still holds none of them', hs2.map((h) => `${h.file}: ${(h.text.match(/"alert_[a-z]+"/g) ?? []).join(' ') || 'no alert_ keys'}`).join('; '));
    check(await waitFor(cdp, `Number(document.querySelector('[data-sound-level="question"] input[type="range"]')?.value) === 100`, 2_000), 'V21. CONTROL: a kind not moved is still 100%');
    // EXTRA, not instead of the mouse: the keyboard moves a level too (focus, then Left arrow presses).
    const KEY = '[data-sound-level="question"] input[type="range"]';
    await cdp.evaluate(`(() => { document.querySelector(${JSON.stringify(KEY)})?.focus(); return true; })()`);
    for (let i = 0; i < 5; i++) for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    check(await waitFor(cdp, `Number(document.querySelector(${JSON.stringify(KEY)})?.value) === 95`, 3_000), 'V22. EXTRA: five Left arrow presses take a level from 100% to 95%', String(await valueOf(cdp, KEY)));
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
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(cdp, `!document.querySelector('[data-sound-popover]')`, 5_000);
    // MAKE ROOM, as a person would (job 1122-020349-0faba7): on a fresh home in this window the chat pane leaves the Settings
    // content column about 20 px wide, where no slider can be aimed at; a person widens the window first. 1920x1080, as
    // scripts/comms-arcs-proof.mjs and layout-sweep.mjs do. The column's width is CHECKED (V0), never assumed.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    await volumeProof(cdp);
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

#!/usr/bin/env node
/**
 * PROBE, Tynn #1032: "a terminal sometimes drops typed input" on Linux (smoke 37-38, ui-lag "the build to start printing
 * was not ready", about 1 smoke run in 10).
 *
 *   node scripts/probe-1032-frames.mjs            (a test VM's Hyprland session only; never a desktop)
 *   PROBE_LAUNCHES=20 PROBE_CDP_PORT=9350         (defaults)
 *
 * What the four failing gates already showed, read from their own dumps: the keys were NOT dropped. The window's write
 * went out and was answered (`result true`), the shell echoed the token (it is in the workspace's output and in xterm's
 * buffer), and xterm's DOM rows never drew it. Only the cursor row was ever drawn, at the moment the smoke focused the
 * terminal: xterm's focus handler draws that row directly, everything else it draws on an animation frame. And in all
 * four, and in none of 35 passes, electron.log has no "[genie] focus: main took focus" line: the window was never
 * activated. On Wayland a window the compositor does not show gets no frame callbacks, so no requestAnimationFrame.
 *
 * The hypothesis, then: in some launches the compositor never shows Genie's main window; the page runs (CDP, React, input)
 * with no frames, and xterm cannot draw. This probe settles it, both ways, with every hop timed:
 *
 *   1. LAUNCHES (the race, forced by repetition): the app started PROBE_LAUNCHES times, each on a fresh home. Each launch
 *      says: the main window's first-show steps from electron.log (load, show(), focus: main's FirstShowTrace), whether
 *      it took focus, Hyprland's own record of the window (mapped, hidden, workspace, size, focus history), the page's
 *      animation frames per second, and a token typed into a placed terminal, timed: the write leaving the page, its
 *      answer, the echo arriving, the token in xterm's buffer, the token in its drawn rows. And xterm's renderer state.
 *   2. THE CONTROL, FORCED: one more launch, its window moved by Hyprland to a special workspace nobody sees, then a token
 *      typed. If the hypothesis is right, that reproduces the failing gates' signature exactly (in the buffer, not drawn,
 *      0 frames). Then the window is brought back, and whether xterm draws what it missed is measured.
 *
 * Exit 0 when it measured (whatever it found); 1 when the control did not behave as a control (the gauge cannot be
 * trusted); 2 when it could not measure here.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew } from './cdp-whats-new.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'linux' || process.env.GENIE_TEST_MACHINE !== '1') {
    console.log('PROBE_1032 not measured: a Linux test machine only (GENIE_TEST_MACHINE=1, set by scripts/ci/linux.sh)');
    process.exit(2);
}
process.env.GENIE_PAGE_PROBE ??= '1';
const LAUNCHES = Number(process.env.PROBE_LAUNCHES ?? 20);
const PORT = Number(process.env.PROBE_CDP_PORT ?? 9350);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electron = createRequire(import.meta.url)('electron');
const out = (tag, value) => console.log(`${tag} ${JSON.stringify(value)}`);

function hypr(...args) {
    try { return JSON.parse(execFileSync('hyprctl', ['-j', ...args], { encoding: 'utf8', timeout: 5_000 })); } catch (error) { return { error: String(error?.message ?? error).slice(0, 200) }; }
}
function hyprDispatch(...args) {
    try { return execFileSync('hyprctl', ['dispatch', ...args], { encoding: 'utf8', timeout: 5_000 }).trim(); } catch (error) { return `error: ${String(error?.message ?? error).slice(0, 200)}`; }
}
/** Hyprland's record of this app's windows (by the browser process's pid), and what it has active. */
function compositor(pid) {
    const clients = hypr('clients');
    const mine = Array.isArray(clients) ? clients.filter((c) => c.pid === pid).map((c) => ({ title: c.title, class: c.class, mapped: c.mapped, hidden: c.hidden, workspace: c.workspace, at: c.at, size: c.size, fullscreen: c.fullscreen, floating: c.floating, focusHistoryID: c.focusHistoryID, address: c.address })) : clients;
    const active = hypr('activewindow');
    const others = Array.isArray(clients) ? clients.filter((c) => c.pid !== pid).map((c) => ({ title: String(c.title).slice(0, 60), class: c.class, workspace: c.workspace?.name, fullscreen: c.fullscreen, mapped: c.mapped })) : [];
    return { mine, active: active && !active.error ? { pid: active.pid, title: String(active.title ?? '').slice(0, 60), class: active.class } : active, activeWorkspace: hypr('activeworkspace')?.name ?? null, others };
}

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect() {
        const until = Date.now() + 90_000;
        let page = null, last = 'no attempt';
        while (Date.now() < until && !page) {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
                page = mainWindow(targets);
                last = `no main window yet (${targets.length} targets)`;
            } catch (error) { last = String(error); }
            if (!page) await sleep(250);
        }
        if (!page) throw new Error(`no main window on the debugger port: ${last}`);
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
            const timer = setTimeout(() => { this.#pending.delete(id); rej(new Error(`no answer to ${method} within 60 s`)); }, 60_000);
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
    close() { try { this.#ws.close(); } catch { /* gone */ } }
}
async function until(c, expression, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await c.evaluate(expression)) return true; } catch { /* not yet */ } await sleep(200); }
    return false;
}

/** Animation frames the page got in one second (a timer ends the count if no frame comes at all). */
const RAF_PER_S = `new Promise((done) => { let n = 0; const t0 = performance.now(); const tick = () => { n += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else done(n); }; requestAnimationFrame(tick); setTimeout(() => done(n), 1500); })`;

/** The pane's xterm, by React's own records (as smoke-cdp's TERMINAL_LAYERS reads it), installed as window.__probeXterm. */
const FIND_XTERM = `(() => {
    const el = document.querySelector('[data-terminal-pane]');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let f = key ? el[key] : null;
    for (let i = 0; f && i < 40; i++, f = f.return) {
        if (f.ref && typeof f.ref === 'object' && f.ref.current && 'xterm' in f.ref.current && f.ref.current.xterm) { window.__probeXterm = f.ref.current.xterm; return true; }
    }
    return false;
})()`;

/** Every hop of the page's side, timed from the moment it is installed: the window's frames out and in on the door. */
const INSTALL_WIRE = `(() => {
    const t0 = performance.now();
    const wire = window.__probeWire = [];
    window.genieLocalProtocol?.onFrame((action, _c, text) => {
        const at = Math.round(performance.now() - t0);
        if (action !== 'frame') { wire.push(at + ' ' + action); return; }
        let m; try { m = JSON.parse(text); } catch { return; }
        if (m.kind === 'result' && (m.value === true || m.value === false)) wire.push(at + ' result ' + m.value);
        else if (m.kind === 'event' && typeof m.channel === 'string' && m.channel.startsWith('terminal-')) { const e = m.payload?.event ?? null; if (e && e.kind === 'data') wire.push(at + ' echo ' + JSON.stringify(String(e.data ?? '').slice(-60))); }
        if (wire.length > 200) wire.splice(0, wire.length - 200);
    });
    const x = window.__probeXterm;
    window.__probeT0 = t0;
    window.__probeSent = [];
    x?.onData?.((d) => window.__probeSent.push(Math.round(performance.now() - t0) + ' onData ' + JSON.stringify(d.slice(-60))));
    window.__probeRenders = 0;
    x?.onRender?.(() => { window.__probeRenders += 1; });
    return true;
})()`;

/** Where the token is: in xterm's buffer, in its drawn rows; and xterm's renderer state. */
const tokenState = (token) => `(() => {
    const x = window.__probeXterm, rs = x?._core?._renderService ?? null, b = x?.buffer?.active;
    let inBuffer = false;
    if (b) for (let i = 0; i < b.length; i++) { const l = b.getLine(i)?.translateToString(true) ?? ''; if (l.includes(${JSON.stringify(token)})) inBuffer = true; }
    // Joined: a narrow pane wraps the line.
    const bufferJoined = b ? Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('') : '';
    const rows = (document.querySelector('[data-terminal-pane] .xterm-rows')?.innerText ?? '').replace(/\\n/g, '');
    return {
        inBuffer: inBuffer || bufferJoined.includes(${JSON.stringify(token)}),
        inRows: rows.includes(${JSON.stringify(token)}),
        rowsTail: rows.slice(-80),
        renders: window.__probeRenders ?? null,
        renderer: rs ? { isPaused: rs._isPaused ?? null, needsFullRefresh: rs._needsFullRefresh ?? null, framePending: rs._renderDebouncer?._animationFrame !== undefined && rs._renderDebouncer?._animationFrame !== null } : null,
        cols: x?.cols ?? null, rows: x?.rows ?? null,
        visibility: document.visibilityState, hasFocus: document.hasFocus(),
        sinceT0: Math.round(performance.now() - (window.__probeT0 ?? 0)),
    };
})()`;

function electronLines(log) {
    try {
        return readFileSync(log, 'utf8').split('\n').filter((l) => /^\[genie\] (window (main|remote):|focus: main)/.test(l)).slice(0, 12);
    } catch { return []; }
}

async function stopApp(app, home) {
    let host = null;
    try { host = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'host.json'), 'utf8')).pid ?? null; } catch { /* none */ }
    const gone = new Promise((r) => { if (app.exitCode !== null) r(); else app.once('exit', r); });
    try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ }
    await Promise.race([gone, sleep(15_000)]);
    if (app.exitCode === null) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (typeof host === 'number') {
        try { process.kill(host, 'SIGTERM'); } catch { /* gone */ }
        await sleep(1500);
        try { process.kill(host, 'SIGKILL'); } catch { /* gone */ }
    }
    await sleep(1500);
}

/** One launch, measured. `force` = move the window where the compositor shows nothing, before typing. */
async function oneLaunch(n, force) {
    const root = mkdtempSync(join(tmpdir(), 'probe-1032-'));
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') };
    execFileSync(process.execPath, ['scripts/smoke-seed.mjs'], { env, stdio: 'ignore' });
    const log = join(root, 'electron.log');
    const fd = openSync(log, 'a');
    const startedAt = Date.now();
    const app = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox'], { env, stdio: ['ignore', fd, fd], detached: true });
    const result = { launch: n, forced: force, pid: app.pid };
    let c = null;
    try {
        c = await Cdp.connect();
        result.attachedMs = Date.now() - startedAt;
        await until(c, `Boolean(document.querySelector('[data-surface]'))`, 30_000);
        await closeWhatsNew((e) => c.evaluate(e), { log: () => {} }).catch(() => {});
        await sleep(1500);
        result.atBoot = { rafPerS: await c.evaluate(RAF_PER_S), compositor: compositor(app.pid) };
        // A Terminals panel in a tab of its own, as smoke-cdp's 49 and ui-lag place one.
        await c.evaluate(`window.location.hash = '#genie://workspace/tynn'; true`);
        if (!(await until(c, `Boolean(document.querySelector('[data-surface="workspace"] [data-workspace-tab="add"]'))`, 30_000))) throw new Error('no workspace surface');
        await c.evaluate(`document.querySelector('[data-workspace-tab="add"]').click(); true`);
        if (!(await until(c, `Boolean(document.querySelector('[data-designed-tab] [data-add-panel="terminal"]'))`, 15_000))) throw new Error('no panel designer');
        await c.evaluate(`document.querySelector('[data-designed-tab] [data-add-panel="terminal"]').click(); true`);
        if (!(await until(c, `Boolean(document.querySelector('[data-panel="terminal"] [data-terminal-pane] .xterm-rows'))`, 30_000))) throw new Error('no terminal pane');
        if (!(await until(c, FIND_XTERM, 10_000))) throw new Error('the pane\'s xterm was not found');
        await c.evaluate(INSTALL_WIRE);
        // The prompt: in the buffer first (the shell is up), then whether it is drawn.
        const prompt = await until(c, `(() => { const b = window.__probeXterm.buffer.active; for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) ?? '').includes('$')) return true; return false; })()`, 20_000);
        result.promptInBuffer = prompt;
        if (force) {
            result.forceMove = hyprDispatch('movetoworkspacesilent', `special:probe1032,pid:${app.pid}`);
            await sleep(1500);
            result.forcedCompositor = compositor(app.pid);
        }
        result.beforeTyping = { rafPerS: await c.evaluate(RAF_PER_S), promptDrawn: await c.evaluate(`(document.querySelector('[data-terminal-pane] .xterm-rows')?.innerText ?? '').includes('$')`) };
        const token = `p1032-${Math.random().toString(16).slice(2, 10)}`;
        await c.evaluate(`document.querySelector('[data-terminal-pane] textarea')?.focus(); true`);
        await c.send('Input.insertText', { text: `echo ${token}` });
        await until(c, `(${tokenState(token)}).inRows`, 5_000);
        result.typed = { token, ...(await c.evaluate(tokenState(token))), sent: await c.evaluate('window.__probeSent'), wire: await c.evaluate('window.__probeWire.slice(-12)') };
        if (force) {
            const ws = result.atBoot.compositor.mine[0]?.workspace?.name ?? result.atBoot.compositor.activeWorkspace ?? '1';
            result.restoreMove = hyprDispatch('movetoworkspace', `name:${ws},pid:${app.pid}`);
            await sleep(2000);
            result.afterRestore = { rafPerS: await c.evaluate(RAF_PER_S), ...(await c.evaluate(tokenState(token))), compositor: compositor(app.pid) };
        }
        result.endCompositor = compositor(app.pid);
    } catch (error) {
        result.error = String(error?.message ?? error).slice(0, 300);
    } finally {
        result.electronLog = electronLines(log);
        result.mainTookFocus = result.electronLog.some((l) => l.startsWith('[genie] focus: main took focus'));
        c?.close();
        await stopApp(app, home);
        try { rmSync(root, { recursive: true, force: true }); } catch { /* left in tmp */ }
    }
    return result;
}

const verdict = (r) => {
    if (r.error) return 'ERROR';
    if (!r.typed) return 'UNMEASURED';
    if (r.typed.inRows) return 'DRAWN';
    if (r.typed.inBuffer) return 'IN-BUFFER-NOT-DRAWN';
    return 'NOT-IN-BUFFER';
};

const rows = [];
for (let i = 1; i <= LAUNCHES; i++) {
    const r = await oneLaunch(i, false);
    rows.push(r);
    out('PROBE_1032_LAUNCH', { verdict: verdict(r), ...r });
}
const control = await oneLaunch(LAUNCHES + 1, true);
out('PROBE_1032_CONTROL', { verdict: verdict(control), ...control });

const table = rows.map((r) => ({ n: r.launch, verdict: verdict(r), mainTookFocus: r.mainTookFocus, rafBoot: r.atBoot?.rafPerS ?? null, rafTyping: r.beforeTyping?.rafPerS ?? null, mapped: r.atBoot?.compositor?.mine?.[0]?.mapped ?? null, hidden: r.atBoot?.compositor?.mine?.[0]?.hidden ?? null, windows: r.atBoot?.compositor?.mine?.length ?? null, paused: r.typed?.renderer?.isPaused ?? null }));
console.log('PROBE_1032_TABLE');
for (const t of table) console.log(`  ${JSON.stringify(t)}`);
const stuck = rows.filter((r) => verdict(r) === 'IN-BUFFER-NOT-DRAWN');
const lost = rows.filter((r) => verdict(r) === 'NOT-IN-BUFFER');
out('PROBE_1032_SUMMARY', {
    launches: rows.length,
    drawn: rows.filter((r) => verdict(r) === 'DRAWN').length,
    inBufferNotDrawn: stuck.length,
    notInBuffer: lost.length,
    errors: rows.filter((r) => r.error).length,
    stuckWithoutFocus: stuck.filter((r) => !r.mainTookFocus).length,
    stuckWithZeroFrames: stuck.filter((r) => r.beforeTyping?.rafPerS === 0).length,
    drawnWithoutFocus: rows.filter((r) => verdict(r) === 'DRAWN' && !r.mainTookFocus).length,
});
// The control must reproduce the signature, or nothing above can be read: in the buffer, not drawn, no frames.
const controlOk = verdict(control) === 'IN-BUFFER-NOT-DRAWN' && control.beforeTyping?.rafPerS === 0;
out('PROBE_1032_CONTROL_VERDICT', { reproduced: controlOk, recoveredWhenShown: control.afterRestore?.inRows ?? null, rafAfterRestore: control.afterRestore?.rafPerS ?? null });
process.exit(controlOk ? 0 : 1);

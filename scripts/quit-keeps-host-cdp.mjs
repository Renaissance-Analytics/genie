#!/usr/bin/env node
/**
 * QUIT KEEPS THE HOST (the host split P1b, genie#1451) — measured on the REAL app with a REAL process table.
 *
 *   node scripts/quit-keeps-host-cdp.mjs
 *
 * Three agents stream; the person answers the quit "Just close the UI" (the owner, 2026-11-02: "Keep the tray up"), and:
 *   every window closes, the window process STAYS as the tray, and the tray says the host runs the agents;
 *   Open Genie from the tray builds the window again in that same process: the SAME genie-host pid, the SAME provider pid per
 *   agent, and every ledger has grown — with every tick the providers streamed while no window was open, in order;
 *   closed again from the tray, a SECOND LAUNCH builds the window again in the same process (the single-instance lock);
 *   "Shut down everything" from the tray ends the window process, the host and the providers.
 *
 * HOW IT RUNS. It launches Genie itself, from the
 * root of a built and SEEDED tree (smoke-seed.mjs), with nothing of Genie's on the debugger port: vm-smoke stops its own
 * Electron first. Launch flags follow the caller's session: `--no-sandbox` on Linux, `--ozone-platform=$XDG_SESSION_TYPE`
 * when that is x11 or wayland, anything else in QUIT_CDP_ARGS. Providers are the stub app server (scripts/stub-codex.mjs)
 * in its TICKER mode — `tick <n> pid <pid>` four times a second, so each agent's ledger names the process streaming for it —
 * switched on by a marker file holding THIS script's pid (a marker whose pid is dead is ignored by the stub, so a run that
 * was killed cannot turn a later smoke's provider into a ticker).
 *
 * HOW IT ANSWERS THE QUIT. The question is a native dialog CDP cannot click. The WINDOW process is launched with
 * `--inspect` (a launch flag, like `--remote-debugging-port`; the host is spawned without it). Over that inspector the
 * script replaces the person's CLICK — `dialog.showMessageBoxSync` answers a button index and writes down what it was asked
 * — and calls `app.quit()`. Everything after the click is the product's own: before-quit, quitPlan, quitAnswer, closeUi.
 * What the dialog was asked is checked, so a two-answer question (no host) cannot pass. The TRAY is read and clicked the
 * same way: main.ts's read-only probe (`Symbol.for('genie.tray')`) says what it shows, and an item's click is the very
 * handler the tray's menu runs — Electron's Tray can be neither asked nor clicked from outside.
 *
 * IT NEVER HANGS SILENTLY (batch L2: a first version printed nothing for 600 s before `timeout` killed it). Every step prints
 * a line BEFORE it acts, with the time since start. Every fetch, CDP call and wait has its own deadline, and a missed one
 * fails naming its step. Every synchronous process call has a timeout. A watchdog ends the run at QUIT_CDP_DEADLINE_MS
 * (default 360 s, under the batch's 420) naming the step it was in. Whatever ends the run, the cleanup runs, bounded: the
 * agents are stopped, its Electron ended, and a host it could not shut down through the quit is ended by signal.
 *
 * SAFETY: it launches Electron, so it refuses to run anywhere but a test machine — CI, the test VM (Linux user `genie`), or
 * QUIT_CDP_ALLOW=1 (the Windows VM's runner). Never on the owner's desktop.
 *
 * Exit: 0 every check passed; 1 a check failed (or a deadline was missed); 2 cannot run here.
 */
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = Date.now();
const since = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
let current = 'start';
/** Every step names itself BEFORE it acts: a hang always says where it stopped. */
function step(id, what) {
    current = `${id} ${what}`;
    console.log(`[${since()}] step ${id}: ${what}`);
}

step('0.1', 'reading the settings');
let PORT = Number(process.env.CDP_PORT ?? 9222);
let INSPECT = Number(process.env.QUIT_CDP_INSPECT ?? 9229);
const CLOSED_MS = Number(process.env.QUIT_CDP_CLOSED_MS ?? 12_000);
const DEADLINE_MS = Number(process.env.QUIT_CDP_DEADLINE_MS ?? 360_000);
const AGENTS = 3;
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
const PROOF = join(tmpdir(), `genie-quit-answer-${process.pid}.json`);
const GENIE_HOME = process.env.GENIE_HOME && process.env.GENIE_HOME.length > 0 ? process.env.GENIE_HOME : join(homedir(), '.genie');
const HOST_RECORD = join(GENIE_HOME, 'runtime', 'host.json');
const LIFECYCLE = join(GENIE_HOME, 'runtime', 'lifecycle.log');
const HOST_LOG = join(GENIE_HOME, 'logs', 'genie-host.log');
const OUT = join(process.cwd(), 'smoke-out');
const WIN = process.platform === 'win32';
/** Bounds for the process calls this script makes synchronously: none may block a run. */
const SYNC_MS = 15_000;

const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
    return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `p`, or a rejection naming what missed its deadline. */
function within(ms, what, p) {
    let t;
    return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`deadline: ${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); })])
        .finally(() => clearTimeout(t));
}
/** Retry `what` (each attempt bounded too) until it answers truthy or `ms` runs out; the last value either way. */
async function until(what, ms, interval = 500) {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
        try { last = await within(Math.max(1_000, Math.min(15_000, end - Date.now())), 'an attempt', Promise.resolve().then(what)); } catch { last = null; }
        if (last) return last;
        await sleep(interval);
    }
    return last;
}

// ---------------------------------------------------------------- the process table (the OS's word, not Genie's)
function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function commandLine(pid) {
    try {
        if (WIN) {
            return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: SYNC_MS }).trim();
        }
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch { return ''; }
}
function hostRecord() {
    try { return JSON.parse(readFileSync(HOST_RECORD, 'utf8')); } catch { return null; }
}
const readOr = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
/** Is anything answering HTTP on the port? Bounded: a port that accepts and never answers counts as busy, after 3 s. */
async function answers(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3_000) });
        return true;
    } catch (e) {
        return e?.name === 'TimeoutError' ? 'accepts but does not answer' : false;
    }
}

/**
 * Who holds a listening port, in the OS's words: `ss -ltnp` and each owner's command line (Linux; bounded). Printed when
 * the run refuses a busy port, so the next failure names the process instead of guessing (batch L3).
 */
function portOwners(port) {
    if (process.platform !== 'linux') return '(not read off Linux)';
    let ss = '';
    try { ss = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: SYNC_MS }).trim(); } catch (e) { return `ss failed: ${e.message}`; }
    const pids = [...new Set([...ss.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
    const owners = pids.map((pid) => `    pid ${pid} (ppid ${readOr(`/proc/${pid}/stat`).split(') ')[1]?.split(' ')[1] ?? '?'}): ${commandLine(pid).slice(0, 300) || '(gone)'}`);
    return [`  ss -ltnp 'sport = :${port}':`, `    ${ss || '(no listener)'}`, ...(owners.length ? ['  owners:', ...owners] : ['  owners: none visible to this user'])].join('\n');
}

// ---------------------------------------------------------------- CDP (the page) and the inspector (the window's main)
async function targetOn(port, kind, ms) {
    let last = 'no attempt';
    const found = await until(async () => {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
            const t = targets.find((x) => (kind === 'page' ? x.type === 'page' : true) && x.webSocketDebuggerUrl);
            if (!t) last = `no ${kind} yet (${targets.length} targets)`;
            return t ?? null;
        } catch (e) { last = String(e?.message ?? e); return null; }
    }, ms);
    if (!found) throw new Error(`no ${kind} on port ${port} within ${Math.round(ms / 1000)} s: ${last}`);
    return found;
}
class Cdp {
    #ws; #id = 1; #pending = new Map(); #label;
    static async connect(url, label) {
        const c = new Cdp();
        c.#label = label;
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (r) { c.#pending.delete(f.id); r(f); } });
        c.#ws.addEventListener('close', () => { for (const r of c.#pending.values()) r({ error: { message: 'socket closed' } }); c.#pending.clear(); });
        await within(15_000, `the ${label} socket`, new Promise((res, rej) => {
            c.#ws.addEventListener('open', res, { once: true });
            c.#ws.addEventListener('error', () => rej(new Error(`${label}: socket error`)), { once: true });
        }));
        return c;
    }
    send(method, params = {}, ms = 30_000) {
        const id = this.#id++;
        return within(ms, `${this.#label} ${method}`, new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); }))
            .finally(() => this.#pending.delete(id));
    }
    async evaluate(expression, ms = 30_000) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
        if (f.error) throw new Error(`${this.#label}: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`${this.#label} threw: ${f.result.exceptionDetails.exception?.description ?? f.result.exceptionDetails.text ?? '?'}`);
        return f.result.result.value;
    }
    close() { try { this.#ws.close(); } catch { /* gone */ } }
    /** Closed, and the close done (bounded): a session still attached keeps a quitting Node process waiting for it. */
    async closed(ms = 5_000) {
        if (this.#ws.readyState === WebSocket.CLOSED) return true;
        const done = new Promise((r) => this.#ws.addEventListener('close', () => r(true), { once: true }));
        this.close();
        return Promise.race([done, sleep(ms).then(() => false)]);
    }
}

// ---------------------------------------------------------------- one Genie, launched and ended by this script
function launchArgs() {
    const args = [];
    if (process.platform === 'linux') {
        args.push('--no-sandbox');
        if (process.env.XDG_SESSION_TYPE === 'x11' || process.env.XDG_SESSION_TYPE === 'wayland') args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    }
    for (const a of (process.env.QUIT_CDP_ARGS ?? '').split(/\s+/)) if (a && !args.includes(a)) args.push(a);
    return args;
}
function launch(label) {
    mkdirSync(OUT, { recursive: true });
    const log = join(OUT, `quit-keeps-host-${label}.log`);
    const out = openSync(log, 'a');
    const argv = ['electron', `--inspect=${INSPECT}`, '.', `--remote-debugging-port=${PORT}`, ...launchArgs()];
    // GENIE_TRAY_PROBE=1: main.ts's read-only tray probe exists only in a launch that asks for it (this proof's).
    const child = spawn(WIN ? 'npx.cmd' : 'npx', argv, { detached: !WIN, stdio: ['ignore', out, out], shell: WIN, windowsHide: true, env: { ...process.env, GENIE2_CODEX_BINARY: process.env.GENIE2_CODEX_BINARY || join(process.cwd(), 'scripts', 'stub-codex.mjs'), GENIE_TRAY_PROBE: '1', GENIE_PAGE_PROBE: '1' } });
    let gone = false;
    const exited = new Promise((r) => {
        child.once('exit', (code, signal) => { gone = true; r({ code, signal }); });
        child.once('error', (error) => { gone = true; r({ code: null, signal: null, error: String(error) }); });
    });
    console.log(`  launched (${label}) pid ${child.pid}: npx ${argv.join(' ')}  → ${log}`);
    return {
        log, exited,
        get gone() { return gone; },
        kill() {
            if (gone || !child.pid) return;
            try {
                if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: SYNC_MS });
                else process.kill(-child.pid, 'SIGKILL');
            } catch { /* gone */ }
        },
    };
}
/** A launch, its page and its main-process inspector. Each wait is bounded and named by the caller's step. */
async function open(label, id) {
    step(`${id}a`, `launching Genie (${label})`);
    const app = launch(label);
    const session = { app, cdp: null, inspector: null, windowPid: null };
    step(`${id}b`, `waiting for the window on the debugger port ${PORT} (≤ 90 s)`);
    const page = await targetOn(PORT, 'page', 90_000);
    session.cdp = await Cdp.connect(page.webSocketDebuggerUrl, `${label} page`);
    step(`${id}c`, 'waiting for the page to load window.genie (≤ 60 s)');
    const ready = await until(() => session.cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000);
    if (ready !== true) throw new Error(`${label}: window.genie never appeared within 60 s`);
    step(`${id}d`, `connecting to the window process's inspector on ${INSPECT} (≤ 30 s)`);
    session.inspector = await Cdp.connect((await targetOn(INSPECT, 'node', 30_000)).webSocketDebuggerUrl, `${label} inspector`);
    session.windowPid = await session.inspector.evaluate('process.pid', 10_000);
    console.log(`  window process pid ${session.windowPid}`);
    return session;
}

/**
 * The person's click, and nothing else: the dialog answers `index` and writes down what it asked; then the quit is the
 * product's own (`app.quit()` → before-quit → quitPlan → quitAnswer → runQuit). Answers whether the substitution took.
 *
 * THE INSPECTOR LETS GO BEFORE THE QUIT (batch M: both windows ended their quit and then sat on "Waiting for the debugger
 * to disconnect..." — Node keeps a process alive while a debugger session is attached, so the script's own session held
 * the window open, and the exit checks failed for the harness, not the product). The quit is deferred by a second; this
 * session is closed, and its close done, well inside it.
 */
async function answerTheQuit(inspector, index) {
    rmSync(PROOF, { force: true });
    const said = await inspector.evaluate(`(() => {
        const module = process.getBuiltinModule && process.getBuiltinModule('node:module');
        if (!module) return 'no process.getBuiltinModule in this Electron';
        const require = module.createRequire(process.execPath);
        const { app, dialog } = require('electron');
        const fs = require('node:fs');
        const click = (...args) => {
            const options = args.find((a) => a && typeof a === 'object' && Array.isArray(a.buttons)) ?? {};
            fs.writeFileSync(${JSON.stringify(PROOF)}, JSON.stringify({ buttons: options.buttons ?? null, message: options.message ?? null, answered: ${index} }));
            return ${index};
        };
        dialog.showMessageBoxSync = click;
        if (require('electron').dialog.showMessageBoxSync !== click) return 'the dialog could not be answered (the substitution did not take)';
        setTimeout(() => app.quit(), 1000);
        return 'ok';
    })()`, 10_000);
    const detached = await inspector.closed(5_000);
    console.log(`  the inspector session ${detached ? 'is closed' : 'did NOT close within 5 s'} before the quit`);
    return said;
}
const asked = () => { try { return JSON.parse(readFileSync(PROOF, 'utf8')); } catch { return null; } };
const exitWithin = (app, ms) => Promise.race([app.exited, sleep(ms).then(() => null)]);
/**
 * Why a window did not exit: Node's own words when a debugger session holds it (then it is this harness, not Genie), or
 * the product's — named either way, from the window's log.
 */
function whyStillRunning(app) {
    const tail = readOr(app.log).split('\n').slice(-20).join('\n');
    return /Waiting for the debugger to disconnect/.test(tail)
        ? 'still running after 60 s, HELD BY A DEBUGGER SESSION ("Waiting for the debugger to disconnect...") — the harness, not the product'
        : 'still running after 60 s (no debugger hold in its log: the product did not exit)';
}

// ---------------------------------------------------------------- the tray-only Genie, read over the main process's inspector
/** How many windows the window process has now. */
const windowsIn = (inspector) => inspector.evaluate(`(() => {
    const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
    return require('electron').BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length;
})()`, 10_000);
/** The tray, as main.ts's read-only probe says it (Electron's Tray cannot be asked): present, tooltip, menu labels. */
const trayState = (inspector) => inspector.evaluate(`(() => {
    const t = globalThis[Symbol.for('genie.tray')];
    return t ? { present: t.present(), tooltip: t.tooltip(), labels: t.labels() } : null;
})()`, 10_000).catch(() => null);
/** A tray menu item's own click, after `delayMs` (so an inspector session can let go first). 'ok' when the item is there. */
const trayClick = (inspector, label, delayMs) => inspector.evaluate(`(() => {
    const t = globalThis[Symbol.for('genie.tray')];
    if (!t) return 'no tray probe in this build';
    if (!t.labels().includes(${JSON.stringify(label)})) return 'the tray offers no ' + ${JSON.stringify(label)} + ': ' + JSON.stringify(t.labels());
    setTimeout(() => t.click(${JSON.stringify(label)}), ${delayMs});
    return 'ok';
})()`, 10_000).catch((e) => String(e?.message ?? e));
/**
 * The person's answer to the NEXT native question (the tray's "always ask"), and nothing else: the dialog answers `index`
 * and writes down what it asked, then puts itself back. No quit is started here — the tray item's own handler does that.
 */
async function answerNextDialog(inspector, index) {
    rmSync(PROOF, { force: true });
    return inspector.evaluate(`(() => {
        const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
        const { dialog } = require('electron');
        const fs = require('node:fs');
        const real = dialog.showMessageBoxSync;
        const click = (...args) => {
            const options = args.find((a) => a && typeof a === 'object' && Array.isArray(a.buttons)) ?? {};
            fs.writeFileSync(${JSON.stringify(PROOF)}, JSON.stringify({ title: options.title ?? null, buttons: options.buttons ?? null, message: options.message ?? null, answered: ${index} }));
            dialog.showMessageBoxSync = real;
            return ${index};
        };
        dialog.showMessageBoxSync = click;
        return require('electron').dialog.showMessageBoxSync === click ? 'ok' : 'the dialog could not be answered (the substitution did not take)';
    })()`, 10_000).catch((e) => String(e?.message ?? e));
}

/** Is there a page on the debugger port now? (Bounded.) */
async function pageOn(port) {
    try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
        return targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { return false; }
}
/** The window built again in the SAME process: its new page, its inspector (the same one), its pid. */
async function reopened(first, label, id) {
    step(`${id}w`, `waiting for the window to come back on the debugger port ${PORT} (≤ 60 s)`);
    const page = await targetOn(PORT, 'page', 60_000);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl, `${label} page`);
    const ready = await until(() => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000);
    if (ready !== true) throw new Error(`${label}: window.genie never appeared within 60 s`);
    const inspector = first.inspector ?? await Cdp.connect((await targetOn(INSPECT, 'node', 15_000)).webSocketDebuggerUrl, `${label} inspector`);
    const windowPid = await inspector.evaluate('process.pid', 10_000);
    return { app: first.app, cdp, inspector, windowPid };
}
/** A second launch, as a person makes one: it hands over through the single-instance lock and exits. */
function launchSecond() {
    mkdirSync(OUT, { recursive: true });
    const out = openSync(join(OUT, 'quit-keeps-host-second-launch.log'), 'a');
    const child = spawn(WIN ? 'npx.cmd' : 'npx', ['electron', '.', ...launchArgs()], { stdio: ['ignore', out, out], shell: WIN, windowsHide: true });
    return new Promise((r) => { child.once('exit', (code, signal) => r({ code, signal })); child.once('error', (e) => r({ error: String(e) })); });
}

// ---------------------------------------------------------------- the ledger's word: which pid streams, up to which tick
async function ticksOf(cdp, agentId) {
    const json = await cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(agentId)}).then((d) => JSON.stringify({ running: d?.session?.running ?? null, rows: d?.rows ?? [] }))`, 10_000);
    const detail = JSON.parse(json);
    const text = JSON.stringify(detail.rows);
    const ticks = new Map();
    for (const m of text.matchAll(/tick (\d+) pid (\d+)/g)) ticks.set(Number(m[1]), Number(m[2]));
    const pids = [...new Set(ticks.values())];
    const max = ticks.size === 0 ? 0 : Math.max(...ticks.keys());
    return { running: detail.running, ticks, pids, max, size: text.length };
}
const contiguous = (ticks, from, to) => { for (let n = from; n <= to; n++) if (!ticks.has(n)) return n; return null; };

// ---------------------------------------------------------------- cleanup: bounded, whatever ended the run
let a = null;
let b = null;
const agents = [];
let hostPid = null;
let shutDownProven = false;
let cleaned = false;
async function cleanup(why) {
    if (cleaned) return;
    cleaned = true;
    console.log(`[${since()}] cleanup (${why})`);
    rmSync(TICKER, { force: true });
    if (!shutDownProven) {
        // The agents first, through the product, while a window is there to ask (bounded per agent).
        for (const s of [b, a]) {
            if (!s?.cdp || s.app.gone) continue;
            for (const ag of agents) {
                try { await s.cdp.evaluate(`window.genie.stopAgent(${JSON.stringify(ag.id)}); true`, 5_000); console.log(`  stopped ${ag.name}`); } catch (e) { console.log(`  could not stop ${ag.name}: ${e.message}`); }
            }
            break;
        }
    }
    for (const s of [a, b]) {
        if (!s) continue;
        s.cdp?.close(); s.inspector?.close();
        s.app.kill();
    }
    if (!shutDownProven) {
        // A host this run could not end through "Shut down everything" is ended by signal: SIGTERM (its graceful shutdown,
        // which stops its sessions), then SIGKILL; then any provider of ours still standing.
        if (alive(hostPid)) {
            console.log(`  ending the host pid ${hostPid} (SIGTERM, then SIGKILL after 15 s)`);
            try { process.kill(hostPid, 'SIGTERM'); } catch { /* gone */ }
            for (let i = 0; i < 30 && alive(hostPid); i++) await sleep(500);
            if (alive(hostPid)) { try { process.kill(hostPid, 'SIGKILL'); } catch { /* gone */ } }
            console.log(`  host pid ${hostPid}: ${alive(hostPid) ? 'STILL ALIVE' : 'gone'}`);
        }
        for (const ag of agents) if (alive(ag.pid)) { try { process.kill(ag.pid, 'SIGKILL'); console.log(`  ended provider pid ${ag.pid}`); } catch { /* gone */ } }
    }
    rmSync(PROOF, { force: true });
}
function finish() {
    if (failures.length) {
        console.log(`\nQUIT-KEEPS-HOST FAILED — ${failures.length} check(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
        for (const label of ['first', 'second']) {
            const log = join(OUT, `quit-keeps-host-${label}.log`);
            if (existsSync(log)) { console.log(`\n--- ${log} (last 40 lines) ---`); console.log(readOr(log).split('\n').slice(-40).join('\n')); }
        }
        // Where the window's boot stopped: batch SS on Windows had a window process with DevTools up and no page for 90 s.
        for (const log of [LIFECYCLE, HOST_LOG]) {
            if (existsSync(log)) { console.log(`\n--- ${log} (last 60 lines) ---`); console.log(readOr(log).split('\n').slice(-60).join('\n')); }
        }
        process.exit(1);
    }
    console.log(`\n[${since()}] QUIT KEEPS THE HOST — measured: the UI closed and opened again over the same host and providers, every tick kept; "Shut down everything" ended them.`);
    process.exit(0);
}
function refuse(why) {
    console.error(`quit-keeps-host: CANNOT RUN — ${why}`);
    process.exit(2);
}

// ================================================================================================================ run
// THE WATCHDOG: a promise nothing settles would otherwise hold the run until the batch's `timeout` kills it, silently.
const watchdog = setTimeout(() => {
    check(false, `WATCHDOG: the run passed ${Math.round(DEADLINE_MS / 1000)} s`, `stuck in step ${current}`);
    setTimeout(() => { console.log('  cleanup did not finish within 60 s; exiting'); process.exit(1); }, 60_000).unref();
    void cleanup('watchdog').finally(finish);
}, DEADLINE_MS);

step('0.2', 'is this a test machine? (CI, user genie, or QUIT_CDP_ALLOW=1)');
const user = process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '';
const testMachine = process.env.CI === 'true' || process.env.QUIT_CDP_ALLOW === '1' || (process.platform === 'linux' && user === 'genie');
if (!testMachine) refuse(`it launches Electron, so it runs only on a test machine (CI, the test VM as user \`genie\`, or QUIT_CDP_ALLOW=1); user is "${user}"`);
step('0.3', `is this the root of a Genie tree? (${process.cwd()})`);
if (!existsSync('package.json') || !existsSync('scripts/stub-codex.mjs')) refuse(`run it from the root of a built Genie tree (${process.cwd()})`);
/**
 * A port the previous Genie should have let go of (batch L3: 9222 "accepts but does not answer" right after vm-smoke ended
 * its window). Named — `ss` and each owner's command line — given 30 s to come free (a window still dying), named again,
 * and if it is STILL held: a failed check (someone holds a dead Genie's port, which is a finding of its own), and this run
 * carries on, on the first free port above, so the same batch still measures what this script is for.
 */
async function freePort(port, label, id) {
    step(id, `is the ${label} port ${port} free? (≤ 3 s)`);
    const busy = await answers(port);
    if (!busy) return port;
    console.log(`  the ${label} port ${port} is held (${busy === true ? 'it answers' : busy}):`);
    console.log(portOwners(port));
    step(`${id}w`, `waiting for the ${label} port ${port} to come free (≤ 30 s)`);
    const freed = await until(async () => !(await answers(port)), 30_000, 1_000);
    if (freed) { console.log(`  the ${label} port ${port} came free`); return port; }
    console.log(`  STILL held after 30 s:`);
    console.log(portOwners(port));
    check(false, `${id}. the ${label} port ${port} is still held after the previous Genie ended (its holder is named above)`);
    for (let p = port + 100; p < port + 200; p++) if (!(await answers(p))) { console.log(`  this run uses the ${label} port ${p} instead`); return p; }
    refuse(`no free ${label} port in ${port + 100}..${port + 199}`);
}
PORT = await freePort(PORT, 'debugger', '0.4');
INSPECT = await freePort(INSPECT, 'inspector', '0.5');

console.log(`\nQUIT KEEPS THE HOST — "Just close the UI" with agents streaming, then open Genie again (deadline ${Math.round(DEADLINE_MS / 1000)} s)\n`);
step('0.6', `the ticker marker, holding this script's pid ${process.pid}`);
writeFileSync(TICKER, String(process.pid));
let cannot = null;
/** Failures from before the run (a held port, 0.4/0.5) are reported, never mistaken for the run's own controls failing. */
const failuresBeforeRun = failures.length;
try {
    // -------------------------------------------------------------------------------- A: three agents streaming
    a = await open('first', 1);
    step('1e', 'reading the seed: its first workspace');
    const snap = await a.cdp.evaluate('window.genie.snapshot()', 15_000);
    const workspaceId = snap.workspaces?.[0]?.id ?? null;
    if (typeof workspaceId !== 'string') { cannot = 'no workspace in the seed (run smoke-seed.mjs first)'; throw new Error(cannot); }
    for (let i = 1; i <= AGENTS; i++) {
        const name = `ticker-${i}-${process.pid}`;
        step(`1.${i}`, `adding the codex agent ${name}`);
        const added = await a.cdp.evaluate(`window.genie.addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'Streams ticks for the quit check.', provider: 'codex' })`, 30_000);
        if (check(added?.ok === true, `1.${i} agent ${name} added`, added?.ok ? added.id : added?.reason)) agents.push({ id: added.id, name });
    }
    for (const ag of agents) {
        step('2', `starting ${ag.name} (≤ 30 s to running)`);
        await waitForPageProbe(a.cdp);
        await a.cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(ag.id)}, "graceful"); true`, 15_000);
        const running = await until(() => a.cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(ag.id)}).then((d) => d?.session?.running === true)`, 5_000), 30_000);
        check(running === true, `2. ${ag.name}'s session is running`);
        step('3', `prompting ${ag.name}`);
        const sent = await a.cdp.evaluate(`window.genie.prompt(${JSON.stringify(ag.id)}, 'Stream ticks until stopped.')`, 15_000);
        check(sent?.ok === true, `3. ${ag.name} took the prompt`, sent?.reason ?? '');
    }
    for (const ag of agents) {
        step('4', `waiting for ${ag.name}'s ledger to stream 8 ticks (≤ 30 s)`);
        const t = await until(async () => { const x = await ticksOf(a.cdp, ag.id); return x.max >= 8 ? x : null; }, 30_000);
        ag.before = t ?? await ticksOf(a.cdp, ag.id);
        ag.pid = ag.before.pids.length === 1 ? ag.before.pids[0] : null;
        check(ag.pid !== null, `4. ${ag.name}'s ledger is streaming, from ONE provider pid`, `ticks to ${ag.before.max}, pids ${JSON.stringify(ag.before.pids)}`);
    }

    // POSITIVE CONTROL: the pids read above are real, live, and what they say they are — before anything is closed.
    step('5', `positive control: host.json (${HOST_RECORD}) and the process table`);
    hostPid = hostRecord()?.pid ?? null;
    check(alive(hostPid) && /host\.js/.test(commandLine(hostPid)), '5. CONTROL: host.json names a LIVE genie-host process', `pid ${hostPid}: ${commandLine(hostPid).slice(0, 160)}`);
    check(hostPid !== a.windowPid && alive(a.windowPid), '6. CONTROL: the host is not the window process (both live)', `host ${hostPid}, window ${a.windowPid}`);
    const pids = agents.map((ag) => ag.pid);
    check(new Set(pids).size === AGENTS, '7. CONTROL: three DIFFERENT provider pids', JSON.stringify(pids));
    for (const ag of agents) check(alive(ag.pid) && /stub-codex/.test(commandLine(ag.pid)), `8. CONTROL: ${ag.name}'s provider pid ${ag.pid} is a LIVE stub-codex process`, commandLine(ag.pid).slice(0, 120));
    for (const ag of agents) {
        step('9', `positive control: ${ag.name} is streaming NOW (≤ 10 s)`);
        const later = await until(async () => { const x = await ticksOf(a.cdp, ag.id); return x.max > ag.before.max ? x : null; }, 10_000);
        check(later !== null && later.pids.length === 1 && later.pids[0] === ag.pid, `9. CONTROL: ${ag.name} is streaming NOW (its ledger grew within seconds, same pid)`, `${ag.before.max} → ${later?.max}`);
        ag.before = later ?? ag.before;
    }
    // Only THIS run's setup and controls gate what follows. A port finding at 0.4/0.5 is its own failed check and the run
    // carries on past it on a free port (batch L4 aborted here on it, with every control passing).
    const controlFailures = failures.slice(failuresBeforeRun);
    if (controlFailures.length) throw new Error(`the controls failed (${controlFailures.join('; ')}): nothing after them could mean anything`);

    // A TERMINAL, with "Keep terminals through a quit" ON (genie#1508: from reading, that setting decides nothing with a host).
    step('9t', 'the setting on, and a terminal open');
    await a.cdp.evaluate(`window.genie.features.act({ kind: 'settings.set', key: 'detached_terminals', value: true }).then(() => true)`, 15_000);
    const terminal = await a.cdp.evaluate(`window.genie.terminals.open(${JSON.stringify(workspaceId)}, {}).then((t) => ({ id: t.id, pid: t.pid }))`, 30_000);
    check(alive(terminal?.pid), '9t. CONTROL: a terminal is open, its pid alive', JSON.stringify(terminal));

    // -------------------------------------------------------------------------------- "Just close the UI": the tray stays
    // The logs are read from HERE on: an older line must not answer for this run.
    let lifecycleAt = readOr(LIFECYCLE).length;
    step('10', 'answering the quit "Just close the UI" (button 1)');
    const took = await answerTheQuit(a.inspector, 1);
    check(took === 'ok', '10. the quit is answered by button 1 (the person\'s click, substituted)', String(took));
    // The window process stays (the tray): a new inspector session on the same process.
    a.inspector = await Cdp.connect((await targetOn(INSPECT, 'node', 15_000)).webSocketDebuggerUrl, 'first inspector (tray)');
    step('11', 'waiting for every window to close while the window process lives (≤ 30 s)');
    const closed = await until(async () => (await windowsIn(a.inspector)) === 0 ? true : null, 30_000);
    check(closed === true && !a.app.gone && alive(a.windowPid), '11. the UI closed: no window, and the window process ALIVE (Genie stays in the tray)', `windows ${await windowsIn(a.inspector).catch(() => '?')}, process ${a.windowPid} ${alive(a.windowPid) ? 'alive' : 'GONE'}`);
    const q = asked();
    check(JSON.stringify(q?.buttons) === JSON.stringify(['Cancel', 'Just close the UI', 'Shut down everything']), '12. the quit ASKED the two answers, and button 1 was "Just close the UI"', JSON.stringify(q));
    const t1 = await trayState(a.inspector);
    // At least this run's agents (an earlier smoke step may have left its own agent running too).
    const runningSaid = Number(/host running: (\d+) agents?/.exec(t1?.tooltip ?? '')?.[1] ?? 0);
    check(t1?.present === true && runningSaid >= AGENTS && ['Open Genie', 'Restart', 'Shut down everything'].every((l) => t1.labels.includes(l)) && !t1.labels.includes('Just close the UI'),
        '13. the TRAY is there, says the host runs the agents, and offers Open Genie, Restart, Shut down everything (no "Just close the UI")', JSON.stringify(t1));
    a.cdp.close();

    // -------------------------------------------------------------------------------- tray only
    step('14', `tray only: waiting ${Math.round(CLOSED_MS / 1000)} s`);
    await sleep(CLOSED_MS);
    check(alive(hostPid), `14. with NO window for ${Math.round(CLOSED_MS / 1000)} s, the host is alive`, `pid ${hostPid}`);
    for (const ag of agents) check(alive(ag.pid), `15. with no window, ${ag.name}'s provider is alive`, `pid ${ag.pid}`);
    check(/ui closed \(the quit’s answer\): Genie stays in the tray/.test(readOr(LIFECYCLE).slice(lifecycleAt)), '16. the window process said so (lifecycle log)', LIFECYCLE);
    check(!(await pageOn(PORT)), '17. no page on the debugger port while tray-only (the window really went)');

    // -------------------------------------------------------------------------------- Open Genie, from the tray
    lifecycleAt = readOr(LIFECYCLE).length;
    step('18', 'Open Genie from the tray: the window built again in the SAME process (≤ 60 s)');
    check(await trayClick(a.inspector, 'Open Genie', 0) === 'ok', '18a. the tray\'s Open Genie was clicked (its own handler)');
    b = await reopened(a, 'second', 18);
    check(b.windowPid === a.windowPid, '18. the window came back in the SAME window process (no second Genie)', `${a.windowPid} → ${b.windowPid}`);
    check(hostRecord()?.pid === hostPid, '19. the SAME host pid (host.json)', `${hostPid} → ${hostRecord()?.pid}`);
    check(/window built again \(tray: Open\): the same host/.test(readOr(LIFECYCLE).slice(lifecycleAt)), '19b. the window process built it again for the tray\'s Open (lifecycle log)');
    for (const ag of agents) {
        step('20', `${ag.name} after the reopen: its ledger past tick ${ag.before.max} (≤ 30 s)`);
        const after = await until(async () => { const x = await ticksOf(b.cdp, ag.id); return x.max > ag.before.max ? x : null; }, 30_000) ?? await ticksOf(b.cdp, ag.id);
        check(after.running === true, `20. ${ag.name} is still running`, String(after.running));
        check(after.pids.length === 1 && after.pids[0] === ag.pid && alive(ag.pid), `21. ${ag.name}: the SAME provider pid, alive`, `${ag.pid} → ${JSON.stringify(after.pids)}`);
        const closedTicks = Math.floor(CLOSED_MS / 250 / 2);
        check(after.max - ag.before.max >= closedTicks && after.size > ag.before.size, `22. ${ag.name}'s ledger GREW across the close`, `ticks ${ag.before.max} → ${after.max} (≥ ${closedTicks} wanted), ${ag.before.size} → ${after.size} bytes`);
        const gap = contiguous(after.ticks, ag.before.max + 1, after.max);
        check(gap === null, `23. ${ag.name}: every tick streamed while no window was open is in the ledger, in order`, gap === null ? `${ag.before.max + 1}..${after.max}` : `tick ${gap} missing`);
    }

    step('23t', 'the terminal after the reopen');
    const terminalsAfter = await b.cdp.evaluate(`window.genie.terminals.list(${JSON.stringify(workspaceId)}).then((l) => l.map((t) => ({ id: t.id, pid: t.pid })))`, 15_000);
    check(alive(terminal.pid) && terminalsAfter.some((t) => t.id === terminal.id && t.pid === terminal.pid), '23t. "Just close the UI" keeps the terminal: the same id and pid after the reopen', JSON.stringify(terminalsAfter));

    // -------------------------------------------------------------------------------- tray-only again, then a SECOND LAUNCH
    step('24', 'Just close the UI from the tray, then launch Genie again: the window comes back in the same process (≤ 60 s)');
    check(await trayClick(b.inspector, 'Just close the UI', 0) === 'ok', '24a. the tray\'s Just close the UI was clicked');
    const closedAgain = await until(async () => (await windowsIn(b.inspector)) === 0 ? true : null, 30_000);
    check(closedAgain === true && alive(a.windowPid), '24. the UI closed again from the tray; the window process alive');
    b.cdp.close();
    lifecycleAt = readOr(LIFECYCLE).length;
    const second = launchSecond();
    const secondExit = await Promise.race([second, sleep(30_000).then(() => null)]);
    check(secondExit !== null, '25a. the second launch handed over and exited (the single-instance lock)', JSON.stringify(secondExit));
    const c = await reopened(a, 'third', 25);
    check(c.windowPid === a.windowPid, '25. a second launch built the window again in the SAME process', `${a.windowPid} → ${c.windowPid}`);
    check(/window built again \(second launch\): the same host/.test(readOr(LIFECYCLE).slice(lifecycleAt)), '25b. for the second launch (lifecycle log)');
    c.cdp.close();
    b.cdp = null;

    // -------------------------------------------------------------------------------- Shut down everything, from the tray
    // ALWAYS ASK (the owner, 2026-11-02): the tray's Shut down everything confirms first. Cancel first — nothing may stop.
    step('26c', 'the tray\'s Shut down everything ASKS; Cancel (button 0) does nothing');
    check(await answerNextDialog(c.inspector, 0) === 'ok', '26c. the next dialog will be answered Cancel');
    check(await trayClick(c.inspector, 'Shut down everything', 0) === 'ok', '26d. the tray\'s Shut down everything was clicked');
    const cancelAsked = await until(() => asked(), 10_000);
    check(JSON.stringify(cancelAsked?.buttons) === JSON.stringify(['Cancel', 'Shut down everything']) && agents.every((ag) => (cancelAsked?.message ?? '').includes(ag.name)),
        '26e. it ASKED, naming what would stop (this run\'s agents among them), with Cancel and "Shut down everything"', JSON.stringify(cancelAsked));
    await sleep(3_000);
    check(!a.app.gone && alive(a.windowPid) && alive(hostPid) && agents.every((ag) => alive(ag.pid)), '26f. Cancel stopped NOTHING: the window process, the host and the providers all alive');
    step('26', 'Shut down everything from the tray, confirmed (button 1); then wait for the window process to exit (≤ 60 s)');
    check(await answerNextDialog(c.inspector, 1) === 'ok', '26g. the next dialog will be answered Shut down everything');
    check(await trayClick(c.inspector, 'Shut down everything', 1_000) === 'ok', '26a. the tray\'s Shut down everything was clicked');
    // The inspector session lets go before the quit (batch M: an attached session holds a quitting Node process).
    await c.inspector.closed(5_000);
    a.inspector = null; b.inspector = null;
    const exit = await exitWithin(a.app, 60_000);
    check(exit !== null, '26. the window process EXITED', exit ? `code ${exit.code}` : whyStillRunning(a.app));
    step('27', `waiting for the host pid ${hostPid} to end (≤ 30 s)`);
    const hostGone = await until(() => !alive(hostPid), 30_000);
    check(hostGone === true, '27. "Shut down everything" ENDED the host', `pid ${hostPid}`);
    for (const ag of agents) {
        step('28', `waiting for ${ag.name}'s provider pid ${ag.pid} to end (≤ 30 s)`);
        const gone = await until(() => !alive(ag.pid), 30_000);
        check(gone === true, `28. and ${ag.name}'s provider (the same gauge reading it dead now)`, `pid ${ag.pid}`);
    }
    // What the setting is measured by: on, and a real quit. Alive here would mean it keeps them; ended means it decides nothing.
    step('28t', `waiting for the terminal's pid ${terminal.pid} to end, the setting on (≤ 30 s)`);
    const terminalGone = await until(() => !alive(terminal.pid), 30_000);
    check(terminalGone === true, '28t. "Shut down everything" ends the terminal even with "Keep terminals through a quit" on (genie#1508)', `pid ${terminal.pid}`);
    shutDownProven = hostGone === true;
} catch (error) {
    if (cannot === null) check(false, `the run stopped in step ${current}`, String(error?.message ?? error));
}
clearTimeout(watchdog);
await cleanup(failures.length || cannot ? 'after a failure' : 'done');
if (cannot !== null && failures.length === 0) refuse(cannot);
finish();

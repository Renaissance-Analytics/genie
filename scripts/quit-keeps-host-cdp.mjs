#!/usr/bin/env node
/**
 * QUIT KEEPS THE HOST (the host split P1b, genie#1451) — measured on the REAL app with a REAL process table.
 *
 *   node scripts/quit-keeps-host-cdp.mjs
 *
 * Three agents stream, the person answers the quit "Just close the UI", Genie is opened again, and:
 *   the SAME genie-host pid, the SAME provider pid per agent, and every ledger has grown — with every tick the providers
 *   streamed while no window was open, in order. Then "Shut down everything": the host and the providers are gone.
 *
 * HOW IT RUNS. It launches Genie itself, twice (the UI is closed in between, so the launch cannot be the caller's), from the
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
 * — and calls `app.quit()`. Everything after the click is the product's own: before-quit, quitPlan, quitAnswer, runQuit,
 * engine.leaveRunning. What the dialog was asked is checked, so a two-answer question (no host) cannot pass.
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
    const child = spawn(WIN ? 'npx.cmd' : 'npx', argv, { detached: !WIN, stdio: ['ignore', out, out], shell: WIN, windowsHide: true });
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
 */
async function answerTheQuit(inspector, index) {
    rmSync(PROOF, { force: true });
    return inspector.evaluate(`(() => {
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
        setTimeout(() => app.quit(), 100);
        return 'ok';
    })()`, 10_000);
}
const asked = () => { try { return JSON.parse(readFileSync(PROOF, 'utf8')); } catch { return null; } };
const exitWithin = (app, ms) => Promise.race([app.exited, sleep(ms).then(() => null)]);

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
        await a.cdp.evaluate(`window.genie.agents.restart(${JSON.stringify(ag.id)}, "graceful"); true`, 15_000);
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
    if (failures.length) throw new Error('the controls failed: nothing after them could mean anything');

    // -------------------------------------------------------------------------------- "Just close the UI"
    // The logs are read from HERE on: an older line (an earlier launch's adopt of the same host) must not answer for this one.
    const hostLogAt = readOr(HOST_LOG).length;
    const lifecycleAt = readOr(LIFECYCLE).length;
    step('10', 'answering the quit "Just close the UI" (button 1)');
    const took = await answerTheQuit(a.inspector, 1);
    check(took === 'ok', '10. the quit is answered by button 1 (the person\'s click, substituted)', String(took));
    step('11', 'waiting for the window process to exit (≤ 60 s)');
    const exit = await exitWithin(a.app, 60_000);
    check(exit !== null, '11. the UI closed: the window process exited', exit ? `code ${exit.code} signal ${exit.signal}` : 'still running after 60 s');
    const q = asked();
    check(JSON.stringify(q?.buttons) === JSON.stringify(['Cancel', 'Just close the UI', 'Shut down everything']), '12. the quit ASKED the two answers, and button 1 was "Just close the UI"', JSON.stringify(q));
    check(!alive(a.windowPid), '13. the window process is gone (the OS says so)', `pid ${a.windowPid}`);
    a.cdp.close(); a.inspector.close();

    // -------------------------------------------------------------------------------- no window open
    step('14', `no window open: waiting ${Math.round(CLOSED_MS / 1000)} s`);
    await sleep(CLOSED_MS);
    check(alive(hostPid), `14. with NO window for ${Math.round(CLOSED_MS / 1000)} s, the host is alive`, `pid ${hostPid}`);
    for (const ag of agents) check(alive(ag.pid), `15. with no window, ${ag.name}'s provider is alive`, `pid ${ag.pid}`);
    check(/left running: a window closed and kept this host/.test(readOr(HOST_LOG).slice(hostLogAt)), '16. the host heard it was left running (its own log)', HOST_LOG);
    check(/agent host left running: the UI closed/.test(readOr(LIFECYCLE).slice(lifecycleAt)), '17. the window let go saying so (lifecycle log)', LIFECYCLE);

    // -------------------------------------------------------------------------------- open Genie again
    const reopenAt = readOr(LIFECYCLE).length;
    b = await open('second', 18);
    check(hostRecord()?.pid === hostPid, '18. the SAME host pid (host.json)', `${hostPid} → ${hostRecord()?.pid}`);
    check(readOr(LIFECYCLE).slice(reopenAt).includes(`agent host adopted pid=${hostPid} `), '19. the new window ADOPTED that host (lifecycle log)', `adopted pid=${hostPid}`);
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

    // -------------------------------------------------------------------------------- "Shut down everything" (the other answer)
    step('24', 'answering the quit "Shut down everything" (button 2)');
    const took2 = await answerTheQuit(b.inspector, 2);
    check(took2 === 'ok', '24. the quit is answered by button 2', String(took2));
    step('25', 'waiting for the window process to exit (≤ 60 s)');
    const exit2 = await exitWithin(b.app, 60_000);
    check(exit2 !== null, '25. the window process exited', exit2 ? `code ${exit2.code}` : 'still running after 60 s');
    const q2 = asked();
    check(JSON.stringify(q2?.buttons) === JSON.stringify(['Cancel', 'Just close the UI', 'Shut down everything']), '26. it asked the two answers; button 2 was "Shut down everything"', JSON.stringify(q2));
    step('27', `waiting for the host pid ${hostPid} to end (≤ 30 s)`);
    const hostGone = await until(() => !alive(hostPid), 30_000);
    check(hostGone === true, '27. "Shut down everything" ENDED the host', `pid ${hostPid}`);
    for (const ag of agents) {
        step('28', `waiting for ${ag.name}'s provider pid ${ag.pid} to end (≤ 30 s)`);
        const gone = await until(() => !alive(ag.pid), 30_000);
        check(gone === true, `28. and ${ag.name}'s provider (the same gauge reading it dead now)`, `pid ${ag.pid}`);
    }
    shutDownProven = hostGone === true;
} catch (error) {
    if (cannot === null) check(false, `the run stopped in step ${current}`, String(error?.message ?? error));
}
clearTimeout(watchdog);
await cleanup(failures.length || cannot ? 'after a failure' : 'done');
if (cannot !== null && failures.length === 0) refuse(cannot);
finish();

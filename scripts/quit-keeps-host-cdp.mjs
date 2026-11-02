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
 * when that is x11 or wayland (vm-smoke exports it), anything else in QUIT_CDP_ARGS. Providers are the stub app server
 * (scripts/stub-codex.mjs) in its TICKER mode — `tick <n> pid <pid>` four times a second, so each agent's ledger names the
 * process streaming for it — switched on by a marker file this script creates and removes.
 *
 * HOW IT ANSWERS THE QUIT. The question is a native dialog CDP cannot click. The WINDOW process is launched with
 * `--inspect` (a Node flag, like `--remote-debugging-port` a launch flag and nothing in src/; the host is spawned without
 * it). Over that inspector the script replaces the person's CLICK — `dialog.showMessageBoxSync` answers a button index and
 * writes down what it was asked — and calls `app.quit()`. Everything after the click is the product's own: before-quit,
 * quitPlan, quitAnswer, runQuit, engine.leaveRunning. What the dialog was asked is checked, so a two-answer question (no
 * host) can never pass as "Just close the UI".
 *
 * SAFETY: it launches Electron, so it refuses to run anywhere but a test machine — CI, the test VM (Linux user `genie`), or
 * QUIT_CDP_ALLOW=1 (the Windows VM's runner). Never on the owner's desktop. Its Electron runs in its own process group and
 * is ended by it; on success the host is ended by "Shut down everything", the second half of the proof.
 *
 * Exit: 0 every check passed; 1 a check failed; 2 cannot run here (not a test machine, a Genie already on the port, no
 * seeded workspace).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.CDP_PORT ?? 9222);
const INSPECT = Number(process.env.QUIT_CDP_INSPECT ?? 9229);
const CLOSED_MS = Number(process.env.QUIT_CDP_CLOSED_MS ?? 12_000);
const AGENTS = 3;
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
const PROOF = join(tmpdir(), `genie-quit-answer-${process.pid}.json`);
const GENIE_HOME = process.env.GENIE_HOME && process.env.GENIE_HOME.length > 0 ? process.env.GENIE_HOME : join(homedir(), '.genie');
const HOST_RECORD = join(GENIE_HOME, 'runtime', 'host.json');
const LIFECYCLE = join(GENIE_HOME, 'runtime', 'lifecycle.log');
const HOST_LOG = join(GENIE_HOME, 'logs', 'genie-host.log');
const OUT = join(process.cwd(), 'smoke-out');
const WIN = process.platform === 'win32';

const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
    return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, ms, step = 500) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        last = await what();
        if (last) return last;
        await sleep(step);
    }
    return last;
}
function refuse(why) {
    console.error(`quit-keeps-host: CANNOT RUN — ${why}`);
    process.exit(2);
}

// ---------------------------------------------------------------- the process table (the OS's word, not Genie's)
function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function commandLine(pid) {
    try {
        if (WIN) {
            return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 30_000 }).trim();
        }
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch { return ''; }
}
function hostRecord() {
    try { return JSON.parse(readFileSync(HOST_RECORD, 'utf8')); } catch { return null; }
}
const readOr = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

// ---------------------------------------------------------------- CDP (the page) and the inspector (the window's main)
async function targetOn(port, kind, ms = 60_000) {
    let last = 'no attempt';
    const found = await until(async () => {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const t = targets.find((x) => (kind === 'page' ? x.type === 'page' : true) && x.webSocketDebuggerUrl);
            if (!t) last = `no ${kind} yet (${targets.length})`;
            return t ?? null;
        } catch (e) { last = String(e); return null; }
    }, ms);
    if (!found) throw new Error(`nothing on port ${port}: ${last}`);
    return found;
}
class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (r) { c.#pending.delete(f.id); r(f); } });
        c.#ws.addEventListener('close', () => { for (const r of c.#pending.values()) r({ error: { message: 'socket closed' } }); c.#pending.clear(); });
        await new Promise((res, rej) => {
            c.#ws.addEventListener('open', res, { once: true });
            c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true });
        });
        return c;
    }
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); });
    }
    async evaluate(expression) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (f.error) throw new Error(`CDP: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`threw: ${f.result.exceptionDetails.exception?.description ?? f.result.exceptionDetails.text ?? '?'}`);
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
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    let gone = false;
    void exited.then(() => { gone = true; });
    console.log(`  launched (${label}): npx ${argv.join(' ')}  → ${log}`);
    return {
        child, log, exited,
        get gone() { return gone; },
        kill() {
            if (gone) return;
            try {
                if (WIN) execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
                else process.kill(-child.pid, 'SIGKILL');
            } catch { /* gone */ }
        },
    };
}
async function open(label) {
    const app = launch(label);
    const page = await targetOn(PORT, 'page');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until(() => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"').catch(() => false), 60_000);
    const inspector = await Cdp.connect((await targetOn(INSPECT, 'node')).webSocketDebuggerUrl);
    const windowPid = await inspector.evaluate('process.pid');
    return { app, cdp, inspector, windowPid };
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
    })()`);
}
const asked = () => { try { return JSON.parse(readFileSync(PROOF, 'utf8')); } catch { return null; } };

// ---------------------------------------------------------------- the ledger's word: which pid streams, up to which tick
async function ticksOf(cdp, agentId) {
    const json = await cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(agentId)}).then((d) => JSON.stringify({ running: d?.session?.running ?? null, rows: d?.rows ?? [] }))`);
    const detail = JSON.parse(json);
    const text = JSON.stringify(detail.rows);
    const ticks = new Map();
    for (const m of text.matchAll(/tick (\d+) pid (\d+)/g)) ticks.set(Number(m[1]), Number(m[2]));
    const pids = [...new Set(ticks.values())];
    const max = ticks.size === 0 ? 0 : Math.max(...ticks.keys());
    return { running: detail.running, ticks, pids, max, size: text.length };
}
const contiguous = (ticks, from, to) => { for (let n = from; n <= to; n++) if (!ticks.has(n)) return n; return null; };

// ================================================================================================================ run
const testMachine = process.env.CI === 'true' || process.env.QUIT_CDP_ALLOW === '1' || (process.platform === 'linux' && userInfo().username === 'genie');
if (!testMachine) refuse('it launches Electron, so it runs only on a test machine (CI, the test VM as user `genie`, or QUIT_CDP_ALLOW=1)');
if (!existsSync('package.json') || !existsSync('scripts/stub-codex.mjs')) refuse(`run it from the root of a built Genie tree (${process.cwd()})`);
const busy = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(() => true, () => false);
if (busy) refuse(`something already answers on the debugger port ${PORT}: stop the running Genie first (vm-smoke: stop_electron)`);

console.log('\nQUIT KEEPS THE HOST — "Just close the UI" with agents streaming, then open Genie again\n');
writeFileSync(TICKER, '');
let a = null;
let b = null;
const agents = [];
let hostPid = null;
let shutDownProven = false;
/** A reason this run cannot measure (exit 2), raised inside the run so that its cleanup still runs. */
let cannot = null;
try {
    // -------------------------------------------------------------------------------- A: three agents streaming
    a = await open('first');
    const snap = await a.cdp.evaluate('window.genie.snapshot()');
    const workspaceId = snap.workspaces?.[0]?.id ?? null;
    if (typeof workspaceId !== 'string') { cannot = 'no workspace in the seed (run smoke-seed.mjs first)'; throw new Error(cannot); }
    for (let i = 1; i <= AGENTS; i++) {
        const name = `ticker-${i}-${process.pid}`;
        const added = await a.cdp.evaluate(`window.genie.addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'Streams ticks for the quit check.', provider: 'codex' })`);
        if (check(added?.ok === true, `1.${i} agent ${name} added`, added?.ok ? added.id : added?.reason)) agents.push({ id: added.id, name });
    }
    for (const ag of agents) await a.cdp.evaluate(`window.genie.agents.restart(${JSON.stringify(ag.id)}, "graceful"); true`);
    for (const ag of agents) {
        const running = await until(() => a.cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(ag.id)}).then((d) => d?.session?.running === true)`), 30_000);
        check(running === true, `2. ${ag.name}'s session is running`);
        const sent = await a.cdp.evaluate(`window.genie.prompt(${JSON.stringify(ag.id)}, 'Stream ticks until stopped.')`);
        check(sent?.ok === true, `3. ${ag.name} took the prompt`, sent?.reason ?? '');
    }
    for (const ag of agents) {
        const t = await until(async () => { const x = await ticksOf(a.cdp, ag.id); return x.max >= 8 ? x : null; }, 30_000);
        ag.before = t ?? await ticksOf(a.cdp, ag.id);
        ag.pid = ag.before.pids.length === 1 ? ag.before.pids[0] : null;
        check(ag.pid !== null, `4. ${ag.name}'s ledger is streaming, from ONE provider pid`, `ticks to ${ag.before.max}, pids ${JSON.stringify(ag.before.pids)}`);
    }

    // POSITIVE CONTROL: the pids read above are real, live, and what they say they are — before anything is closed.
    const host = hostRecord();
    hostPid = host?.pid ?? null;
    check(alive(hostPid) && /host\.js/.test(commandLine(hostPid)), '5. CONTROL: host.json names a LIVE genie-host process', `pid ${hostPid}: ${commandLine(hostPid).slice(0, 160)}`);
    check(hostPid !== a.windowPid && alive(a.windowPid), '6. CONTROL: the host is not the window process (both live)', `host ${hostPid}, window ${a.windowPid}`);
    const pids = agents.map((ag) => ag.pid);
    check(new Set(pids).size === AGENTS, '7. CONTROL: three DIFFERENT provider pids', JSON.stringify(pids));
    for (const ag of agents) check(alive(ag.pid) && /stub-codex/.test(commandLine(ag.pid)), `8. CONTROL: ${ag.name}'s provider pid ${ag.pid} is a LIVE stub-codex process`, commandLine(ag.pid).slice(0, 120));
    for (const ag of agents) {
        const later = await until(async () => { const x = await ticksOf(a.cdp, ag.id); return x.max > ag.before.max ? x : null; }, 10_000);
        check(later !== null && later.pids.length === 1 && later.pids[0] === ag.pid, `9. CONTROL: ${ag.name} is streaming NOW (its ledger grew within seconds, same pid)`, `${ag.before.max} → ${later?.max}`);
        ag.before = later ?? ag.before;
    }

    // -------------------------------------------------------------------------------- "Just close the UI"
    // The logs are read from HERE on: an older line (an earlier launch's adopt of the same host) must not answer for this one.
    const hostLogAt = readOr(HOST_LOG).length;
    const lifecycleAt = readOr(LIFECYCLE).length;
    const took = await answerTheQuit(a.inspector, 1);
    check(took === 'ok', '10. the quit is answered by button 1 (the person\'s click, substituted)', String(took));
    const exit = await Promise.race([a.app.exited, sleep(60_000).then(() => null)]);
    check(exit !== null, '11. the UI closed: the window process exited', exit ? `code ${exit.code} signal ${exit.signal}` : 'still running after 60 s');
    const q = asked();
    check(JSON.stringify(q?.buttons) === JSON.stringify(['Cancel', 'Just close the UI', 'Shut down everything']), '12. the quit ASKED the two answers, and button 1 was "Just close the UI"', JSON.stringify(q));
    check(!alive(a.windowPid), '13. the window process is gone (the OS says so)', `pid ${a.windowPid}`);
    a.cdp.close(); a.inspector.close();

    // -------------------------------------------------------------------------------- no window open
    await sleep(CLOSED_MS);
    check(alive(hostPid), `14. with NO window for ${Math.round(CLOSED_MS / 1000)} s, the host is alive`, `pid ${hostPid}`);
    for (const ag of agents) check(alive(ag.pid), `15. with no window, ${ag.name}'s provider is alive`, `pid ${ag.pid}`);
    check(/left running: a window closed and kept this host/.test(readOr(HOST_LOG).slice(hostLogAt)), '16. the host heard it was left running (its own log)', HOST_LOG);
    check(/agent host left running: the UI closed/.test(readOr(LIFECYCLE).slice(lifecycleAt)), '17. the window let go saying so (lifecycle log)', LIFECYCLE);

    // -------------------------------------------------------------------------------- open Genie again
    const reopenAt = readOr(LIFECYCLE).length;
    b = await open('second');
    check(hostRecord()?.pid === hostPid, '18. the SAME host pid (host.json)', `${hostPid} → ${hostRecord()?.pid}`);
    check(new RegExp(`agent host adopted pid=${hostPid}\\b`).test(readOr(LIFECYCLE).slice(reopenAt)), '19. the new window ADOPTED that host (lifecycle log)', `adopted pid=${hostPid}`);
    for (const ag of agents) {
        const after = await until(async () => { const x = await ticksOf(b.cdp, ag.id); return x.max > ag.before.max ? x : null; }, 30_000) ?? await ticksOf(b.cdp, ag.id);
        ag.after = after;
        check(after.running === true, `20. ${ag.name} is still running`, String(after.running));
        check(after.pids.length === 1 && after.pids[0] === ag.pid && alive(ag.pid), `21. ${ag.name}: the SAME provider pid, alive`, `${ag.pid} → ${JSON.stringify(after.pids)}`);
        const closedTicks = Math.floor(CLOSED_MS / 250 / 2);
        check(after.max - ag.before.max >= closedTicks && after.size > ag.before.size, `22. ${ag.name}'s ledger GREW across the close`, `ticks ${ag.before.max} → ${after.max} (≥ ${closedTicks} wanted), ${ag.before.size} → ${after.size} bytes`);
        const gap = contiguous(after.ticks, ag.before.max + 1, after.max);
        check(gap === null, `23. ${ag.name}: every tick streamed while no window was open is in the ledger, in order`, gap === null ? `${ag.before.max + 1}..${after.max}` : `tick ${gap} missing`);
    }

    // -------------------------------------------------------------------------------- "Shut down everything" (the other answer)
    const took2 = await answerTheQuit(b.inspector, 2);
    check(took2 === 'ok', '24. the quit is answered by button 2', String(took2));
    const exit2 = await Promise.race([b.app.exited, sleep(60_000).then(() => null)]);
    check(exit2 !== null, '25. the window process exited', exit2 ? `code ${exit2.code}` : 'still running after 60 s');
    const q2 = asked();
    check(JSON.stringify(q2?.buttons) === JSON.stringify(['Cancel', 'Just close the UI', 'Shut down everything']), '26. it asked the two answers; button 2 was "Shut down everything"', JSON.stringify(q2));
    const hostGone = await until(() => !alive(hostPid), 30_000);
    check(hostGone === true, '27. "Shut down everything" ENDED the host', `pid ${hostPid}`);
    for (const ag of agents) {
        const gone = await until(() => !alive(ag.pid), 30_000);
        check(gone === true, `28. and ${ag.name}'s provider (the same gauge reading it dead now)`, `pid ${ag.pid}`);
    }
    shutDownProven = true;
} catch (error) {
    if (cannot === null) check(false, 'the check threw', String(error?.stack ?? error));
} finally {
    rmSync(TICKER, { force: true });
    rmSync(PROOF, { force: true });
    for (const s of [a, b]) {
        if (!s) continue;
        s.cdp?.close(); s.inspector?.close();
        s.app.kill();
    }
    if (!shutDownProven && alive(hostPid)) console.log(`  (the host pid ${hostPid} is left running: the VM restore ends it)`);
}

if (cannot !== null && failures.length === 0) refuse(cannot);
if (failures.length) {
    console.log(`\nQUIT-KEEPS-HOST FAILED — ${failures.length} check(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    for (const label of ['first', 'second']) {
        const log = join(OUT, `quit-keeps-host-${label}.log`);
        if (existsSync(log)) { console.log(`\n--- ${log} (last 40 lines) ---`); console.log(readOr(log).split('\n').slice(-40).join('\n')); }
    }
    process.exit(1);
}
console.log('\nQUIT KEEPS THE HOST — measured: the UI closed and opened again over the same host and providers, every tick kept; "Shut down everything" ended them.');
process.exit(0);

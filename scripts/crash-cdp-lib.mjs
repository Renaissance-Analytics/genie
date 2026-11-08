/**
 * What the two crash scripts share (scripts/safe-mode-cdp.mjs, scripts/hang-cdp.mjs; Tynn #386): one Genie on a home and
 * ports of its own, its page over CDP, its window main over the inspector, two codex agents streaming through the stub app
 * server in its TICKER mode, and the process table read and acted on BY PID — the window's own and the one in genie-host's
 * own record (runtime/host.json), never a pattern kill.
 *
 * Every wait is bounded and every step prints before it acts, so a run never hangs silently. They launch Electron, so they
 * refuse to run anywhere but CI or a test VM (CRASH_CDP_ALLOW=1).
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForPageProbe } from './page-probe-cdp.mjs';

export const WIN = process.platform === 'win32';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
export const since = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
export function step(id, what) { console.log(`[${since()}] step ${id}: ${what}`); }

export const failures = [];
export function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${String(detail).slice(0, 400)}` : ''}`);
    if (!ok) failures.push(label);
    return ok;
}
/** `p`, or a rejection naming what missed its deadline. */
export function within(ms, what, p) {
    let t;
    return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`deadline: ${what} did not answer within ${Math.round(ms / 1000)} s`)), ms); })])
        .finally(() => clearTimeout(t));
}
/** Retry `what` until it answers truthy or `ms` runs out; the last value either way. */
export async function until(what, ms, interval = 500) {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
        try { last = await within(Math.max(1_000, Math.min(15_000, end - Date.now())), 'an attempt', Promise.resolve().then(what)); } catch { last = null; }
        if (last) return last;
        await sleep(interval);
    }
    return last;
}

export function refuseOffTestMachines(name) {
    const testMachine = process.env.CI === 'true' || process.env.USER === 'genie' || process.env.CRASH_CDP_ALLOW === '1';
    if (!testMachine) {
        console.error(`${name} launches Electron and kills processes: it runs on CI or a test VM only (CRASH_CDP_ALLOW=1 there).`);
        process.exit(2);
    }
}

// ---------------------------------------------------------------- the process table, by pid
export function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** Ends ONE process at once, uncleanly: SIGKILL, or taskkill /F on that pid alone (never /T, never a pattern). */
export function killHard(pid) {
    if (!alive(pid)) return;
    try {
        if (WIN) execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 15_000 });
        else process.kill(pid, 'SIGKILL');
    } catch { /* it has gone */ }
}
export async function gone(pid, ms) {
    const end = Date.now() + ms;
    while (alive(pid) && Date.now() < end) await sleep(100);
    return !alive(pid);
}
/** The stub app server's processes, by pid: a READ of the table (each process's command line names the stub). */
export function stubPids() {
    try {
        if (WIN) {
            const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*stub-codex.mjs*' -and $_.Name -like 'node*' } | ForEach-Object { $_.ProcessId }"],
                { encoding: 'utf8', timeout: 60_000, windowsHide: true });
            return out.split(/\s+/).filter(Boolean).map(Number);
        }
        return execFileSync('pgrep', ['-f', 'stub-codex.mjs'], { encoding: 'utf8', timeout: 15_000 }).split(/\s+/).filter(Boolean).map(Number);
    } catch { return []; }
}

// ---------------------------------------------------------------- one home, one Genie
export function makeHome(label) {
    const root = mkdtempSync(join(tmpdir(), `${label}-`));
    const home = join(root, 'home');
    mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
    mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
    const genie = join(home, '.genie');
    mkdirSync(join(genie, 'runtime'), { recursive: true });
    // One workspace, registered as a person's machine already has it: a folder and the registry entry.
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: label }, null, 2)}\n`);
    execFileSync('git', ['init', '-q'], { cwd: ws, windowsHide: true, stdio: 'ignore' });
    writeFileSync(join(genie, 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'crash', path: ws }], null, 2));
    return {
        root, home, genie, ws,
        hostRecord: join(genie, 'runtime', 'host.json'),
        hostLog: join(genie, 'logs', 'genie-host.log'),
        lifecycle: join(genie, 'runtime', 'lifecycle.log'),
        crashDir: join(genie, 'runtime', 'crash'),
        env: {
            ...process.env,
            HOME: home, USERPROFILE: home,
            APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
            XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
            GENIE2_CODEX_BINARY: process.env.GENIE2_CODEX_BINARY || join(process.cwd(), 'scripts', 'stub-codex.mjs'),
            GENIE_PAGE_PROBE: '1',
        },
    };
}
export function hostPid(h) {
    try { const raw = JSON.parse(readFileSync(h.hostRecord, 'utf8')); return typeof raw.pid === 'number' ? raw.pid : null; } catch { return null; }
}
export const readOr = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/** The stub streams `tick <n> pid <pid>` while this script lives (its marker names this pid). */
export const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
export function tickerOn() { writeFileSync(TICKER, String(process.pid)); }
export function tickerOff() { rmSync(TICKER, { force: true }); }

const electron = createRequire(import.meta.url)('electron');
export function launch(h, { port, inspect, label }) {
    const out = openSync(join(h.root, `electron-${label}.log`), 'a');
    const args = [`--inspect=${inspect}`, '.', `--remote-debugging-port=${port}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
    const child = spawn(electron, args, { env: h.env, stdio: ['ignore', out, out], detached: !WIN, windowsHide: false });
    let exited = false;
    const exit = new Promise((r) => { child.once('exit', () => { exited = true; r(true); }); child.once('error', () => { exited = true; r(true); }); });
    console.log(`  launched (${label}) pid ${child.pid}`);
    return { child, exit, get exited() { return exited; } };
}

// ---------------------------------------------------------------- CDP: the page and the window's main
async function targetOn(port, kind, ms) {
    return until(async () => {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
        return targets.find((x) => (kind === 'page' ? x.type === 'page' && !String(x.url).startsWith('devtools') : true) && x.webSocketDebuggerUrl) ?? null;
    }, ms);
}
export class Cdp {
    #ws; #id = 1; #pending = new Map(); #label;
    static async connect(url, label) {
        const c = new Cdp();
        c.#label = label;
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
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
    /** Sent, never awaited: for an expression that holds the process it runs in (the freeze). */
    fire(expression) {
        this.#ws.send(JSON.stringify({ id: this.#id++, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    }
    async evaluate(expression, ms = 30_000) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, ms);
        if (f.error) throw new Error(`${this.#label}: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`${this.#label} threw: ${f.result.exceptionDetails.exception?.description ?? f.result.exceptionDetails.text ?? '?'}`);
        return f.result.result.value;
    }
    async closed(ms = 5_000) {
        if (this.#ws.readyState === WebSocket.CLOSED) return true;
        const done = new Promise((r) => this.#ws.addEventListener('close', () => r(true), { once: true }));
        try { this.#ws.close(); } catch { /* gone */ }
        return Promise.race([done, sleep(ms).then(() => false)]);
    }
}
/** The page (window.genie loaded, the page probe ready) and the window main's inspector, with its pid. */
export async function attach({ port, inspect, label }) {
    const page = await targetOn(port, 'page', 90_000);
    if (!page) throw new Error(`${label}: no page on the debugger port ${port} within 90 s`);
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl, `${label} page`);
    const ready = await until(() => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"', 5_000), 60_000);
    if (ready !== true) throw new Error(`${label}: window.genie never appeared within 60 s`);
    await waitForPageProbe(cdp);
    const node = await targetOn(inspect, 'node', 30_000);
    if (!node) throw new Error(`${label}: no inspector on ${inspect} within 30 s`);
    const inspector = await Cdp.connect(node.webSocketDebuggerUrl, `${label} inspector`);
    const windowPid = await inspector.evaluate('process.pid', 10_000);
    return { cdp, inspector, windowPid };
}

// ---------------------------------------------------------------- agents
export async function ticksOf(cdp, agentId) {
    const json = await cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(agentId)}).then((d) => JSON.stringify({ running: d?.session?.running ?? null, rows: d?.rows ?? [] }))`, 15_000);
    const detail = JSON.parse(json);
    const ticks = new Map();
    for (const m of JSON.stringify(detail.rows).matchAll(/tick (\d+) pid (\d+)/g)) ticks.set(Number(m[1]), Number(m[2]));
    const pids = [...new Set(ticks.values())];
    return { running: detail.running === true, max: ticks.size === 0 ? 0 : Math.max(...ticks.keys()), pids, last: ticks.size === 0 ? null : ticks.get(Math.max(...ticks.keys())) };
}
/** Why an agent is or is not running, as the host says: its session, a start's refusal, the provider's last stderr. */
export const whyOf = (cdp, agentId) => cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(agentId)}).then((d) => JSON.stringify({ session: d?.session ? { running: d.session.running, turnState: d.session.turnState, failure: d.session.failure ?? null } : null, refusal: d?.refusal ?? null, log: (d?.log ?? []).slice(-4) }))`, 15_000).catch((e) => `(unread: ${e?.message ?? e})`);
export const running = (cdp, agentId) => cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(agentId)}).then((d) => d?.session?.running === true)`, 15_000);
/** Two codex agents, each started and prompted, streaming ticks (mid-turn). */
export async function twoStreamingAgents(cdp, tag) {
    const snap = await cdp.evaluate('window.genie.snapshot()', 15_000);
    const workspaceId = snap?.workspaces?.[0]?.id ?? null;
    if (typeof workspaceId !== 'string') throw new Error('no workspace in this home');
    const agents = [];
    for (const n of [1, 2]) {
        const name = `${tag}-${n}`;
        const added = await cdp.evaluate(`window.genie.addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'Streams ticks for the crash check.', provider: 'codex' })`, 30_000);
        if (!check(added?.ok === true, `agent ${name} added`, added?.ok ? added.id : added?.reason)) throw new Error(`agent ${name} not added`);
        agents.push({ id: added.id, name });
    }
    for (const a of agents) {
        await cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(a.id)}, "graceful"); true`, 15_000);
        // ---- PROBE (throwaway, never merged): the agent's session states, once a second, each change logged.
        const t0 = Date.now();
        let lastState = '';
        let ok = false;
        while (Date.now() - t0 < 30_000) {
            const why = await whyOf(cdp, a.id);
            const row = await cdp.evaluate(`window.genie.snapshot().then((s) => JSON.stringify((s?.agents ?? []).filter((x) => x.id === ${JSON.stringify(a.id)}).map((x) => ({ state: x.state, reason: x.reason ?? null, held: x.held ?? null, fidelity: x.fidelity ?? null }))))`, 15_000).catch((e) => `(unread: ${e?.message ?? e})`);
            const now = `${why} ${row}`;
            if (now !== lastState) { console.log(`GENIE-PROBE agent=${a.name} t=${Date.now() - t0}ms why=${why} row=${row}`); lastState = now; }
            if (await running(cdp, a.id).catch(() => false)) { ok = true; break; }
            await sleep(1_000);
        }
        console.log(`GENIE-PROBE agent=${a.name} running=${ok} after=${Date.now() - t0}ms`);
        check(ok, `${a.name}'s session is running (the host says so)`);
        await cdp.evaluate(`window.genie.prompt(${JSON.stringify(a.id)}, 'Stream ticks until stopped.')`, 15_000);
    }
    for (const a of agents) {
        const t = await until(async () => { const x = await ticksOf(cdp, a.id); return x.max >= 4 ? x : null; }, 45_000);
        check(t !== null, `${a.name} is mid-turn: its provider streams`, t ? `tick ${t.max} from pid ${t.last}` : 'no ticks');
    }
    return { workspaceId, agents };
}

/** The product's own quit, answered "Shut down everything" (index 2) in place of the person's click (quit-keeps-host-cdp.mjs). */
export async function cleanQuit(inspector) {
    const said = await inspector.evaluate(`(() => {
        const module = process.getBuiltinModule && process.getBuiltinModule('node:module');
        if (!module) return 'no process.getBuiltinModule in this Electron';
        const require = module.createRequire(process.execPath);
        const { app, dialog } = require('electron');
        dialog.showMessageBoxSync = () => 2;
        setTimeout(() => app.quit(), 1000);
        return 'ok';
    })()`, 10_000);
    await inspector.closed(5_000);
    return said;
}

export function hostLogSince(h, from) { return readOr(h.hostLog).slice(from); }
export function finish(name, h, cleanups) {
    return async (code) => {
        for (const fn of cleanups) { try { await fn(); } catch { /* cleanup is bounded and best-effort */ } }
        tickerOff();
        if (failures.length > 0) {
            console.log(`\n${name} FAILED — ${failures.length} check(s):`);
            for (const f of failures) console.log(`  - ${f}`);
            for (const file of [h.hostLog, h.lifecycle]) {
                const lines = readOr(file).split(/\r?\n/).filter((l) => /safe mode|hang|crash|lost|relaunch|restor|resum|agent|refus|fail|could not|ready|serving|windows connected/i.test(l)).slice(-45);
                console.log(`  ${file} (filtered):\n    ${lines.map((l) => l.slice(0, 220)).join('\n    ')}`);
            }
        } else console.log(`\n${name} OK`);
        // THE HOST'S OWN TIMING, pass or fail (omarchy-test, 2026-11-06: genie-host's loop came 8–12 s late during each hold):
        // its late ticks with the CPU it spent across them, its stall lines, and the memory readings.
        const timing = readOr(h.lifecycle).split(/\r?\n/).filter((l) => /clock jumped|host stall|stall main|rss window=/.test(l)).slice(-40);
        console.log(`  host timing (${timing.length} line(s)):${timing.length ? `\n    ${timing.map((l) => l.slice(0, 220)).join('\n    ')}` : ' none'}`);
        try { rmSync(h.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* a held file on Windows */ }
        process.exit(code ?? (failures.length > 0 ? 1 : 0));
    };
}

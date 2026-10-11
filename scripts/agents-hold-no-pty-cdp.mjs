#!/usr/bin/env node
/**
 * AGENTS HOLD NO PTY — the one rule (§1), measured on the REAL app with a REAL process table.
 *
 *   node scripts/agents-hold-no-pty-cdp.mjs
 *
 * Runs against an app launched with `--remote-debugging-port=9222` after `smoke-seed.mjs`,
 * with `GENIE2_CODEX_BINARY` pointing at the stub app-server (so an agent can actually run).
 * The unit layer (test/no-agent-pty.test.ts) proves the host never ASKS for a pty on an
 * agent's behalf; the type layer makes "agent on a pty" uncompilable; this is the third layer
 * §8.2 asks for — a process scan while agents run:
 *
 *   N running agents → 0 agent-attributable ptys, N sessions;
 *   and a plain terminal still spawns EXACTLY ONE (the positive control, same scan, same run).
 *
 * How a pty is counted: on Windows every conpty has a console host — `conhost.exe` for the
 * system conpty, `OpenConsole.exe` for node-pty's bundled one — so the number of those
 * processes is the number of live ptys on an otherwise idle machine. On Linux it is the number
 * of allocated pty slaves (`/dev/pts`). Deltas against a baseline taken before anything starts.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT ?? 9222);
const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Live ptys, by their PSEUDOCONSOLE hosts (win32) or slave devices (linux).
 *
 * On Windows a pseudoconsole is hosted by `OpenConsole.exe` (node-pty's bundled host) or by a
 * `conhost.exe` started `--headless`. A PLAIN `conhost.exe` is not a pty: Windows attaches one
 * to any console-subsystem child of a GUI process — the stub agent's `cmd.exe`, this script's
 * own `tasklist` and `powershell` probes — and they come and go. The first run of this check
 * counted those and failed on its own noise (4 → 3 → 2) while `OpenConsole` sat at 0 with the
 * agent running and went exactly 0 → 1 → 0 around the terminal — which was the answer.
 */
function ptys() {
    if (process.platform === 'win32') {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'OpenConsole.exe' -or ($_.Name -eq 'conhost.exe' -and $_.CommandLine -like '*--headless*') } | ForEach-Object { $_.Name }"],
            { encoding: 'utf8', timeout: 30_000 });
        const names = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const openConsole = names.filter((n) => /openconsole/i.test(n)).length;
        const headless = names.length - openConsole;
        return { total: names.length, detail: `OpenConsole ${openConsole}, headless conhost ${headless}` };
    }
    const pts = readdirSync('/dev/pts').filter((n) => /^\d+$/.test(n)).length;
    return { total: pts, detail: `/dev/pts ${pts}` };
}
/** Provider processes: the stub app-server, by command line. */
function stubProcesses() {
    if (process.platform === 'win32') {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
            "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*stub-codex*' -and $_.CommandLine -notlike '*agents-hold-no-pty*' }).Count"],
            { encoding: 'utf8', timeout: 30_000 }).trim();
        return Number(out || 0);
    }
    try {
        return execFileSync('pgrep', ['-fc', 'stub-codex'], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)[0] ?? 0;
    } catch { return 0; }
}

async function findTarget() {
    const until = Date.now() + 60_000;
    let last = 'no attempt';
    while (Date.now() < until) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page;
            last = `no page yet (${targets.length})`;
        } catch (e) { last = String(e); }
        await sleep(500);
    }
    throw new Error(`no window on the debugger port: ${last}`);
}
class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (r) { c.#pending.delete(f.id); r(f); } });
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
        if (f.result.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result.result.value;
    }
    close() { this.#ws.close(); }
}

console.log('\nAGENTS HOLD NO PTY — a process scan while agents run, on the real app\n');
const page = await findTarget();
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
let terminalId = null;
let codexId = null;
try {
    await cdp.evaluate('document.readyState');
    const base = ptys();
    const baseStubs = stubProcesses();
    console.log(`  baseline: ptys ${base.total} (${base.detail}); provider processes ${baseStubs}`);
    check(baseStubs === 0, '0. no provider process exists before anything starts', String(baseStubs));

    const snap = await cdp.evaluate('window.genie.snapshot()');
    codexId = (snap.agents.find((a) => a.provider === 'codex') ?? {}).id ?? null;
    const workspaceId = snap.workspaces?.[0]?.id ?? null;
    check(typeof codexId === 'string' && typeof workspaceId === 'string', '1. the seed left a codex agent and a workspace', `${codexId} in ${workspaceId}`);

    // START AN AGENT, the way a person does.
    await cdp.evaluate(`window.genie.openAgent(${JSON.stringify(codexId)}); true`);
    let running = null;
    for (const end = Date.now() + 30_000; Date.now() < end && running !== true;) {
        running = await cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(codexId)}).then((d) => d?.session?.running ?? null)`);
        if (running !== true) await sleep(500);
    }
    check(running === true, '2. the agent\'s session is RUNNING (the host says so)', String(running));
    await sleep(1500);
    const stubsLive = stubProcesses();
    check(stubsLive >= 1, '3. CONTROL: a real provider process exists for it', `${stubsLive} stub process(es)`);

    // THE RULE: N = 1 running agent, 0 agent-attributable ptys.
    const withAgent = ptys();
    check(withAgent.total - base.total === 0, '4. ptys did not move while the agent runs — 0 agent-attributable ptys', `${base.total} → ${withAgent.total} (${withAgent.detail})`);
    const sessions = await cdp.evaluate(`Promise.all(${JSON.stringify(snap.agents.map((a) => a.id))}.map((id) => window.genie.agentDetail(id).then((d) => d?.session?.running === true))).then((xs) => xs.filter(Boolean).length)`);
    check(sessions === 1, '5. the session count equals the number of agents running (N = 1)', String(sessions));

    // POSITIVE CONTROL for the scan: a plain terminal spawns EXACTLY ONE pty.
    const opened = await cdp.evaluate(`window.genie.terminals.open(${JSON.stringify(workspaceId)}, { cols: 80, rows: 24 })`);
    terminalId = opened?.id ?? null;
    check(typeof terminalId === 'string' && opened.pid > 0, '6. a Workspace terminal opened (pid reported)', `pid ${opened?.pid}, shell ${opened?.shell}`);
    let withTerm = ptys();
    for (const end = Date.now() + 10_000; Date.now() < end && withTerm.total - withAgent.total < 1;) { await sleep(500); withTerm = ptys(); }
    check(withTerm.total - withAgent.total === 1, '7. CONTROL: that terminal is exactly ONE more pty in the same scan', `${withAgent.total} → ${withTerm.total} (${withTerm.detail})`);
    const stillRunning = await cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(codexId)}).then((d) => d?.session?.running ?? null)`);
    check(stillRunning === true, '8. and the agent is still running beside it — the two are unrelated', String(stillRunning));

    // Close the terminal: the pty goes; the agent stays.
    await cdp.evaluate(`window.genie.terminals.close(${JSON.stringify(terminalId)}); true`);
    terminalId = null;
    let afterClose = ptys();
    for (const end = Date.now() + 10_000; Date.now() < end && afterClose.total !== withAgent.total;) { await sleep(500); afterClose = ptys(); }
    check(afterClose.total === withAgent.total, '9. closing the terminal takes exactly that one pty away', `${withTerm.total} → ${afterClose.total}`);

    // STOP MEANS STOP: after stop returns, a process scan finds nothing of the agent.
    await cdp.evaluate(`window.genie.stopAgent(${JSON.stringify(codexId)}); true`);
    codexId = null;
    let stubsAfter = stubProcesses();
    for (const end = Date.now() + 15_000; Date.now() < end && stubsAfter !== 0;) { await sleep(500); stubsAfter = stubProcesses(); }
    check(stubsAfter === 0, '10. stop means stop: no provider process survives', `${stubsLive} → ${stubsAfter}`);
    const finalPtys = ptys();
    check(finalPtys.total === base.total, '11. and the pty count is back at the baseline', `${base.total} → ${finalPtys.total}`);
} catch (error) {
    check(false, 'the check threw', String(error));
} finally {
    try { if (terminalId) await cdp.evaluate(`window.genie.terminals.close(${JSON.stringify(terminalId)}); true`); } catch { /* gone */ }
    try { if (codexId) await cdp.evaluate(`window.genie.stopAgent(${JSON.stringify(codexId)}); true`); } catch { /* gone */ }
    try { cdp.close(); } catch { /* gone */ }
}

if (failures.length) { console.log(`\nAGENTS-HOLD-NO-PTY FAILED — ${failures.length} check(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`); process.exit(1); }
console.log('\nAGENTS HOLD NO PTY — measured: a running agent added no pty, a terminal added exactly one, stop left nothing.');
process.exit(0);

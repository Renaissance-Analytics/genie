#!/usr/bin/env node
/**
 * A HUNG WINDOW, AS A PERSON MEETS IT, in the real app (Tynn #386; hang-watchdog.ts, HangNoticeBar.tsx).
 *
 *   node scripts/hang-cdp.mjs            (Linux: under xvfb-run)
 *
 * It starts Genie itself, on a home and ports of its own, with two codex agents streaming through the stub app server.
 *
 *   CONTROL FIRST: 40 s with nothing frozen — no crash record, no notice. So the rows below read a hang, not the clock.
 *
 *   THE HANG: window main is held for 40 s by a busy loop run through its own INSPECTOR (a launch flag; the product has no
 *   freeze path — test/no-freeze-hook.test.ts). Its beat stops for real. Then:
 *     - genie-host writes a crash record of kind `hang`, ends that window process, and opens a new window (the relaunch is
 *       the launch it replaces: core/launch-flags.ts keeps the window's own debugger switches, so this script can read it);
 *     - the agents run on across it: the SAME genie-host pid, the SAME provider pid streaming for each, its ticks still
 *       growing (the same session, never restarted);
 *     - the new window shows the notice with "Send a crash report".
 *   A SECOND hang within 10 minutes: the notice says it twice and offers "Stop all agents"; clicking it stops them (the
 *   host says so, and their providers end).
 *
 * Exit: 0 every check passed; 1 a check failed; 2 cannot run here.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    alive, attach, check, cleanQuit, failures, finish, gone, hostPid, killHard, launch, makeHome,
    refuseOffTestMachines, running, sleep, step, tickerOn, ticksOf, twoStreamingAgents, until,
} from './crash-cdp-lib.mjs';

refuseOffTestMachines('hang-cdp');
const PORT = Number(process.env.HANG_CDP_PORT ?? 9356);
const INSPECT = Number(process.env.HANG_CDP_INSPECT ?? 9357);
const FREEZE_MS = 40_000;
const h = makeHome('hang');
let app = null;
let session = null;
const agentIds = [];
const done = finish('HANG', h, [
    async () => { if (session) for (const id of agentIds) await session.cdp.evaluate(`window.genie.stopAgent(${JSON.stringify(id)}); true`, 10_000).catch(() => {}); },
    async () => { if (session) { const pid = session.windowPid; await cleanQuit(session.inspector).catch(() => {}); await gone(pid, 30_000); } },
    async () => { if (session && alive(session.windowPid)) killHard(session.windowPid); },
    async () => { const pid = hostPid(h); if (pid !== null && alive(pid)) { killHard(pid); await gone(pid, 10_000); } },
    async () => { if (app && !app.exited) killHard(app.child.pid); },
]);
setTimeout(() => { check(false, 'the run finished within its deadline (480 s)'); void done(1); }, Number(process.env.HANG_CDP_DEADLINE_MS ?? 480_000)).unref();

/** Every Electron of this checkout, with its command line (a read of the process table). */
function genieCommandLines() {
    try {
        if (process.platform === 'win32') {
            return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'electron*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"],
                { encoding: 'utf8', timeout: 60_000, windowsHide: true }).split(/\r?\n/).filter(Boolean).map((l) => l.slice(0, 300));
        }
        return execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', timeout: 15_000 }).split('\n').filter((l) => /electron/.test(l) && !/--type=/.test(l)).map((l) => l.trim().slice(0, 300));
    } catch (error) { return [`(unread: ${error?.message ?? error})`]; }
}
/** Who listens on, or holds, a port (netstat), and every Electron process with its parent and type. */
function portHolders(port) {
    try {
        if (process.platform === 'win32') {
            const net = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }).split(/\r?\n/).filter((l) => l.includes(`:${port} `)).map((l) => l.trim());
            const all = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'electron*' } | ForEach-Object { \"$($_.ProcessId) parent=$($_.ParentProcessId) $((($_.CommandLine -split ' ') | Where-Object { $_ -like '--type=*' }) -join ' ')\" }"],
                { encoding: 'utf8', timeout: 60_000, windowsHide: true }).split(/\r?\n/).filter(Boolean);
            return [...(net.length ? net : ['(nobody on the port)']), ...all];
        }
        return execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 15_000 }).split('\n').filter((l) => l.includes(`:${port} `));
    } catch (error) { return [`(unread: ${error?.message ?? error})`]; }
}
/** The crash records genie-host wrote, by kind. */
function records() {
    let names = [];
    try { names = readdirSync(h.crashDir).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names.map((n) => { try { return { file: n, ...JSON.parse(readFileSync(join(h.crashDir, n), 'utf8')) }; } catch { return { file: n, kind: '(unreadable)' }; } });
}
const notice = () => session.cdp.evaluate(`(() => { const n = document.querySelector('[data-hang-notice]'); return n ? { hangs: Number(n.getAttribute('data-hang-notice')), report: Boolean(n.querySelector('[data-action="crash-report-open"]')), stopAll: Boolean(n.querySelector('[data-action="hang-stop-all"]')), agents: [...n.querySelectorAll('[data-hang-agent]')].map((e) => e.getAttribute('data-hang-agent')) } : null; })()`, 10_000);

/** One hang: main held through its inspector; the host's record, the window ended, a new one, the agents carried on. */
async function hang(n, agents) {
    const hostBefore = hostPid(h);
    const windowBefore = session.windowPid;
    // What this window was started with: the launch it publishes, and so the relaunch, copies its own switches from it.
    console.log(`  window argv: ${JSON.stringify(await session.inspector.evaluate('process.argv', 10_000).catch((e) => String(e?.message ?? e))).slice(0, 400)}`);
    const kept = new Map();
    for (const a of agents) kept.set(a.id, await ticksOf(session.cdp, a.id));
    const recordsBefore = records().filter((r) => r.kind === 'hang').length;
    step(`H${n}`, `holding window main ${windowBefore} for ${FREEZE_MS / 1000} s through its inspector`);
    session.inspector.fire(`(() => { const end = Date.now() + ${FREEZE_MS}; while (Date.now() < end) { /* held */ } return 'released'; })()`);
    const recorded = await until(() => records().filter((r) => r.kind === 'hang').length > recordsBefore, 75_000, 1_000);
    check(recorded === true, `H${n}a. genie-host wrote a crash record of kind hang`, records().map((r) => `${r.file}:${r.kind}`).join(', '));
    check(await gone(windowBefore, 30_000), `H${n}b. the hung window process was ended`, String(windowBefore));
    session = null;
    step(`H${n}c`, 'waiting for the window genie-host opens again');
    session = await attach({ port: PORT, inspect: INSPECT, label: `after-hang-${n}` }).catch((error) => {
        // The window genie-host started, as the OS sees it: its command line says what it was given.
        console.log(`  Genie processes now:\n    ${genieCommandLines().join('\n    ')}`);
        console.log(`  the debugger port ${PORT}:\n    ${portHolders(PORT).join('\n    ')}`);
        throw error;
    });
    check(session.windowPid !== windowBefore, `H${n}c. a new window opened`, `${windowBefore} -> ${session.windowPid}`);
    check(hostPid(h) === hostBefore && alive(hostBefore), `H${n}d. the same genie-host ran on`, `${hostBefore} -> ${hostPid(h)}`);
    for (const a of agents) {
        const before = kept.get(a.id);
        const after = await until(async () => { const x = await ticksOf(session.cdp, a.id); return x.max > before.max ? x : null; }, 30_000);
        check(after !== null && after.running && after.last === before.last && alive(before.last),
            `H${n}e. ${a.name} ran on across it: the same session, its provider still streaming`,
            after ? `pid ${before.last} -> ${after.last}, tick ${before.max} -> ${after.max}` : `no new tick after ${before.max}`);
    }
    return until(async () => { const x = await notice(); return x && x.hangs === n ? x : null; }, 30_000);
}

console.log('\nA HUNG WINDOW — what genie-host does, and what a person is told\n');
try {
    tickerOn();
    step('A1', 'launching, on a home of its own');
    app = launch(h, { port: PORT, inspect: INSPECT, label: 'first' });
    session = await attach({ port: PORT, inspect: INSPECT, label: 'first' });
    const { agents } = await twoStreamingAgents(session.cdp, `hang-${process.pid}`);
    for (const a of agents) agentIds.push(a.id);

    step('B1', 'CONTROL: 40 s with nothing frozen');
    const windowA = session.windowPid;
    await sleep(40_000);
    check(records().length === 0, 'B1. CONTROL: no crash record', records().map((r) => r.file).join(', ') || 'none');
    check(await notice() === null, 'B2. CONTROL: no notice');
    check(alive(windowA) && session.windowPid === windowA, 'B3. CONTROL: the same window, still alive');

    const first = await hang(1, agents);
    check(first !== null, 'H1f. the new window shows the notice', JSON.stringify(first));
    check(first?.report === true, 'H1g. with "Send a crash report"');
    check(first?.stopAll === false, 'H1h. and, after one hang, no "Stop all agents" yet');

    const second = await hang(2, agents);
    check(second !== null && second.hangs === 2, 'H2f. a second hang within 10 minutes: the notice says it twice', JSON.stringify(second));
    check(second?.stopAll === true, 'H2g. and offers "Stop all agents"');
    check(agents.every((a) => second?.agents.includes(a.id)), 'H2h. naming what is running', JSON.stringify(second?.agents));

    step('S1', 'Stop all agents');
    const providers = [];
    for (const a of agents) providers.push((await ticksOf(session.cdp, a.id)).last);
    await session.cdp.evaluate(`document.querySelector('[data-action="hang-stop-all"]').click(); true`, 10_000);
    for (const a of agents) check(await until(async () => (await running(session.cdp, a.id)) === false, 45_000) === true, `S1. ${a.name} stopped (the host says so)`);
    check(await until(() => session.cdp.evaluate(`document.querySelector('[data-hang-outcome="stop-all"]')?.textContent === 'Stopped'`, 10_000), 30_000) === true, 'S2. the notice says Stopped');
    const left = await until(() => (providers.every((p) => p === null || !alive(p)) ? 'none' : null), 30_000);
    check(left === 'none', 'S3. their providers ended', providers.filter((p) => p !== null && alive(p)).join(', ') || 'none');
} catch (error) {
    check(false, 'the run did not finish', String(error?.message ?? error).slice(0, 300));
}
await done(failures.length > 0 ? 1 : 0);

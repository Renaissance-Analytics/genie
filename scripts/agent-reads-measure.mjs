#!/usr/bin/env node
/**
 * P4 FAMILY 9A, MEASURED (Tynn #564): rows M4, M5 and M6, on the build under test, in the real app, for one read path:
 *
 *   node scripts/agent-reads-measure.mjs --mode=ipc           --out=ipc.json             the old IPC path, the baseline
 *   node scripts/agent-reads-measure.mjs --mode=door          --out=door.json            the door, snapshot inline when it fits
 *   node scripts/agent-reads-measure.mjs --mode=door-revision --out=door-revision.json   the door, every snapshot a revision (M6)
 *
 * Then scripts/agent-reads-compare.mjs judges two of the files. All modes run the same build and the same stub transcript.
 * It launches Electron, so it refuses to run anywhere but CI or a test VM (CRASH_CDP_ALLOW=1 there).
 *
 *  M4  open an agent with a 5,000 and a 20,000 row ledger: subscribe to the first whole detail in the page, and the longest
 *      window gap meanwhile. Five times each; the medians. It measures delivery to the page, not the chat's own drawing.
 *  M5  one agent streaming about 50 events a second for 60 s, watched: window and genie-host CPU, the longest gap, updates/s.
 *  M6  30 agents registered, 3 streaming, for 30 s: snapshot read latency (once a second), pushes/s, the longest gap.
 *
 * The gauge is proven first, in the same run: a deliberate 120 ms block of the page has to show as a gap.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHeapSampler } from './agent-reads-heap.mjs';
import { WIN, alive, attach, check, cleanQuit, failures, finish, gone, hostPid, killHard, launch, makeHome, readOr, refuseOffTestMachines, sleep, step, until } from './crash-cdp-lib.mjs';

refuseOffTestMachines('agent-reads-measure');

const arg = (name, fallback) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const MODE = arg('mode', 'door');
const OUT = arg('out', `agent-reads-${MODE}.json`);
if (!['ipc', 'door', 'door-revision'].includes(MODE)) { console.error(`unknown --mode=${MODE}`); process.exit(2); }

// Its own ports per run: a window left by an earlier run on the same port answers for this one, with its home already deleted.
const PORT = Number(process.env.AGENT_READS_CDP_PORT ?? 9400 + (process.pid % 200) * 2);
const INSPECT = Number(process.env.AGENT_READS_INSPECT ?? PORT + 1);
const MARKER = join(tmpdir(), 'genie-stub-codex-measure');
/** What the stub's next turn does (scripts/stub-codex.mjs, MEASURE mode). */
const script = (rows, rate) => writeFileSync(MARKER, JSON.stringify({ owner: process.pid, rows, rate }));
const median = (values) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const h = makeHome('agent-reads');
if (MODE === 'ipc') h.env.GENIE_AGENT_READS = 'ipc';
if (MODE === 'door-revision') h.env.GENIE_SNAPSHOT_PUSH = 'revision';
script(0, 0);

/** A page gauge: every 10 ms timer, the longest gap between them, since `reset`. */
const GAUGE = `(() => {
    if (window.__gauge) return true;
    const g = { last: performance.now(), max: 0 };
    setInterval(() => { const at = performance.now(); g.max = Math.max(g.max, at - g.last); g.last = at; }, 10);
    window.__gauge = { reset: () => { g.max = 0; g.last = performance.now(); }, max: () => g.max };
    return true;
})()`;

/** CPU milliseconds of a process so far, from the OS. */
function cpuMsOf(pid) {
    if (WIN) return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8' }).trim());
    const fields = execFileSync('cat', [`/proc/${pid}/stat`], { encoding: 'utf8' });
    const after = fields.slice(fields.lastIndexOf(')') + 2).split(' ');
    return (Number(after[11]) + Number(after[12])) * 10;
}
/** Window main and its page, CPU ms so far, as Electron reports them. */
const windowCpu = (inspector) => inspector.evaluate(`(() => {
    const require = process.getBuiltinModule('node:module').createRequire(process.execPath);
    const metrics = require('electron').app.getAppMetrics();
    const cpu = process.cpuUsage();
    const tabs = metrics.filter((m) => m.type === 'Tab').reduce((n, m) => n + (m.cpu.cumulativeCPUUsage ?? 0) * 1000, 0);
    return (cpu.user + cpu.system) / 1000 + tabs;
})()`, 15_000);

const cleanups = [];
const done = finish('AGENT READS MEASURE', h, cleanups);
let session = null;
/** Written whatever happens: a row that fails still leaves everything measured up to it, and every first read. */
const result = { mode: MODE, platform: process.platform, finished: false };
const writeResult = () => writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
/** How the agents started and ended, from the host's own lifecycle log: what a start that never came needs read. */
const agentLifecycle = () => readOr(h.lifecycle).split(/\r?\n/).filter((l) => /kind=agent|agent .*(start|refus|fail)|host stall|stall main/.test(l)).slice(-80);

/** Add an agent, start it, give it its turn; `rows` long before it streams at `rate`. */
async function agentThat(cdp, workspaceId, name, rows, rate) {
    const added = await cdp.evaluate(`window.genieTest.addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'measure', provider: 'codex' })`, 15_000);
    if (!check(added?.ok === true, `agent ${name} added`, added?.reason ?? '')) throw new Error(`agent ${name} not added`);
    script(rows, rate);
    await cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(added.id)}, "graceful"); true`, 15_000);
    const started = await until(() => cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(added.id)}).then((d) => d?.session?.running === true)`, 15_000), 60_000);
    if (!check(started === true, `${name} is running`)) throw new Error(`${name} did not start`);
    await cdp.evaluate(`window.genieTest.prompt(${JSON.stringify(added.id)}, 'measure')`, 15_000);
    if (rows > 0) {
        const reached = await until(() => cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(added.id)}).then((d) => (d?.rows?.length ?? 0) >= ${rows})`, 30_000), 240_000, 2_000);
        if (!check(reached === true, `${name} holds ${rows} rows`)) throw new Error(`${name} never reached ${rows} rows`);
    }
    return added.id;
}

/** Subscribe, and time the first whole detail. */
const openOnce = (cdp, id, rows) => cdp.evaluate(`new Promise((resolve, reject) => {
    window.__gauge.reset();
    const started = performance.now();
    const timer = setTimeout(() => { off(); reject(new Error('no whole detail within 120 s')); }, 120000);
    const off = window.genieTest.subscribeAgent(${JSON.stringify(id)}, (detail) => {
        if ((detail?.rows?.length ?? 0) < ${rows}) return;
        clearTimeout(timer);
        const ms = performance.now() - started;
        off();
        requestAnimationFrame(() => setTimeout(() => resolve({ ms, maxGapMs: window.__gauge.max() }), 0));
    });
})`, 130_000);

async function main() {
    step('A', `launching, mode ${MODE}`);
    const taken = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
    if (taken) throw new Error(`something already answers on the debugging port ${PORT}: it would be measured instead of this run`);
    const app = launch(h, { port: PORT, inspect: INSPECT, label: MODE });
    // Nothing of this run outlives it: the next mode's numbers must be its own.
    cleanups.push(async () => {
        for (const pid of [hostPid(h), app.child.pid]) if (typeof pid === 'number' && alive(pid)) { killHard(pid); await gone(pid, 10_000); }
    });
    session = await attach({ port: PORT, inspect: INSPECT, label: MODE });
    const { cdp, inspector } = session;
    result.windowPid = session.windowPid;
    result.launchedPid = app.child.pid;
    check(session.windowPid === app.child.pid, 'the window being measured is the one this run launched', `window ${session.windowPid}, launched ${app.child.pid}`);
    await cdp.evaluate(GAUGE, 5_000);
    // What the first reads really answered, kept in the result: a snapshot that is empty at first is a finding, not a wait.
    const firstReads = [];
    const started = Date.now();
    let workspaceId = null, last = null;
    while (Date.now() - started < 30_000 && typeof workspaceId !== 'string') {
        try {
            last = await cdp.evaluate(`Promise.all([window.genieTest.snapshot(), window.genie.snapshot ? window.genie.snapshot().catch((e) => ({ threw: String(e) })) : null]).then(([s, ipc]) => ({ workspaces: s?.workspaces === null ? null : s?.workspaces === undefined ? 'undefined' : s.workspaces.map((w) => w.id), agents: s?.agents?.length ?? null, keys: Object.keys(s ?? {}).length, isNull: s === null, kind: typeof s, windowKeys: Object.keys(s ?? {}), ipcWorkspaces: ipc?.workspaces === null ? null : Array.isArray(ipc?.workspaces) ? ipc.workspaces.map((w) => w.id) : ipc, shown: document.querySelector('[data-surface]')?.getAttribute('data-surface') ?? null, text: (document.body.innerText ?? '').slice(0, 160) }))`, 15_000);
            last.onDisk = readOr(join(h.genie, 'runtime', 'workspaces.json')).slice(0, 200);
        } catch (error) { last = { threw: error instanceof Error ? error.message : String(error) }; }
        firstReads.push({ afterMs: Date.now() - started, read: last });
        workspaceId = Array.isArray(last?.workspaces) ? last.workspaces[0] ?? null : null;
        if (typeof workspaceId !== 'string') await sleep(100);
    }
    console.log(`  first snapshot reads (${firstReads.length}): ${JSON.stringify(firstReads.slice(0, 40))}`);
    result.firstReads = firstReads;
    if (typeof workspaceId !== 'string') throw new Error(`no workspace in this home after 30 s; the last read answered ${JSON.stringify(last)}`);
    check(firstReads.length === 1, 'the first snapshot read already had the workspace', `${firstReads.length} read(s), ${firstReads.at(-1).afterMs} ms`);
    result.firstReads = firstReads;
    if (process.env.AGENT_READS_PROBE_ONLY === '1') { writeResult(); return; }

    step('B', 'proving the gauge on a deliberate 120 ms block');
    const blockedGapMs = await cdp.evaluate(`new Promise((resolve) => { window.__gauge.reset(); setTimeout(() => { const end = performance.now() + 120; while (performance.now() < end); setTimeout(() => resolve(window.__gauge.max()), 30); }, 50); })`, 10_000);
    result.control = { blockedGapMs };
    check(blockedGapMs >= 80, 'the gauge saw a deliberate 120 ms block', `${Math.round(blockedGapMs)} ms`);

    for (const rows of [5000, 20000]) {
        step('M4', `opening an agent with ${rows} rows, five times`);
        const id = await agentThat(cdp, workspaceId, `m4-${rows}`, rows, 0);
        const runs = [];
        for (let i = 0; i < 5; i += 1) { runs.push(await openOnce(cdp, id, rows)); await sleep(500); }
        result[`m4_${rows}`] = { ms: median(runs.map((r) => r.ms)), maxGapMs: Math.max(...runs.map((r) => r.maxGapMs)), runs };
        await cdp.evaluate(`window.genieTest.stopAgent(${JSON.stringify(id)}); true`, 10_000);
    }

    step('M5', 'one agent streaming 50 events a second for 60 s, watched');
    const streaming = await agentThat(cdp, workspaceId, 'm5', 200, 50);
    await cdp.evaluate(`(() => { window.__updates = 0; window.__off = window.genieTest.subscribeAgent(${JSON.stringify(streaming)}, () => { window.__updates += 1; }); return true; })()`, 10_000);
    await sleep(5_000);
    const host = hostPid(h);
    const heap = createHeapSampler(cdp);
    await heap.start(); // GC and baseline precede the CPU/gap window, while the watched agent/view stay alive.
    const m5Started = performance.now();
    const before = { win: await windowCpu(inspector), host: cpuMsOf(host), updates: await cdp.evaluate('window.__updates', 5_000) };
    await cdp.evaluate('window.__gauge.reset(); true', 5_000);
    for (let i = 0; i < 4; i += 1) { await sleep(15_000); await heap.sample(); }
    const after = { win: await windowCpu(inspector), host: cpuMsOf(host), updates: await cdp.evaluate('window.__updates', 5_000), gap: await cdp.evaluate('window.__gauge.max()', 5_000) };
    const elapsedMs = performance.now() - m5Started;
    // Final forced GC is outside CPU/gap timing; keep the subscription and view, so cleanup cannot hide retained state.
    const memory = await heap.finish();
    result.m5 = { windowCpuMs: after.win - before.win, hostCpuMs: after.host - before.host, maxGapMs: after.gap, elapsedMs, updatesPerSec: (after.updates - before.updates) / (elapsedMs / 1_000), ...memory };
    check(result.m5.updatesPerSec > 0, 'M5 saw updates at all', String(result.m5.updatesPerSec));
    await cdp.evaluate(`window.__off(); window.genieTest.stopAgent(${JSON.stringify(streaming)}); true`, 10_000);

    step('M6', '30 agents registered, 3 streaming, for 30 s');
    for (let i = 0; i < 27; i += 1) {
        const added = await cdp.evaluate(`window.genieTest.addAgent(${JSON.stringify(workspaceId)}, { name: 'm6-idle-${i}', purpose: 'measure', provider: 'codex' })`, 15_000);
        if (!check(added?.ok === true, `idle agent ${i} added`, added?.reason ?? '')) throw new Error('an idle agent was not added');
    }
    const busy = [];
    for (let i = 0; i < 3; i += 1) busy.push(await agentThat(cdp, workspaceId, `m6-busy-${i}`, 0, 20));
    const m6 = await cdp.evaluate(`(async () => {
        let pushes = 0, bytes = 0;
        const off = window.genieTest.subscribe((s) => { pushes += 1; bytes = JSON.stringify(s).length; });
        await new Promise((r) => setTimeout(r, 1000));
        pushes = 0;
        window.__gauge.reset();
        const reads = [];
        const end = performance.now() + 30000;
        while (performance.now() < end) {
            const at = performance.now();
            await window.genieTest.snapshot();
            reads.push(performance.now() - at);
            await new Promise((r) => setTimeout(r, 1000));
        }
        off();
        reads.sort((a, b) => a - b);
        return { readMs: reads[Math.floor(reads.length / 2)], maxGapMs: window.__gauge.max(), pushesPerSec: pushes / 30, snapshotBytes: bytes, reads: reads.length };
    })()`, 60_000);
    result.m6 = m6;
    check(m6.pushesPerSec > 0, 'M6 saw snapshot pushes at all', String(m6.pushesPerSec));
    for (const id of busy) await cdp.evaluate(`window.genieTest.stopAgent(${JSON.stringify(id)}); true`, 10_000);

    result.finished = true;
    writeResult();
    console.log(`\nwrote ${OUT}\n${JSON.stringify({ ...result, m4_5000: { ...result.m4_5000, runs: undefined }, m4_20000: { ...result.m4_20000, runs: undefined } }, null, 2)}`);
    await cleanQuit(inspector).catch(() => {});
}

const ending = (code) => {
    result.failures = [...failures];
    result.agentLifecycle = agentLifecycle();
    writeResult();
    console.log(`  wrote ${OUT}; agent lifecycle (${result.agentLifecycle.length} lines):\n    ${result.agentLifecycle.map((l) => l.slice(0, 220)).join('\n    ')}`);
    return done(code);
};
main().then(() => ending(failures.length === 0 ? 0 : 1), (error) => { check(false, 'the run finished', error instanceof Error ? error.message : String(error)); return ending(1); });

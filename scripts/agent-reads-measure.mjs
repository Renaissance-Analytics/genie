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
 * Historical comparison: accepted evidence is at d7fd97ea. After baseline retirement, every mode refuses before timed
 * work; it never relabels the remaining protocol path as IPC. The existing failed receipt and owned cleanup still run.
 *
 *  M4  open an agent with a 5,000 and a 20,000 row ledger: subscribe to the first whole detail in the page, and the longest
 *      window gap meanwhile. Five times each; the medians. It measures delivery to the page, not the chat's own drawing.
 *  M5  one agent streaming about 50 events a second for 60 s, watched: window and genie-host CPU, the longest gap, updates/s.
 *  M6  30 agents registered, 3 streaming, for 30 s: snapshot read latency (once a second), pushes/s, the longest gap.
 *
 * The gap gauge is proven first with a deliberate 120 ms page block. Each measure also records an injected-work
 * control: real extra page work on the door, compared with the ordinary IPC observation. Control intervals stay
 * outside ordinary timing, CPU and gap results; the paired comparator requires the controls to detect the slowdown.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHeapSampler } from './agent-reads-heap.mjs';
import { measureM4Block } from './agent-reads-m4-block.mjs';
import { measureM4Stages } from './agent-reads-m4-stages.mjs';
import { busyWorkProbe, ledgerProbe, snapshotProbe } from './agent-reads-probes.mjs';
import { readMeasurementIdentity } from './agent-reads-process.mjs';
import { WIN, alive, attach, check, cleanQuit, failures, finish, gone, hostPid, launch, makeHome, readOr, refuseOffTestMachines, sleep, step, until } from './crash-cdp-lib.mjs';

refuseOffTestMachines('agent-reads-measure');

const arg = (name, fallback) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; };
const MODE = arg('mode', 'door');
const SCOPE = arg('scope', 'full');
const OUT = arg('out', `agent-reads-${MODE}.json`);
if (!['ipc', 'door', 'door-revision'].includes(MODE)) { console.error(`unknown --mode=${MODE}`); process.exit(2); }
if (!['full', 'm4-diagnostic', 'm4', 'm5-m6'].includes(SCOPE)) throw new Error(`unknown --scope=${SCOPE}`);

// Check the child's actual checkout/machine before creating any home or launching anything. Only the nonce is supplied.
const request = process.env.AGENT_READS_REQUEST ? JSON.parse(process.env.AGENT_READS_REQUEST) : null;
const identity = readMeasurementIdentity(request?.identity?.runId ?? randomUUID());
if (request !== null) {
    for (const field of ['build', 'vmId', 'platform', 'runId']) {
        if (identity[field] !== request.identity?.[field]) throw new Error(`sampler identity mismatch: ${field}`);
    }
    if (request.mode !== MODE || !Number.isSafeInteger(request.pairIndex) || request.pairIndex < 0) throw new Error('sampler mode or pair index does not match its request');
}

// Its own ports per run: a window left by an earlier run on the same port answers for this one, with its home already deleted.
const PORT = Number(process.env.AGENT_READS_CDP_PORT ?? 9400 + (process.pid % 200) * 2);
const INSPECT = Number(process.env.AGENT_READS_INSPECT ?? PORT + 1);
const MARKER = join(tmpdir(), 'genie-stub-codex-measure');
/** What the stub's next turn does (scripts/stub-codex.mjs, MEASURE mode). */
const script = (rows, rate) => writeFileSync(MARKER, JSON.stringify({ owner: process.pid, rows, rate }));
const median = (values) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const workBudget = (value) => {
    if (!Number.isFinite(value) || value < 0) throw new Error('cannot size a physical control from an invalid observation');
    return Math.min(60_000, Math.max(250, Math.ceil(value * 2)));
};

const h = makeHome('agent-reads');
// An inherited explicit home/binary must not reconnect this isolated measurement to another host or a real provider.
h.env.GENIE_HOME = h.genie;
h.env.GENIE2_CODEX_BINARY = join(process.cwd(), 'scripts', 'stub-codex.mjs');
delete h.env.GENIE_AGENT_READS;
delete h.env.GENIE_SNAPSHOT_PUSH;
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

// This sampler verifies its own cleanup BEFORE writing the receipt. Shared finish stays best-effort for its other users.
const done = finish('AGENT READS MEASURE', h, []);
let session = null;
let launched = false, ownedWindowPid = null, ownedHostPid = null;
/** Written whatever happens: a row that fails still leaves everything measured up to it, and every first read. */
const result = { identity, samplerPid: process.pid, pairIndex: request?.pairIndex ?? 0, mode: MODE, scope: SCOPE, platform: process.platform, finished: false, cleanup: { complete: false }, measureControls: {} };
const writeResult = () => writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
/** How the agents started and ended, from the host's own lifecycle log: what a start that never came needs read. */
const agentLifecycle = () => readOr(h.lifecycle).split(/\r?\n/).filter((l) => /kind=agent|agent .*(start|refus|fail)|host stall|stall main/.test(l)).slice(-80);

/** These two roots belong to the fresh isolated home; both are launched as detached groups on Linux. */
async function cleanupOwned() {
    if (!launched) return { complete: true, processes: [] };
    // A successful quit can remove host.json. Keep the PID captured while attached; on failed attach, read our own home.
    const roots = [['host', ownedHostPid ?? hostPid(h)], ['window', ownedWindowPid]];
    const seen = new Set([process.pid]);
    const processes = [];
    for (const [role, pid] of roots) {
        const entry = { role, pid, gone: false, errors: [], diagnostics: [] };
        processes.push(entry);
        if (!Number.isSafeInteger(pid) || pid < 1 || seen.has(pid)) {
            entry.errors.push('missing, duplicate or self PID');
            check(false, `cleanup ${role}: identifiable owned process`, String(pid));
            continue;
        }
        seen.add(pid);
        try {
            if (alive(pid)) {
                if (WIN) {
                    const output = execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 15_000, windowsHide: true });
                    if (output) entry.diagnostics.push(String(output).slice(0, 8_000));
                }
                else process.kill(-pid, 'SIGKILL');
            }
        } catch (error) {
            // taskkill /T can fail after an already-exited descendant: the independent exit reading below judges it.
            entry.diagnostics.push(error instanceof Error ? error.message : String(error));
            for (const output of [error?.stdout, error?.stderr]) if (output) entry.diagnostics.push(String(output).slice(0, 8_000));
        }
        // Confirm each root independently even after another root's termination failed; never skip the remaining cleanup.
        try {
            entry.gone = await gone(pid, 10_000);
            check(entry.gone, `cleanup ${role}: owned process exited`, String(pid));
        } catch (error) {
            entry.errors.push(error instanceof Error ? error.message : String(error));
            check(false, `cleanup ${role}: confirm exit`, entry.errors.at(-1));
        }
        if (entry.diagnostics.length) console.log(`  cleanup ${role} command diagnostics: ${entry.diagnostics.join('\n')}`);
    }
    return { complete: processes.every((entry) => entry.gone && entry.errors.length === 0), processes };
}

/** Add an agent, start it, give it its turn; `rows` long before it streams at `rate`. */
async function agentThat(cdp, workspaceId, name, rows, rate) {
    const added = await cdp.evaluate(`window.genieTest.addAgent(${JSON.stringify(workspaceId)}, { name: ${JSON.stringify(name)}, purpose: 'measure', provider: 'codex' })`, 15_000);
    if (!check(added?.ok === true, `agent ${name} added`, added?.reason ?? '')) throw new Error(`agent ${name} not added`);
    script(rows, rate);
    // Keep the real reply: a refused restart does not emit a start phase, so a running-only timeout loses its cause.
    const restartAt = Date.now();
    const restart = await cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(added.id)}, "graceful")`, 15_000);
    (result.agentStarts ??= []).push({ id: added.id, name, restart, elapsedMs: Date.now() - restartAt });
    writeResult();
    console.log(`  agent ${name} restart reply: ${JSON.stringify(restart)}`);
    if (restart?.ok !== true) throw new Error(`${name} restart refused: ${restart?.reason ?? 'missing restart reply'}`);
    const started = await until(() => cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(added.id)}).then((d) => d?.session?.running === true)`, 15_000), 60_000);
    if (!check(started === true, `${name} is running`)) {
        result.failedStart = { id: added.id, name, detail: await cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(added.id)}).then((d) => ({ session: d?.session, refusal: d?.refusal, log: (d?.log ?? []).slice(-10) }))`, 15_000).catch((error) => ({ unread: String(error) })) };
        writeResult();
        throw new Error(`${name} did not start: ${JSON.stringify(result.failedStart)}`);
    }
    await cdp.evaluate(`window.genieTest.prompt(${JSON.stringify(added.id)}, 'measure')`, 15_000);
    if (rows > 0) {
        const reached = await until(() => cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(added.id)}).then((d) => (d?.rows?.length ?? 0) >= ${rows})`, 30_000), 240_000, 2_000);
        if (!check(reached === true, `${name} holds ${rows} rows`)) throw new Error(`${name} never reached ${rows} rows`);
    }
    return added.id;
}

/** Subscribe, and time the first whole detail. */
const openOnce = (cdp, id, rows, extraWorkMs = 0) => cdp.evaluate(ledgerProbe(id, rows, extraWorkMs), 130_000);

async function main() {
    step('A', `launching, mode ${MODE}`);
    const taken = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false);
    if (taken) throw new Error(`something already answers on the debugging port ${PORT}: it would be measured instead of this run`);
    const app = launch(h, { port: PORT, inspect: INSPECT, label: MODE });
    launched = true;
    ownedWindowPid = app.child.pid;
    result.launchedPid = ownedWindowPid;
    writeResult(); // Partial evidence cannot pass the parent's finished/cleanup checks.
    if (!Number.isSafeInteger(ownedWindowPid) || ownedWindowPid < 1 || ownedWindowPid === process.pid) throw new Error('no identifiable owned window PID');
    session = await attach({ port: PORT, inspect: INSPECT, label: MODE });
    ownedHostPid = hostPid(h); // Capture before a later natural quit can remove the record.
    result.hostPid = ownedHostPid;
    if (!Number.isSafeInteger(ownedHostPid) || ownedHostPid < 1 || ownedHostPid === process.pid || ownedHostPid === ownedWindowPid) throw new Error('no identifiable owned host PID');
    const { cdp, inspector } = session;
    result.windowPid = session.windowPid;
    result.launchedPid = app.child.pid;
    if (!check(session.windowPid === app.child.pid, 'the window being measured is the one this run launched', `window ${session.windowPid}, launched ${app.child.pid}`)) throw new Error('debugging port belongs to another window');
    const retired = 'Historical IPC comparison is unavailable on this build; use the accepted baseline at d7fd97ea.';
    let baseline = null;
    try {
        baseline = await inspector.evaluate(`(() => {
            const ipc = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').ipcMain;
            const handlers = ipc._invokeHandlers;
            return {
                snapshot: typeof handlers?.has === 'function' && handlers.has('genie:snapshot'),
                detail: typeof handlers?.has === 'function' && handlers.has('genie:agent-detail'),
                watch: typeof ipc.listenerCount === 'function' && ipc.listenerCount('genie:agent-watch') > 0,
            };
        })()`, 5_000);
    } catch (error) { result.baselineInspectionError = error instanceof Error ? error.message : String(error); }
    result.baselineSupport = baseline;
    if (!check(baseline?.snapshot === true && baseline?.detail === true && baseline?.watch === true, 'historical IPC baseline is available', retired)) throw new Error(retired);
    let selected = false;
    try { selected = await cdp.evaluate(`typeof window.genieAgentReadsIpc === 'boolean' && window.genieAgentReadsIpc === ${MODE === 'ipc'}`, 5_000); }
    catch (error) { result.baselineSelectionError = error instanceof Error ? error.message : String(error); }
    result.baselineSelected = selected === true;
    if (!check(result.baselineSelected, 'requested historical read path is selected', retired)) throw new Error(retired);
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

    for (const rows of SCOPE === 'm5-m6' ? [] : [5000, 20000]) {
        step('M4', `opening an agent with ${rows} rows, five times`);
        const id = await agentThat(cdp, workspaceId, `m4-${rows}`, rows, 0);
        const measure = `m4_${rows}`;
        if (SCOPE === 'm4-diagnostic') {
            const block = await measureM4Block({
                openOrdinary: () => openOnce(cdp, id, rows), sleep,
                openControl: async (ordinary) => {
                    result[measure] = ordinary;
                    const extraWorkMs = MODE === 'ipc' ? 0 : workBudget(ordinary.ms);
                    const control = extraWorkMs === 0 ? ordinary : await openOnce(cdp, id, rows, extraWorkMs);
                    result.measureControls[measure] = { metric: 'ms', value: control.ms, extraWorkMs, maxGapMs: control.maxGapMs };
                    return control;
                },
                // Markers exist only for this EXTRA open, after the unchanged five ordinary opens and their control.
                openStages: () => measureM4Stages({ agentId: id, mode: MODE, inspector, cdp, openExtra: () => openOnce(cdp, id, rows) }),
            });
            (result.m4Stages ??= {})[measure] = block.stages;
            writeResult();
            await cdp.evaluate(`window.genieTest.stopAgent(${JSON.stringify(id)}); true`, 10_000);
            continue;
        }
        const runs = [];
        for (let i = 0; i < 5; i += 1) { runs.push(await openOnce(cdp, id, rows)); await sleep(500); }
        result[measure] = { ms: median(runs.map((r) => r.ms)), maxGapMs: Math.max(...runs.map((r) => r.maxGapMs)), runs };
        const extraWorkMs = MODE === 'ipc' ? 0 : workBudget(result[measure].ms);
        const control = extraWorkMs === 0 ? result[measure] : await openOnce(cdp, id, rows, extraWorkMs);
        result.measureControls[measure] = { metric: 'ms', value: control.ms, extraWorkMs, maxGapMs: control.maxGapMs };
        await cdp.evaluate(`window.genieTest.stopAgent(${JSON.stringify(id)}); true`, 10_000);
    }

    if (SCOPE === 'm4-diagnostic' || SCOPE === 'm4') {
        result.finished = true;
        writeResult();
        console.log(`M4-only ${SCOPE === 'm4' ? 'acceptance sample' : 'diagnostic (NOT ACCEPTANCE)'} acquired: ${OUT}; no M5/M6 workloads`);
        await cleanQuit(inspector).catch(() => {});
        return;
    }

    step('M5', 'one agent streaming 50 events a second for 60 s, watched');
    const streaming = await agentThat(cdp, workspaceId, 'm5', 200, 50);
    await cdp.evaluate(`(() => { window.__updates = 0; window.__off = window.genieTest.subscribeAgent(${JSON.stringify(streaming)}, () => { window.__updates += 1; }); return true; })()`, 10_000);
    await sleep(5_000);
    const host = ownedHostPid;
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
    const extraWorkMs = MODE === 'ipc' ? 0 : workBudget(result.m5.windowCpuMs);
    let extraCpuMs = 0;
    if (extraWorkMs > 0) {
        const cpuBefore = await windowCpu(inspector);
        await cdp.evaluate(busyWorkProbe(extraWorkMs), extraWorkMs + 5_000);
        extraCpuMs = await windowCpu(inspector) - cpuBefore;
    }
    // Sum two disjoint observed CPU intervals, never a requested budget or a multiplier of the reported result.
    result.measureControls.m5 = { metric: 'windowCpuMs', value: result.m5.windowCpuMs + extraCpuMs, extraCpuMs, extraWorkMs };
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
            reads.push(await ${snapshotProbe()});
            await new Promise((r) => setTimeout(r, 1000));
        }
        off();
        reads.sort((a, b) => a - b);
        return { readMs: reads[Math.floor(reads.length / 2)], maxGapMs: window.__gauge.max(), pushesPerSec: pushes / 30, snapshotBytes: bytes, reads: reads.length };
    })()`, 60_000);
    result.m6 = m6;
    check(m6.pushesPerSec > 0, 'M6 saw snapshot pushes at all', String(m6.pushesPerSec));
    const snapshotWorkMs = MODE === 'ipc' ? 0 : workBudget(m6.readMs);
    const snapshotControlMs = snapshotWorkMs === 0 ? m6.readMs : await cdp.evaluate(snapshotProbe(snapshotWorkMs), snapshotWorkMs + 10_000);
    result.measureControls.m6 = { metric: 'readMs', value: snapshotControlMs, extraWorkMs: snapshotWorkMs };
    for (const id of busy) await cdp.evaluate(`window.genieTest.stopAgent(${JSON.stringify(id)}); true`, 10_000);

    result.finished = true;
    writeResult();
    const concise = { ...result };
    for (const group of ['m4_5000', 'm4_20000']) if (result[group]) concise[group] = { ...result[group], runs: undefined };
    console.log(`\nwrote ${OUT}\n${JSON.stringify(concise, null, 2)}`);
    await cleanQuit(inspector).catch(() => {});
}

const ending = async (code) => {
    result.agentLifecycle = agentLifecycle();
    result.cleanup = await cleanupOwned();
    if (session) {
        for (const connection of [session.cdp, session.inspector]) {
            try { check(await connection.closed(5_000), 'measurement debugger connection closed'); }
            catch (error) { check(false, 'measurement debugger connection closed', error instanceof Error ? error.message : String(error)); }
        }
    }
    result.failures = [...failures];
    writeResult();
    console.log(`  wrote ${OUT}; agent lifecycle (${result.agentLifecycle.length} lines):\n    ${result.agentLifecycle.map((l) => l.slice(0, 220)).join('\n    ')}`);
    return done(code !== 0 || !result.cleanup.complete || failures.length > 0 ? 1 : 0);
};
main().then(() => ending(failures.length === 0 ? 0 : 1), (error) => { check(false, 'the run finished', error instanceof Error ? error.message : String(error)); return ending(1); });

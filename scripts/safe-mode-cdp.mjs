#!/usr/bin/env node
/**
 * SAFE MODE, AS A PERSON MEETS IT, in the real app (Tynn #386; core/safe-mode.ts, safe-mode-host.ts, SafeModeBanner.tsx).
 *
 *   node scripts/safe-mode-cdp.mjs            (Linux: under xvfb-run)
 *
 * It starts Genie itself, on a home and ports of its own, with one workspace and two codex agents streaming through the
 * stub app server (its ticker mode: mid-turn, for as long as this script lives).
 *
 *   CONTROL FIRST: a CLEAN quit ("Shut down everything", the product's own quit with the person's click answered), then a
 *   relaunch: NO banner, no "did not end cleanly" in genie-host's log, and both agents start again by themselves. So the
 *   rows below can tell an unclean end from a clean one.
 *
 *   THE CRASH: the window process and genie-host are both ended at once, uncleanly, BY PID — the window main's own
 *   (`process.pid` over its inspector) and the one in genie-host's own record (runtime/host.json) — never a pattern. Then a
 *   relaunch:
 *     - the banner shows, and genie-host's log says the last run did not end cleanly and nothing starts by itself;
 *     - neither agent runs: the host's own view (each session) says not running, no stub streams for either, no new
 *       provider process exists, and the providers the killed run left are ended (Tynn #796);
 *     - the banner lists what was running: each agent, with its own Start.
 *   Start on the first agent: it runs again (the host says so, its provider streams) and the banner says Started. Leave safe
 *   mode: the banner goes, and nothing else starts by itself — the second agent stays stopped.
 *
 * Exit: 0 every check passed; 1 a check failed; 2 cannot run here.
 */
import {
    alive, attach, check, cleanQuit, failures, finish, gone, hostLogSince, hostPid, killHard, launch, makeHome,
    readOr, refuseOffTestMachines, running, sleep, step, stubPids, tickerOn, ticksOf, twoStreamingAgents, until, whyOf,
} from './crash-cdp-lib.mjs';

refuseOffTestMachines('safe-mode-cdp');
const PORT = Number(process.env.SAFE_CDP_PORT ?? 9352);
const INSPECT = Number(process.env.SAFE_CDP_INSPECT ?? 9353);
const h = makeHome('safe-mode');
const DID_NOT_END = /safe mode: the last run did not end cleanly/;
let app = null;
let session = null;
const done = finish('SAFE MODE', h, [
    async () => { if (session) for (const id of agentIds) await session.cdp.evaluate(`window.genie.stopAgent(${JSON.stringify(id)}); true`, 10_000).catch(() => {}); },
    async () => { if (session && app && !app.exited) { await cleanQuit(session.inspector).catch(() => {}); await Promise.race([app.exit, sleep(30_000)]); } },
    async () => { const pid = hostPid(h); if (pid !== null && alive(pid)) { killHard(pid); await gone(pid, 10_000); } },
    async () => { if (app && !app.exited) { killHard(app.child.pid); await Promise.race([app.exit, sleep(10_000)]); } },
]);
const agentIds = [];
setTimeout(() => { check(false, 'the run finished within its deadline (480 s)'); void done(1); }, Number(process.env.SAFE_CDP_DEADLINE_MS ?? 480_000)).unref();

const bannerShown = () => session.cdp.evaluate(`Boolean(document.querySelector('[data-safe-mode]'))`, 10_000);

console.log('\nSAFE MODE — what a person sees after Genie did not end cleanly, and what does not start\n');
try {
    tickerOn();
    step('A1', 'first launch, on a home of its own');
    app = launch(h, { port: PORT, inspect: INSPECT, label: 'first' });
    session = await attach({ port: PORT, inspect: INSPECT, label: 'first' });
    step('A2', 'two agents, streaming');
    const { agents } = await twoStreamingAgents(session.cdp, `safe-${process.pid}`);
    for (const a of agents) agentIds.push(a.id);

    // ------------------------------------------------------------------ CONTROL: a clean quit
    step('A3', 'a CLEAN quit: the product\'s own, answered "Shut down everything"');
    const hostA = hostPid(h);
    check(await cleanQuit(session.inspector) === 'ok', 'A3. the quit was asked through the product\'s own app.quit()');
    session = null;
    check(await Promise.race([app.exit, sleep(60_000).then(() => false)]) === true, 'A4. the window process ended');
    check(hostA !== null && await gone(hostA, 60_000), 'A5. genie-host ended with it (the record\'s pid is gone)', String(hostA));
    const logAtB = readOr(h.hostLog).length;

    step('B1', 'relaunch after the clean quit');
    app = launch(h, { port: PORT, inspect: INSPECT, label: 'after-clean' });
    session = await attach({ port: PORT, inspect: INSPECT, label: 'after-clean' });
    const hostB = await until(() => { const p = hostPid(h); return p !== null && p !== hostA ? p : null; }, 30_000);
    check(hostB !== null, 'B1. on a new genie-host', `${hostA} -> ${hostB}`);
    const restarted = await until(async () => (await Promise.all(agents.map((a) => running(session.cdp, a.id)))).every(Boolean), 60_000);
    check(restarted === true, 'B2. CONTROL: after a clean quit both agents start again by themselves', restarted === true ? '' : (await Promise.all(agents.map((a) => whyOf(session.cdp, a.id)))).join(' | '));
    check(await bannerShown() === false, 'B3. CONTROL: and there is no safe-mode banner', 'positive control for the rows below: the gauge reads an unclean end only');
    check(!DID_NOT_END.test(hostLogSince(h, logAtB)), 'B4. CONTROL: and genie-host does not say the last run ended uncleanly');
    for (const a of agents) {
        const t = await until(async () => { const x = await ticksOf(session.cdp, a.id); return x.last !== null && alive(x.last) ? x : null; }, 45_000);
        check(t !== null, `B5. ${a.name} streams again (mid-turn, for the crash below)`, t ? `tick ${t.max} from pid ${t.last}` : 'no live provider');
    }

    // ------------------------------------------------------------------ THE CRASH: both processes, by pid, at once
    step('C1', 'ending the window and genie-host uncleanly, by pid');
    const windowPid = session.windowPid;
    const hostC = hostPid(h);
    const stubsBefore = new Set(stubPids());
    const ticksBefore = new Map();
    for (const a of agents) ticksBefore.set(a.id, await ticksOf(session.cdp, a.id));
    const providersBefore = new Set([...ticksBefore.values()].flatMap((x) => x.pids));
    await session.inspector.closed(5_000);
    killHard(windowPid);
    killHard(hostC);
    check(await gone(windowPid, 15_000) && await gone(hostC, 15_000), 'C1. the window main and genie-host are gone', `window ${windowPid}, host ${hostC}`);
    await Promise.race([app.exit, sleep(15_000)]);
    session = null;
    const logAtD = readOr(h.hostLog).length;

    step('D1', 'relaunch after the crash');
    app = launch(h, { port: PORT, inspect: INSPECT, label: 'after-crash' });
    session = await attach({ port: PORT, inspect: INSPECT, label: 'after-crash' });
    const hostD = await until(() => { const p = hostPid(h); return p !== null && p !== hostC ? p : null; }, 30_000);
    check(hostD !== null, 'D1. on a new genie-host', `${hostC} -> ${hostD}`);
    check(await until(bannerShown, 30_000) === true, 'D2. the safe-mode banner shows');
    check(await until(() => DID_NOT_END.test(hostLogSince(h, logAtD)), 15_000) === true, 'D3. genie-host says the last run did not end cleanly and nothing starts by itself');
    // Settle past any restore that would have run, then read the host's view and the process table.
    await sleep(8_000);
    for (const a of agents) {
        check(await running(session.cdp, a.id) === false, `D4. ${a.name} is NOT running (the host's own view of its session)`);
        const before = ticksBefore.get(a.id);
        // Its history first (the ledger pages in after a relaunch), then nothing new over 5 s.
        const now = await until(async () => { const x = await ticksOf(session.cdp, a.id); return x.max >= before.max ? x : null; }, 20_000) ?? await ticksOf(session.cdp, a.id);
        await sleep(5_000);
        const later = await ticksOf(session.cdp, a.id);
        check(now.max >= before.max && later.max === now.max, `D5. no provider streams for ${a.name}`, `tick ${before.max} before the crash; ${now.max} → ${later.max} over 5 s after`);
    }
    const providersNow = stubPids();
    const fresh = providersNow.filter((p) => !stubsBefore.has(p));
    check(fresh.length === 0, 'D6. no provider process was started', fresh.length === 0 ? `${providersNow.length} stub process(es), none new` : `new: ${fresh.join(', ')}`);
    const leftOver = await until(() => { const left = [...providersBefore].filter(alive); return left.length === 0 ? 'none' : null; }, 30_000);
    check(leftOver === 'none', 'D7. the providers the killed run left are ended (Tynn #796)', leftOver ?? [...providersBefore].filter(alive).join(', '));
    const listed = await session.cdp.evaluate(`JSON.stringify([...document.querySelectorAll('[data-safe-mode] [data-action="safe-mode-start"]')].map((b) => ({ kind: b.dataset.kind, id: b.dataset.id })))`, 10_000);
    const rows = JSON.parse(listed);
    check(agents.every((a) => rows.some((r) => r.kind === 'agent' && r.id === a.id)), 'D8. the banner lists what was running: each agent, with its own Start', listed);
    console.log(`  (the banner's other rows: ${rows.filter((r) => r.kind !== 'agent').length} — no site, flow or scheduled task was set up in this home)`);

    // ------------------------------------------------------------------ Start one; leave
    const [first, second] = agents;
    step('E1', `Start on ${first.name}`);
    await session.cdp.evaluate(`document.querySelector('[data-safe-mode] [data-action="safe-mode-start"][data-kind="agent"][data-id=${JSON.stringify(first.id)}]').click(); true`, 10_000);
    const startedAgain = await until(() => running(session.cdp, first.id), 45_000);
    check(startedAgain === true, `E1. ${first.name} runs again (the host says so)`, startedAgain === true ? '' : await whyOf(session.cdp, first.id));
    check(await until(() => session.cdp.evaluate(`document.querySelector('[data-safe-mode-outcome=${JSON.stringify(`agent:${first.id}`)}]')?.textContent === 'Started'`, 10_000), 30_000) === true, 'E2. the banner says Started for it');
    await session.cdp.evaluate(`window.genie.prompt(${JSON.stringify(first.id)}, 'Stream ticks until stopped.')`, 15_000).catch(() => null);
    const streaming = await until(async () => { const x = await ticksOf(session.cdp, first.id); return x.last !== null && !providersBefore.has(x.last) && alive(x.last) ? x : null; }, 45_000);
    check(streaming !== null, `E3. ${first.name}'s new provider streams`, streaming ? `pid ${streaming.last}` : 'none');
    check(await running(session.cdp, second.id) === false, `E4. ${second.name} is still not running: the Start was for that one only`);

    step('F1', 'Leave safe mode');
    await session.cdp.evaluate(`document.querySelector('[data-action="safe-mode-leave"]').click(); true`, 10_000);
    check(await until(async () => (await bannerShown()) === false, 30_000) === true, 'F1. the banner goes');
    await sleep(10_000);
    check(await running(session.cdp, second.id) === false, `F2. nothing else starts by itself: ${second.name} stays stopped`);
    const extra = stubPids().filter((p) => !stubsBefore.has(p) && p !== streaming?.last);
    check(extra.length === 0, 'F3. and no other provider process appeared', extra.join(', ') || 'none');
} catch (error) {
    check(false, 'the run did not finish', String(error?.message ?? error).slice(0, 300));
}
await done(failures.length > 0 ? 1 : 0);

#!/usr/bin/env node
/**
 * A WINDOW'S PAGE THAT ENDS, BROUGHT BACK — in the real app (Tynn #386; main/renderer-recovery.ts). The owner's window
 * went black for 3.5 hours on 2026-11-06: its page ran out of memory, main lived on, and nothing reloaded it.
 *
 *   node scripts/renderer-crash-cdp.mjs            (Linux: under xvfb-run)
 *
 * It starts Genie on a home and ports of its own, with two codex agents streaming, and ends the main window's page from
 * window main's inspector (`webContents.forcefullyCrashRenderer()` — a real renderer end, the one Electron reports):
 *   CONTROL first: no notice before anything ends;
 *   the page comes back, says so (the notice, with Send a crash report), the agents run on (the same host, the same
 *   provider pid, ticks still growing), and a crash record says the page ended with its last memory;
 *   three more ends within 10 minutes: no fourth reload — the plain page with Restart Genie and Send a crash report; and
 *   Restart Genie builds the window again, the same host, the app back in it.
 *
 * Exit: 0 every check passed; 1 a check failed; 2 cannot run here.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    alive, attach, check, cleanQuit, failures, finish, gone, hostPid, killHard, launch, makeHome, readOr,
    refuseOffTestMachines, running, sleep, step, tickerOn, ticksOf, twoStreamingAgents, until, Cdp,
} from './crash-cdp-lib.mjs';

refuseOffTestMachines('renderer-crash-cdp');
const PORT = Number(process.env.RENDERER_CDP_PORT ?? 9360);
const INSPECT = Number(process.env.RENDERER_CDP_INSPECT ?? 9361);
const h = makeHome('renderer-crash');
let app = null;
let session = null;
const done = finish('RENDERER CRASH', h, [
    async () => { if (session) await cleanQuit(session.inspector).catch(() => {}); await sleep(3_000); },
    async () => { const pid = hostPid(h); if (pid !== null && alive(pid)) { killHard(pid); await gone(pid, 10_000); } },
    async () => { if (app && !app.exited) { killHard(app.child.pid); await Promise.race([app.exit, sleep(10_000)]); } },
]);
setTimeout(() => { check(false, 'the run finished within its deadline (480 s)'); void done(1); }, Number(process.env.RENDERER_CDP_DEADLINE_MS ?? 480_000)).unref();

/** Ends the main window's page from window main, as Electron's own renderer end. */
const crashThePage = (inspector) => inspector.evaluate(`(() => {
    const m = process.getBuiltinModule('node:module');
    const { webContents } = m.createRequire(process.execPath)('electron');
    const page = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getType() === 'window' && /renderer[\\\\/]index\\.html/.test(w.getURL()));
    if (!page) return 'no main page';
    page.forcefullyCrashRenderer();
    return 'ok';
})()`, 10_000);
/** The page on the debugger port, whatever it is now (the app, or the plain page). */
async function pageNow() {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3_000) })).json().catch(() => []);
    // The main window, or the plain page that replaces it (a data: URL); never devtools nor the host-wait window.
    return mainWindow(targets) ?? targets.find((t) => t.type === 'page' && String(t.url).startsWith('data:text/html')) ?? null;
}
const notice = (cdp) => cdp.evaluate(`(() => { const n = document.querySelector('[data-renderer-notice]'); return n ? { reason: n.getAttribute('data-renderer-notice'), text: n.textContent, report: Boolean(n.querySelector('[data-action="crash-report-open"]')) } : null; })()`, 10_000);
function pageRecords() {
    try {
        return readdirSync(h.crashDir).filter((n) => n.endsWith('.json')).map((n) => { try { return JSON.parse(readFileSync(join(h.crashDir, n), 'utf8')); } catch { return null; } })
            .filter((r) => r && r.kind === 'exit' && String(r.reason).startsWith('render-process-gone:renderer:'));
    } catch { return []; }
}

console.log("\nA WINDOW'S PAGE THAT ENDS — brought back, said, and the agents running on\n");
try {
    tickerOn();
    step('A1', 'launching, on a home of its own');
    app = launch(h, { port: PORT, inspect: INSPECT, label: 'first' });
    session = await attach({ port: PORT, inspect: INSPECT, label: 'first' });
    const { agents } = await twoStreamingAgents(session.cdp, `page-${process.pid}`);
    const hostA = hostPid(h);
    check(await notice(session.cdp) === null, 'A2. CONTROL: no notice before anything ended');

    step('B1', 'ending the main window\'s page from window main');
    const before = new Map();
    for (const a of agents) before.set(a.id, await ticksOf(session.cdp, a.id));
    const windowPid = session.windowPid;
    check(await crashThePage(session.inspector) === 'ok', 'B1. the page was ended (forcefullyCrashRenderer)');
    await session.cdp.closed(2_000);
    session = await attach({ port: PORT, inspect: INSPECT, label: 'after-end-1' });
    check(session.windowPid === windowPid, 'B2. the same window process: only its page ended', `${windowPid} -> ${session.windowPid}`);
    const shown = await until(() => notice(session.cdp), 30_000);
    check(shown !== null && /and was reloaded at .*Your agents kept running\./.test(shown.text ?? ''), 'B3. the page came back and says so', JSON.stringify(shown));
    check(shown?.report === true, 'B4. with Send a crash report');
    check(hostPid(h) === hostA && alive(hostA), 'B5. the same genie-host ran on', `${hostA} -> ${hostPid(h)}`);
    for (const a of agents) {
        const was = before.get(a.id);
        const after = await until(async () => { const x = await ticksOf(session.cdp, a.id); return x.max > was.max ? x : null; }, 30_000);
        check(after !== null && after.running && after.last === was.last, `B6. ${a.name} ran on: the same provider, still streaming`, after ? `pid ${was.last} -> ${after.last}, tick ${was.max} -> ${after.max}` : 'no new tick');
    }
    const records = await until(() => (pageRecords().length > 0 ? pageRecords() : null), 15_000) ?? [];
    check(records.length > 0, 'B7. a crash record says the page ended', records.map((r) => r.reason).join(', '));
    check(records.some((r) => typeof r.rendererMb === 'number' && r.rendererMb > 0), 'B8. with the page\'s last known memory', JSON.stringify(records.map((r) => r.rendererMb)));
    check(/page ended reason=\S+ renderer_mb=\S+: reloaded \(1 of 3/.test(readOr(h.lifecycle)), 'B9. the lifecycle log says it was reloaded');

    step('C1', 'three more ends within 10 minutes');
    for (let n = 2; n <= 4; n++) {
        const r = await crashThePage(session.inspector).catch((e) => String(e?.message ?? e));
        check(r === 'ok', `C1.${n}. end ${n}`, r);
        await session.cdp.closed(2_000);
        await sleep(1_500);
        if (n < 4) session = { ...session, ...(await attach({ port: PORT, inspect: INSPECT, label: `after-end-${n}` })) };
    }
    const plain = await until(async () => { const p = await pageNow(); return p && String(p.url).startsWith('data:text/html') ? p : null; }, 20_000);
    check(plain !== null, 'C2. no fourth reload: the plain page', plain?.url?.slice(0, 40) ?? 'none');
    if (plain) {
        const cdp = await Cdp.connect(plain.webSocketDebuggerUrl, 'plain page');
        // The plain page is a data: URL that can still be parsing when its target appears: `document.body` was null twice
        // ("plain page threw: TypeError: Cannot read properties of null (reading 'innerText')", jobs 128296453480 and
        // 128367673835). Wait for its body and its words, at most 15 s, then read it once more for C3 as before.
        const bodyText = `document.body ? document.body.innerText : ''`;
        const text = String((await until(async () => { const t = String(await cdp.evaluate(bodyText, 5_000)); return /Restart Genie/.test(t) ? t : null; }, 15_000, 200)) ?? await cdp.evaluate(bodyText, 5_000));
        check(/Restart Genie/.test(text) && /Send a crash report/.test(text), 'C3. with Restart Genie and Send a crash report', text.slice(0, 160).replace(/\n/g, ' | '));
        step('D1', 'Restart Genie');
        await cdp.evaluate(`document.querySelector('[data-action="renderer-restart"]').click(); true`, 10_000).catch(() => null);
        await cdp.closed(2_000);
        const back = await until(async () => { const p = await pageNow(); return p && /renderer[\\/]index\.html/.test(String(p.url)) ? p : null; }, 30_000);
        check(back !== null, 'D1. the window was built again with the app in it', back?.url?.slice(-40) ?? 'none');
        if (back) {
            session = await attach({ port: PORT, inspect: INSPECT, label: 'rebuilt' });
            check(hostPid(h) === hostA && alive(hostA), 'D2. on the same genie-host');
            check(await running(session.cdp, agents[0].id) === true, 'D3. the agents still run');
        }
    }
} catch (error) {
    check(false, 'the run did not finish', String(error?.message ?? error).slice(0, 300));
}
await done(failures.length > 0 ? 1 : 0);

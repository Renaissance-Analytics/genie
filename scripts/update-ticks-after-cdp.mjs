#!/usr/bin/env node
/**
 * THE AGENT STREAMED THROUGH THE INSTALL (Tynn #1036 P6-1): the second half of a client-only update row
 * (scripts/vm-client-only-update.ps1, scripts/vm-client-only-update-linux.sh). The first half is update-cdp.mjs with
 * UPDATE_TICKS_FILE: the agent's provider is the stub app server in its TICKER mode (scripts/stub-codex.mjs: `tick <n>
 * pid <pid>` four times a second, switched on by the row's marker file holding the row's own pid), streaming when install
 * is asked, and where its ledger stood then is in that file. The install closes the window; for the whole of it there is
 * none. This runs against a window of the INSTALLED build opened after the install, over the same genie-host, and checks,
 * as scripts/quit-keeps-host-cdp.mjs does across a close (rows 20-23):
 *
 *   the agent is still running, its ledger names the SAME provider pid (alive), the ledger GREW by at least half the ticks
 *   the time since install was asked allows, and every tick from the one after install was asked to the last is in it, in
 *   order, with no gap.
 *
 *   UPDATE_TICKS_FILE=<file> [CDP_PORT=9222] node scripts/update-ticks-after-cdp.mjs
 *
 * Prints `### update-ticks=PASS|FAIL`; exits 0 when every check passed, 1 otherwise, 2 when it cannot run.
 */
import { readFileSync } from 'node:fs';
import { mainWindow } from './cdp-main-window.mjs';
import { alive, Cdp, check, contiguous, failures, ticksOf, until } from './crash-cdp-lib.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';

const PORT = Number(process.env.CDP_PORT ?? 9222);
const file = process.env.UPDATE_TICKS_FILE;
if (!file) { console.error('UPDATE_TICKS_FILE is required'); process.exit(2); }
let before;
try { before = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { console.error(`no ledger record from before the install at ${file}: ${error.message}`); process.exit(2); }
console.log(`\nTHE AGENT THROUGH THE INSTALL — before: agent ${before.agentId}, provider pid ${before.pid}, ticks to ${before.max}, install asked at ${new Date(before.askedAt).toISOString()}\n`);

let cdp = null;
try {
    const page = await until(async () => mainWindow(await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3_000) })).json()), 90_000);
    if (!check(page !== null && page !== undefined, '1. a window of the installed build is on the debugger port', `port ${PORT}`)) throw new Error('no window');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl, 'the window after the install');
    await waitForPageProbe(cdp);
    const elapsed = Date.now() - before.askedAt;
    const after = await until(async () => { const x = await ticksOf(cdp, before.agentId); return x.max > before.max ? x : null; }, 60_000) ?? await ticksOf(cdp, before.agentId);
    check(after.running === true, '2. the agent is still running', String(after.running));
    check(after.pids.length === 1 && after.pids[0] === before.pid && alive(before.pid), '3. the SAME provider pid streams, alive', `${before.pid} → ${JSON.stringify(after.pids)}`);
    // Half of what four ticks a second allows over the time since install was asked: a stream held for the install's length is under it.
    const wanted = Math.floor(elapsed / 250 / 2);
    check(after.max - before.max >= wanted, '4. the ledger GREW through the install', `ticks ${before.max} → ${after.max} (≥ ${wanted} wanted over ${Math.round(elapsed / 1000)} s)`);
    const numbers = new Set(after.ticks.filter((t) => t.pid === before.pid).map((t) => t.tick));
    const gap = contiguous(numbers, before.max + 1, after.max);
    check(gap === null, '5. every tick streamed while there was no window is in the ledger, in order', gap === null ? `${before.max + 1}..${after.max}` : `tick ${gap} missing`);
} catch (error) {
    check(false, 'the window after the install could not be read', String(error?.message ?? error));
} finally {
    if (cdp) await cdp.closed().catch(() => false);
}
console.log(failures.length === 0 ? '### update-ticks=PASS' : `### update-ticks=FAIL ${failures.join(' | ')}`);
process.exit(failures.length === 0 ? 0 : 1);

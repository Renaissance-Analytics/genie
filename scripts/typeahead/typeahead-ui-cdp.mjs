#!/usr/bin/env node
/**
 * THE UI PATH: what a person does — a Terminals panel placed in a new tab, xterm's textarea focused, the command typed
 * with CDP `Input.insertText` and Enter as real key events — at each delay after the panel's xterm MOUNTS (its rows in the
 * page). The same path smoke-cdp rows 37/38 take. Compared with the API path (typeahead-genie-cdp.mjs) and conpty direct,
 * a loss only here is the UI's: xterm not attached to its terminal, or not focused, yet.
 *
 *   node scripts/typeahead/typeahead-ui-cdp.mjs        (CI only: it launches Electron)
 */
import { attach, cleanQuit, launch, makeHome, refuseOffTestMachines, sleep, until } from '../crash-cdp-lib.mjs';

refuseOffTestMachines('typeahead-ui-cdp');
const DELAYS = [0, 250, 500, 1000, 2000];
const RUNS = 5;
const PORT = 9366, INSPECT = 9367;
const h = makeHome('typeahead-ui');
const app = launch(h, { port: PORT, inspect: INSPECT, label: 'typeahead-ui' });
const session = await attach({ port: PORT, inspect: INSPECT, label: 'typeahead-ui' });
const { cdp } = session;
const workspaceId = (await cdp.evaluate('window.genie.snapshot()', 15_000))?.workspaces?.[0]?.id;
if (typeof workspaceId !== 'string') { console.log('TYPEAHEAD ui unavailable: no workspace'); process.exit(1); }

/** This run's pane (marked when it mounted): its rows, joined (a narrow pane wraps a typed command). */
const rowsOfNewest = `(() => { const p = document.querySelector('[data-ta-current]'); return (p?.querySelector('.xterm-rows')?.innerText ?? '').replace(/\\n/g, ''); })()`;
/** Every pane in the page now is an earlier run's. */
const markSeen = `(() => { for (const p of document.querySelectorAll('[data-terminal-pane]')) { p.setAttribute('data-ta-seen', ''); p.removeAttribute('data-ta-current'); } return true; })()`;
/** A pane not seen before, with its xterm rows: this run's, marked. */
const newPane = `(() => { const p = [...document.querySelectorAll('[data-panel="terminal"] [data-terminal-pane]')].find((x) => !x.hasAttribute('data-ta-seen') && x.querySelector('.xterm-rows')); if (!p) return false; p.setAttribute('data-ta-current', ''); return true; })()`;

async function onePanel() {
    await cdp.evaluate(`window.location.hash = '#genie://workspace/${workspaceId}'; true`, 10_000);
    await until(() => cdp.evaluate(`Boolean(document.querySelector('[data-workspace-tab="add"]'))`, 5_000), 30_000);
    await cdp.evaluate(markSeen, 5_000);
    await cdp.evaluate(`document.querySelector('[data-workspace-tab="add"]').click(); true`, 5_000);
    await until(() => cdp.evaluate(`Boolean(document.querySelector('[data-designed-tab] [data-add-panel="terminal"]'))`, 5_000), 30_000, 50);
    await cdp.evaluate(`document.querySelector('[data-designed-tab] [data-add-panel="terminal"]').click(); true`, 5_000);
    // MOUNTED: a new pane's xterm rows are in the page. The delay is from here.
    const mounted = await until(() => cdp.evaluate(newPane, 5_000), 30_000, 20);
    return mounted === true;
}

/*
 * After each run: its terminal closed and its tab removed. The first run of this script stopped at 8 panes ("no pane
 * mounted" from run 9): that is the workspace's terminal limit (limit_terminals, default 8) refusing a ninth, not typing.
 */
async function tidy() {
    await cdp.evaluate(`window.genie.terminals.list(${JSON.stringify(workspaceId)}).then((ts) => { for (const t of ts) window.genie.terminals.close(t.id); return ts.length; })`, 15_000).catch(() => 0);
    await cdp.evaluate(`(() => { document.querySelector('[data-ta-current]')?.closest('[data-designed-tab]')?.querySelector('[data-action="remove-tab"]')?.click(); return true; })()`, 5_000).catch(() => {});
    await until(async () => (await cdp.evaluate(`window.genie.terminals.list(${JSON.stringify(workspaceId)}).then((ts) => ts.length)`, 10_000).catch(() => 1)) === 0, 15_000, 100).catch(() => {});
}

async function oneRun(delay) {
    const token = `tu${Math.random().toString(36).slice(2, 10)}`;
    await tidy();
    if (!(await onePanel())) return { echo: false, ran: false, note: 'no pane mounted' };
    await sleep(delay);
    await cdp.evaluate(`(() => { document.querySelector('[data-ta-current] textarea')?.focus(); return true; })()`, 5_000);
    await cdp.send('Input.insertText', { text: `echo ${token}` });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const count = async () => String(await cdp.evaluate(rowsOfNewest, 5_000)).split(token).length - 1;
    const end = Date.now() + 20_000;
    while (Date.now() < end && (await count()) < 2) await sleep(100);
    const seen = await count();
    const focused = await cdp.evaluate(`document.activeElement?.closest?.('[data-terminal-pane]') ? 'in the pane' : (document.activeElement?.tagName ?? 'none')`, 5_000).catch(() => '?');
    return { echo: seen >= 1, ran: seen >= 2, note: seen >= 2 ? '' : `focus ${focused}; rows: ${String(await cdp.evaluate(rowsOfNewest, 5_000)).slice(-120)}` };
}

for (const delay of DELAYS) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        try { runs.push(await oneRun(delay)); } catch (error) { runs.push({ echo: false, ran: false, note: String(error?.message ?? error).slice(0, 120) }); }
    }
    console.log(`TYPEAHEAD ui shell=default delay=${delay} echo=${runs.filter((r) => r.echo).length}/${RUNS} ran=${runs.filter((r) => r.ran).length}/${RUNS}`);
    const miss = runs.find((r) => !r.ran);
    if (miss) console.log(`TYPEAHEAD-MISS ui shell=default delay=${delay} ${miss.note}`);
}
await cleanQuit(session.inspector).catch(() => {});
await Promise.race([app.exit, sleep(30_000)]);
process.exit(0);

#!/usr/bin/env node
/**
 * GENIE'S SIDE: the real app's own terminal (window.genie.terminals: open, write, its data), the path a person's typing
 * takes from the window to the shell (renderer → window main → genie-host → its spawn host → the pty). Typed through it at
 * each delay after the terminal opens; compared with typeahead-conpty.mts, the same pty stack with none of that around it.
 *
 *   node scripts/typeahead/typeahead-genie-cdp.mjs        (CI only: it launches Electron)
 */
import { attach, cleanQuit, launch, makeHome, refuseOffTestMachines, sleep } from '../crash-cdp-lib.mjs';
import { SHELLS, measureShell } from './measure.mjs';

refuseOffTestMachines('typeahead-genie-cdp');
const PORT = 9364, INSPECT = 9365;
const h = makeHome('typeahead');
const app = launch(h, { port: PORT, inspect: INSPECT, label: 'typeahead' });
const session = await attach({ port: PORT, inspect: INSPECT, label: 'typeahead' });
const { cdp } = session;
const workspaceId = (await cdp.evaluate('window.genie.snapshot()', 15_000))?.workspaces?.[0]?.id;
if (typeof workspaceId !== 'string') { console.log('TYPEAHEAD genie unavailable: no workspace'); process.exit(1); }
await cdp.evaluate(`(() => { window.__ta = {}; window.genie.terminals.onData((id, data) => { window.__ta[id] = (window.__ta[id] ?? '') + data; }); return true; })()`, 10_000);

const opener = (command) => async () => {
    const id = await cdp.evaluate(`window.genie.terminals.open(${JSON.stringify(workspaceId)}, ${JSON.stringify({ cols: 120, rows: 30, ...(command ? { command } : {}) })}).then((t) => { window.__ta[t.id] = window.__ta[t.id] ?? ''; return t.id; })`, 30_000);
    return {
        write: (data) => cdp.evaluate(`window.genie.terminals.write(${JSON.stringify(id)}, ${JSON.stringify(data)}); true`, 10_000),
        output: () => cdp.evaluate(`window.__ta[${JSON.stringify(id)}] ?? ''`, 10_000),
        close: () => cdp.evaluate(`window.genie.terminals.close(${JSON.stringify(id)}); true`, 10_000),
    };
};

for (const shell of [null, ...(process.platform === 'win32' ? SHELLS : [])]) {
    try { await measureShell('genie', shell ?? 'default', opener(shell)); }
    catch (error) { console.log(`TYPEAHEAD genie shell=${shell ?? 'default'} unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}
await cleanQuit(session.inspector).catch(() => {});
await Promise.race([app.exit, sleep(30_000)]);
process.exit(0);

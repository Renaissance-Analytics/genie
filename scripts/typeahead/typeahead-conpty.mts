/**
 * THE REFERENCE: the same pty stack Genie's terminals run on (fancy-term-port.ts → fancy-term-host → fancy-pty → conpty on
 * Windows), in this process, with nothing of Genie's around it — no window, no local door, no host, no spawn host. A shell
 * that drops what is typed before it is ready drops it here too; a loss that happens only in Genie is Genie's.
 *
 *   npx tsx scripts/typeahead/typeahead-conpty.mts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFancyTermPort } from '../../src/main/fancy-term-port.js';
import { SHELLS, measureShell } from './measure.mjs';

const port = realFancyTermPort();
const cwd = mkdtempSync(join(tmpdir(), 'typeahead-conpty-'));
const out = new Map<string, string>();
port.onData((id, data) => { out.set(id, (out.get(id) ?? '') + data); });

const opener = (command: string | null) => async () => {
    const t = port.open({ cwd, cols: 120, rows: 30, ...(command ? { command } : {}) });
    out.set(t.id, '');
    return { id: t.id, write: (d: string) => { port.write(t.id, d); }, output: () => out.get(t.id) ?? '', close: () => { port.kill(t.id); } };
};

for (const shell of [null, ...(process.platform === 'win32' ? SHELLS : [])]) {
    try { await measureShell('conpty', shell ?? 'default', opener(shell)); }
    catch (error) { console.log(`TYPEAHEAD conpty shell=${shell ?? 'default'} unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}
process.exit(0);

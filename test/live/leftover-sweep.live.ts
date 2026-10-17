/**
 * THE BOOT SWEEP ON A REAL MACHINE (Tynn #796): the real process listing (WMI on Windows), an ORPHANED provider-shaped
 * process on an agent's thread (its parent gone, as the measured orphan), and a person's interactive `claude --resume`
 * on the same thread. Run in a TEST VM only: `npx tsx test/live/leftover-sweep.live.ts`. A fake `claude.cmd` stands in
 * for the CLI — it just waits — so the command lines are exactly Genie's shape without any provider installed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepLeftoverProviders, systemSweepIo } from '../../src/main/leftover-sweep.js';

const THREAD = '0b5e1a2c-1111-4222-8333-944455556666';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string, detail: string) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${what} — ${detail}`); };

const bin = mkdtempSync(join(tmpdir(), 'sweep-'));
writeFileSync(join(bin, 'claude.cmd'), '@ping -n 300 127.0.0.1 >NUL\r\n');
const env = { ...process.env, PATH: `${bin};${process.env.PATH}` };
const provider = `claude --print --output-format stream-json --input-format stream-json --verbose --resume ${THREAD}`;

setTimeout(() => { console.log('SWEEP PROBE FAILED (timeout)'); process.exit(2); }, 120_000).unref();
// The orphan: an intermediate node starts the provider exactly as prism-acp does (shell: true -> cmd.exe /d /s /c) and
// exits at once, so the provider's cmd.exe parent is gone (the measured case).
console.log('starting the orphan');
execFileSync(process.execPath, ['-e', `require('node:child_process').spawn(${JSON.stringify(provider)}, { shell: true, detached: true, stdio: 'ignore' }).unref()`], { env, stdio: 'ignore', timeout: 30_000 });
console.log('orphan started; starting the interactive session');
// The person's own interactive session on the same thread: a child of this probe, never a provider shape.
const own = spawn(`claude --resume ${THREAD}`, { shell: true, env, stdio: 'ignore' });
await sleep(3000);

const rows = systemSweepIo.list();
const orphanRows = rows.filter((r) => r.cmd.includes('--print') && r.cmd.includes(THREAD));
const ownRows = rows.filter((r) => !r.cmd.includes('--print') && r.cmd.includes(`--resume ${THREAD}`));
check(orphanRows.length >= 1, 'POSITIVE CONTROL: the real listing sees the orphaned provider with its command line', JSON.stringify(orphanRows.map((r) => r.pid)));
check(ownRows.length >= 1, 'POSITIVE CONTROL: the real listing sees the interactive session', JSON.stringify(ownRows.map((r) => r.pid)));

const lines: string[] = [];
const found = sweepLeftoverProviders([{ name: 'probe-agent', threadId: THREAD }], systemSweepIo, (l) => lines.push(l));
await sleep(1500);
const after = systemSweepIo.list();
check(found.length === 1 && found[0]!.pids.length >= 1, 'the sweep found the leftover, named by its agent', JSON.stringify(found));
check(!after.some((r) => r.cmd.includes('--print') && r.cmd.includes(THREAD)), 'the orphaned provider is GONE', lines.join(' | '));
check(after.some((r) => !r.cmd.includes('--print') && r.cmd.includes(`--resume ${THREAD}`)), 'the person’s interactive session is UNTOUCHED', '');

own.kill();
for (const r of after.filter((x) => x.cmd.includes(THREAD))) systemSweepIo.end(r.pid);
console.log(failed === 0 ? 'SWEEP PROBE OK' : `SWEEP PROBE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);

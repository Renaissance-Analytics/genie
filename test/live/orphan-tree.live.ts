/**
 * THE REAL STOP ON A BUSY MACHINE (hosting plan 1.1-1.3; lifecycle review §6 steps 1-4 and 7, in miniature). Run in a
 * TEST VM, never on a desktop: `npx tsx test/live/orphan-tree.live.ts`. Prints PASS/FAIL lines; exits non-zero on any.
 *
 * - Step 1, the cap must bite: 30 long-lived children are started under this process first (stand-ins for a desktop's
 *   terminals and sites), so Genie has MORE than 24 descendants — the beta.32 reap refused at exactly this point.
 * - The session's provider is spawned the way prism-acp spawns one on Windows: `shell: true` → `cmd.exe /d /s /c …`,
 *   whose child (`ping` here, a stand-in that ignores stdin closing as the orphaned provider did) starts its own child.
 *   The driver's kill is `child.kill()`: the cmd.exe only.
 * - Stop must leave 0 of the session's processes (positive control: >= 2 counted under the shell before the stop) and
 *   all 30 of the others.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintAgentId } from '../../src/core/identity.js';
import { stillRunning, subtreeOf, systemProcessTree } from '../../src/core/process-tree.js';
import { AgentSession } from '../../src/core/session.js';
import { openDurableStore } from '../../src/core/thread-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string, detail: string) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${what} — ${detail}`); };
const win = process.platform === 'win32';
const longSleep = (n: number): string => (win ? `ping -n ${n} 127.0.0.1` : `sleep ${n}`);

// Step 1: a busy machine.
const others: ChildProcess[] = [];
for (let i = 0; i < 30; i++) others.push(spawn(win ? 'ping' : 'sleep', win ? ['-n', '600', '127.0.0.1'] : ['600'], { stdio: 'ignore', windowsHide: true }));
await sleep(1500);
const baseline = systemProcessTree.snapshot();
const genieTree = baseline ? subtreeOf(baseline, baseline.filter((p) => p.pid === process.pid)).length - 1 : -1;
check(genieTree > 24, 'STEP 1: this process has more than 24 descendants, so the old cap would bite', `descendants ${genieTree}`);

const dir = mkdtempSync(join(tmpdir(), 'genie2-orphan-live-'));
let provider: ChildProcess | null = null;
const session = new AgentSession({
    agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
    driverFactory: () => ({
        // A shell whose command starts a child that starts another: cmd.exe → cmd.exe → ping (or sh → sh → sleep).
        start: () => { provider = spawn(win ? `cmd /c "${longSleep(600)}"` : `sh -c '${longSleep(600)}; true'`, { shell: true, stdio: 'ignore', windowsHide: true }); },
        prompt: () => {},
        kill: (signal) => { provider?.kill(signal); },
        cliSessionId: null,
    }),
});
session.start();
await sleep(2000);
const before = systemProcessTree.snapshot() ?? [];
const shell = before.find((p) => p.pid === provider?.pid);
const sessionTree = shell ? subtreeOf(before, [shell]) : [];
check(sessionTree.length >= 2, 'POSITIVE CONTROL: the session tree is visible under its shell before the stop', sessionTree.map((p) => `${p.pid}(${p.name})`).join(', '));

const started = Date.now();
const verdict = await session.stop();
const after = systemProcessTree.snapshot() ?? [];
const survivors = stillRunning(sessionTree, after);
check(verdict.verified, 'the stop reports VERIFIED', JSON.stringify(verdict));
check(survivors.length === 0, 'NOTHING of the session is left', `alive after stop: ${survivors.map((p) => `${p.pid}(${p.name})`).join(', ') || 'none'} (${Date.now() - started} ms)`);
const othersAlive = others.filter((c) => after.some((p) => p.pid === c.pid)).length;
check(othersAlive === 30, 'CONTROL: all 30 of the machine’s other processes are untouched', `${othersAlive} of 30 alive`);

for (const c of others) c.kill();
rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? 'ORPHAN PROBE OK' : `ORPHAN PROBE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);

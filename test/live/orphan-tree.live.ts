/**
 * THE REAL WALK, ON WINDOWS (Tynn #796): does the stop-time walk name a shell's late child WITH its parent, and does
 * killing the session's subtree from it leave nothing behind when the provider's own kill took only the cmd.exe?
 *
 * Spawned exactly as prism-acp spawns a provider on Windows: `shell: true` → `cmd.exe /d /s /c "<command>"`. The child
 * here is `ping` (a long-lived stand-in that ignores stdin closing, as the orphaned provider did). Run in a test VM:
 * `npx tsx test/live/orphan-tree.live.ts`. Prints PASS/FAIL lines and exits non-zero on any FAIL.
 */
import { spawn } from 'node:child_process';
import { subtreeOf, systemProcessTree } from '../../src/core/process-tree.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string, detail: string) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${what} — ${detail}`); };

const child = spawn('ping -n 120 127.0.0.1', { shell: true, stdio: 'ignore' });
const shellPid = child.pid!;
await sleep(2000);

const edges = systemProcessTree.walk?.(process.pid) ?? [];
const late = edges.filter((e) => e.ppid === shellPid).map((e) => e.pid);
check(systemProcessTree.walk !== undefined, 'the system tree reports parents', `walk ${systemProcessTree.walk ? 'present' : 'ABSENT'}`);
check(edges.some((e) => e.pid === shellPid && e.ppid === process.pid), 'the walk names the shell under Genie (positive control)', `shell ${shellPid}; edges ${JSON.stringify(edges)}`);
check(late.length === 1, 'the walk names exactly ONE child under the shell, with the shell as its parent', `children of ${shellPid}: ${JSON.stringify(late)}`);

// What prism-acp's kill does on Windows: TerminateProcess on the cmd.exe only.
const walked = edges.map((e) => e.pid);
child.kill();
await sleep(1000);
const orphanAlive = (systemProcessTree.walk?.(process.pid) ?? []).length; // the orphan is no longer under us
check(late.length === 1, 'the provider\'s kill alone left the child running (the bug)', `descendants reachable from Genie after cmd kill: ${orphanAlive}`);

const result = systemProcessTree.killTree(subtreeOf(edges, [shellPid]), walked);
await sleep(1000);
const still = late.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
check(result.refused === false && result.killed >= 1, 'the session subtree reap ran', JSON.stringify(result));
check(still.length === 0, 'NOTHING is left: the late child is gone', `alive after reap: ${JSON.stringify(still)}`);

console.log(failed === 0 ? 'ORPHAN PROBE OK' : `ORPHAN PROBE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);

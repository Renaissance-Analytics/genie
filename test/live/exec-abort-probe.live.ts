/**
 * genie#1372 PROBE: does an aborted `services exec` leave its shell, or anything under it, alive on Windows — and is
 * its working folder still locked once the abort has resolved?
 *
 * Usage: tsx test/live/exec-abort-probe.live.ts <rounds>
 *
 * Every command runs in its OWN empty working folder, so "can that folder be removed" measures exactly the processes
 * whose current directory it is (the script and its pid files live elsewhere). The ProcessTree is the real one,
 * wrapped only to record which processes the stop chose to reap.
 *
 * Scenarios, each round:
 *  - test:     the CI test's shape — node parent + worker, abort once both pids are written.
 *  - noctrlc:  the same, the parent and worker ignoring SIGINT/SIGBREAK.
 *  - grand:    parent → child → grandchild, abort once all three are written.
 *  - early-N:  abort N ms after spawn (0, 30, 150, 400) — before the tree has finished growing. The chain writes its
 *              pids when it gets there; if it gets there AFTER the abort resolved, those processes escaped the stop.
 *
 * After each abort resolves: every recorded target and every pid the chain wrote is checked (process.kill 0), the
 * folder's rmdir is tried at once and then every 20 ms (time-to-removable recorded), and when the folder is busy a WMI
 * reading is taken of the survivors. Anything left at the end that descends from this probe is killed by pid.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServiceExec } from '../../src/main/service-exec.js';
import { systemProcessTree, type ProcessInfo, type ProcessTree } from '../../src/core/process-tree.js';

const rounds = Number(process.argv[2] ?? 10);
const root = mkdtempSync(join(tmpdir(), 'genie-1372-probe-'));
const work = join(root, 'work');
const files = join(root, 'files');
mkdirSync(work);
mkdirSync(files);

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (p: string) => `"${p}"`;
const NODE = process.platform === 'win32' ? `call ${q(process.execPath)}` : q(process.execPath);

// chain.cjs <out> <depth> <ignoreCtrlC>: spawn one child of depth-1 (same script), append "pid" lines to <out>.
const chain = join(files, 'chain.cjs');
writeFileSync(chain, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const [out, depthS, ign] = process.argv.slice(2);",
    "const depth = Number(depthS);",
    "if (ign === '1') { process.on('SIGINT', () => {}); process.on('SIGBREAK', () => {}); process.on('SIGTERM', () => {}); }",
    "fs.appendFileSync(out, `${process.pid}\\n`);",
    "if (depth > 1) spawn(process.execPath, [__filename, out, String(depth - 1), ign], { stdio: 'ignore' });",
    'setInterval(() => {}, 1000);',
].join('\n'));

let reaped: ProcessInfo[] = [];
const tree: ProcessTree = {
    ...systemProcessTree,
    reap: async (targets, now, limit) => { reaped = [...targets]; return systemProcessTree.reap!(targets, now, limit); },
};
const exec = makeServiceExec(tree);

function wmi(): { pid: number; ppid: number; name: string; cmd: string }[] {
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }';
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, ppid, name, ...rest] = l.split('|'); return { pid: Number(pid), ppid: Number(ppid), name: name ?? '', cmd: rest.join('|') }; });
}

const readPids = (f: string): number[] => { try { return readFileSync(f, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
async function waitPids(f: string, n: number, ms = 30_000): Promise<number[]> {
    const until = Date.now() + ms;
    while (Date.now() < until) { const p = readPids(f); if (p.length >= n) return p; await sleep(25); }
    return readPids(f);
}

interface Row { scenario: string; round: number; targets: string; survivorsAtResolve: string; chainAfter: string; escaped: string; busyMs: number; busyWho: string }
const rows: Row[] = [];
const everyPid = new Set<number>();
let n = 0;

async function one(scenario: string, round: number, depth: number, ign: boolean, earlyMs: number | null): Promise<void> {
    const cwd = join(work, `${scenario}-${round}`);
    mkdirSync(cwd);
    const out = join(files, `${scenario}-${round}.pids`);
    reaped = [];
    const ac = new AbortController();
    const run = exec({ command: `${NODE} ${q(chain)} ${q(out)} ${depth} ${ign ? 1 : 0}`, cwd, env: {}, timeoutMs: 600_000, signal: ac.signal });
    if (earlyMs === null) await waitPids(out, depth);
    else if (earlyMs > 0) await sleep(earlyMs);
    ac.abort();
    const r = await run;
    const targets = [...reaped];
    const chainAtResolve = readPids(out);
    for (const p of [...targets.map((t) => t.pid), ...chainAtResolve]) everyPid.add(p);
    const survivors = [...targets.map((t) => `${t.pid}(${t.name})`).filter((_, i) => alive(targets[i]!.pid)), ...chainAtResolve.filter((p) => !targets.some((t) => t.pid === p) && alive(p)).map((p) => `${p}(chain)`)];
    // Time to removable.
    const t0 = Date.now();
    let busyMs = 0;
    let busyWho = '';
    for (;;) {
        try { rmdirSync(cwd); busyMs = Date.now() - t0; break; } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (!busyWho) {
                const live = wmi();
                const known = new Set([...targets.map((t) => t.pid), ...readPids(out)]);
                busyWho = `${code}: ` + live.filter((p) => known.has(p.pid) || known.has(p.ppid)).map((p) => `${p.pid}<${p.ppid} ${p.name}`).join(', ');
            }
            if (Date.now() - t0 > 10_000) { busyMs = -1; break; }
            await sleep(20);
        }
    }
    // Did the chain grow after the abort resolved (a process spawned after the stop's reading)?
    await sleep(earlyMs === null ? 300 : 1500);
    const chainAfter = readPids(out);
    for (const p of chainAfter) everyPid.add(p);
    const escaped = chainAfter.filter(alive);
    rows.push({ scenario, round, targets: targets.map((t) => `${t.pid}(${t.name})`).join(' '), survivorsAtResolve: survivors.join(' '), chainAfter: chainAfter.join(' '), escaped: escaped.join(' '), busyMs, busyWho });
    n += 1;
    const flag = survivors.length || escaped.length || busyWho ? ' <<<' : '';
    console.log(`[${n}] ${scenario}#${round} aborted=${r.aborted} exit=${r.exitCode} targets=[${rows.at(-1)!.targets}] survivors=[${survivors.join(' ')}] chain=${chainAfter.length}/${depth} escaped=[${escaped.join(' ')}] rmdirAfterMs=${busyMs}${busyWho ? ` busy={${busyWho}}` : ''}${flag}`);
}

for (let i = 1; i <= rounds; i += 1) {
    await one('test', i, 2, false, null);
    await one('noctrlc', i, 2, true, null);
    await one('grand', i, 3, false, null);
    for (const ms of [0, 30, 150, 400]) await one(`early${ms}`, i, 3, false, ms);
}

// Summary.
const by = new Map<string, { runs: number; survivors: number; escaped: number; busy: number; maxBusy: number; stuck: number }>();
for (const r of rows) {
    const s = by.get(r.scenario) ?? { runs: 0, survivors: 0, escaped: 0, busy: 0, maxBusy: 0, stuck: 0 };
    s.runs += 1;
    if (r.survivorsAtResolve) s.survivors += 1;
    if (r.escaped) s.escaped += 1;
    if (r.busyMs > 0) s.busy += 1;
    if (r.busyMs < 0) s.stuck += 1;
    s.maxBusy = Math.max(s.maxBusy, r.busyMs);
    by.set(r.scenario, s);
}
console.log('=== SUMMARY (survivors = a reaped target or chain pid alive when the abort resolved; escaped = alive 0.3-1.5 s later; busy = rmdir failed at first try; stuck = still busy after 10 s)');
for (const [k, s] of by) console.log(`${k.padEnd(9)} runs=${s.runs} survivorsAtResolve=${s.survivors} escaped=${s.escaped} busyAtFirst=${s.busy} maxBusyMs=${s.maxBusy} stuck10s=${s.stuck}`);

// Clean up whatever is left: only pids this probe saw, and their descendants.
const leftovers = wmi().filter((p) => everyPid.has(p.pid) || everyPid.has(p.ppid));
console.log(`=== LEFTOVERS at end: ${leftovers.map((p) => `${p.pid}<${p.ppid} ${p.name}`).join(', ') || 'none'}`);
for (const p of leftovers) spawnSync('taskkill', ['/PID', String(p.pid), '/F'], { windowsHide: true });
await sleep(1000);
try { rmSync(root, { recursive: true, force: true }); } catch (e) { console.log(`cleanup: ${(e as Error).message}`); }
console.log(existsSync(root) ? 'probe root NOT removed' : 'probe root removed');
process.exit(0);

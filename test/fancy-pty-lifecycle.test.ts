import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeSpawn, frame, helperPath } from '@particle-academy/fancy-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { startSpawnHost, type SpawnHostClient } from '../src/main/spawn-host-client.js';

/**
 * FANCY-PTY'S PROCESS LIFETIME, AS GENIE NEEDS IT (fancy-pty 0.2.1; batch L4's bugs, VM job 76).
 *
 * On omarchy-test a fancy-pty helper and its `bash -l` outlived a SIGKILLed spawn host, and the shell held the window's
 * DevTools listener it had inherited through the helper. fancy-pty 0.1.4 caused both: its helper did not end the shell when
 * its control stream closed, and its forked child kept every fd the helper had without close-on-exec. 0.2.0 kills the
 * pty's tree when the controller goes; 0.2.1 closes the child's inherited fds before execvp. Genie pins neither directly:
 * fancy-term-host 0.11.1 allows `>=0.1.1 <2.0`, so the lockfile decides. Red on 0.1.4, green on 0.2.1.
 *
 *   1. The REAL spawn host (src/main/spawn-host.ts) on ELECTRON'S binary as Node — the pty controller in the product —
 *      opens a pty; SIGKILLed, it runs none of its own cleanup: the helper and the shell must go on their own.
 *   2. A non-close-on-exec fd in the HELPER must not reach the shell. The helper is native, so it is started directly with
 *      a listening socket on fd 3 (no Node startup runs in it to mark the fd close-on-exec, which is why a Node-based
 *      controller cannot show this), driven with fancy-pty's own frames.
 *
 * Linux: /proc. Runs in CI and the test VMs (spawns processes), never on the owner's desktop.
 */

const electron = createRequire(import.meta.url)('electron') as unknown as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Never pid ≤ 0: kill(0) addresses THIS process group.
function alive(pid: number): boolean { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function ppid(pid: number): number { try { return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[1]); } catch { return 0; } }
function children(pid: number): number[] { return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number).filter((p) => ppid(p) === pid); }
function exeOf(pid: number): string | null { try { return readlinkSync(`/proc/${pid}/exe`); } catch { return null; } }
function fdsHolding(pid: number, target: string): Array<{ fd: string; flags: string }> {
    try {
        return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
            try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === target ? [{ fd, flags: /^flags:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'))?.[1] ?? '?' }] : []; } catch { return []; }
        });
    } catch { return []; }
}
async function until<T>(what: string, fn: () => T | null | undefined | false, ms: number): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v as T;
        if (Date.now() > end) throw new Error(`timed out: ${what}`);
        await sleep(100);
    }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const killAll = (...pids: number[]) => { for (const p of pids) if (p > 0) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } };

describe.skipIf(process.platform !== 'linux')('fancy-pty under Genie', () => {
    it('1. the spawn host SIGKILLed (no cleanup of its own runs): its pty helper and the shell end on their own', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fancy-pty-life-'));
        cleanups.push(() => rm(dir, { recursive: true, force: true }));
        // killPid is a no-op: nothing in THIS process may end the helper for it — the point is what happens on its own.
        const client: SpawnHostClient = startSpawnHost({
            entry: resolve('src/main/spawn-host.ts'), execPath: electron, execArgv: ['--import', 'tsx'], env: { GENIE_SPAWN_PROFILE: 'terminals' },
            killPid: () => {}, pidAlive: alive, log: () => {},
        });
        cleanups.push(() => client.stop(1_000));
        const pty = client.ptyPort();
        const pids: number[] = [];
        pty.onPid?.((_id, pid) => { pids.push(pid); });
        pty.open({ cwd: dir, command: 'sleep 300' });
        const helper = await until('the helper pid', () => pids[0] ?? null, 30_000);
        const shell = await until('the command under the helper', () => children(helper)[0] ?? null, 15_000);
        const host = await until('the spawn host pid', () => client.pid, 5_000);
        cleanups.push(() => killAll(...children(shell), shell, helper));
        // CONTROL: all three alive, and the helper is the spawn host's child.
        expect([alive(host), alive(helper), alive(shell), ppid(helper) === host]).toEqual([true, true, true, true]);
        process.kill(host, 'SIGKILL');
        const gone = await until('the helper and the shell to go', () => (!alive(helper) && !alive(shell) ? true : null), 5_000).catch(() => false);
        console.log(`[fancy-pty-life] 1: spawn host ${host} SIGKILLed; helper ${helper} ${alive(helper) ? `ALIVE (ppid ${ppid(helper)})` : 'gone'}, shell ${shell} ${alive(shell) ? 'ALIVE' : 'gone'}`);
        expect(gone).toBe(true);
    }, 90_000);

    it('2. a non-close-on-exec fd the helper holds never reaches the shell', async () => {
        const server: Server = createServer();
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const fd = (server as unknown as { _handle: { fd: number } })._handle.fd;
        const inode = readlinkSync(`/proc/self/fd/${fd}`);
        const helper = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe', fd] });
        cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
        cleanups.push(() => killAll(...children(helper.pid!), helper.pid!));
        helper.stdout!.resume();
        helper.stderr!.resume();
        // The request a Pty sends, in fancy-pty's own encoding: SPAWN (0x00) first.
        helper.stdin!.write(frame(0 as Parameters<typeof frame>[0], encodeSpawn({ argv: ['/bin/sleep', '300'], cwd: tmpdir(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })));
        // AFTER THE EXEC. A child seen the moment it forks still holds everything until it reaches close_range and execvp, and a read there
        // reports a leak that does not exist (batch S; measured by scripts/perf-lag/fancy-pty-fd-race.mjs). The shell is what must not hold it.
        const requested = realpathSync('/bin/sleep');
        const shell = await until('the command under the helper, exec\'d', () => { const child = children(helper.pid!)[0]; return child !== undefined && exeOf(child) === requested ? child : null; }, 15_000);
        // CONTROL: the helper holds the socket on fd 3, WITHOUT close-on-exec — the condition the shell must not inherit.
        const held = fdsHolding(helper.pid!, inode);
        expect(held.map((h) => h.fd)).toContain('3');
        expect((parseInt(held.find((h) => h.fd === '3')!.flags, 8) & 0o2000000) === 0).toBe(true);
        const inShell = fdsHolding(shell, inode);
        console.log(`[fancy-pty-life] 2: helper ${helper.pid} holds ${inode} as ${JSON.stringify(held)}; the shell ${shell} holds it as ${JSON.stringify(inShell)}`);
        expect(inShell).toEqual([]);
    }, 60_000);
});

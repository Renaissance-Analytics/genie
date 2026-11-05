import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import { pidAlive } from '../src/main/engine-launch.js';

const TSX = import.meta.resolve('tsx');

/**
 * ONE OWNER FOR EVERY PROCESS GENIE-HOST STARTS (CI row, real processes, Linux). The host's `docker events` stream — the
 * one long-lived command it starts for its own use — runs under a spawn-host child of the host, which ends its streams when
 * its parent link closes (spawn-host.ts). So a genie-host KILLED (no clean shutdown) leaves no `docker events` behind.
 * Before this, the host started it itself, and on Linux it was orphaned (P5a.3's probe, CI 42069889782: pid 13193).
 * POSITIVE CONTROL in the same run: the gauge finds this host's `docker events` while the host lives.
 * Windows is not asked: a killed host's whole tree ends there with it (measured, P5a.3).
 */

let home: string;
let hostProcess: ChildProcess;
let hostLog = '';
let record: HostRecord;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v as T;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n--- host log ---\n${hostLog}`);
        await sleep(200);
    }
}
const readText = async (file: string) => { try { return await readFile(file, 'utf8'); } catch { return null; } };

/** This host's `docker events` processes: every one whose parent chain reaches the host's pid. */
function dockerEventsOf(hostPid: number): number[] {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }] : [];
    });
    const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
    const under = (pid: number): boolean => {
        for (let at = parent.get(pid), n = 0; at !== undefined && n < 20; at = parent.get(at), n += 1) if (at === hostPid) return true;
        return false;
    };
    return rows.filter((r) => /(^|\/)docker events\b/.test(r.args) && under(r.pid)).map((r) => r.pid);
}

const linux = process.platform === 'linux';

beforeAll(async () => {
    if (!linux) return;
    home = await mkdtemp(join(tmpdir(), 'genie-host-owns-'));
    await mkdir(join(home, 'runtime'), { recursive: true });
    await writeFile(join(home, 'runtime', 'workspaces.json'), JSON.stringify([]));
    hostProcess = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'owns-test', GENIE_HOST_IDLE_MS: '600000', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    hostProcess.stdout?.on('data', (d) => { hostLog += String(d); });
    hostProcess.stderr?.on('data', (d) => { hostLog += String(d); });
    record = await until('host.json', async () => {
        const r = parseHostRecord(await readText(join(home, 'runtime', 'host.json')));
        return r && r.pid === hostProcess.pid ? r : null;
    }, 120_000);
}, 180_000);

let found: number[] = [];
afterAll(async () => {
    if (!linux) return;
    if (hostProcess.exitCode === null) hostProcess.kill('SIGKILL');
    for (const pid of found) if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(300);
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('genie-host’s own long-lived commands have one owner', () => {
    it.skipIf(!linux)('a host KILLED leaves no `docker events` behind (CONTROL: the gauge finds it while the host lives)', async () => {
        expect(record.pid).toBe(hostProcess.pid);
        found = await until('this host’s docker events', () => { const pids = dockerEventsOf(hostProcess.pid!); return pids.length > 0 ? pids : null; }, 60_000);
        expect(found.every((pid) => pidAlive(pid))).toBe(true); // POSITIVE CONTROL
        hostProcess.kill('SIGKILL');
        await until('the host to be gone', () => hostProcess.exitCode !== null || hostProcess.signalCode !== null, 15_000);
        await until(`this host's docker events (pid ${found.join(', ')}) to end with it`, () => found.every((pid) => !pidAlive(pid)), 20_000);
    }, 180_000);
});

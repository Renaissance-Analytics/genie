import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { connectSocket, pidAlive } from '../src/main/engine-launch.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

const TSX = import.meta.resolve('tsx');

/**
 * P5a.3, decision 1 (CI row, real processes): WHEN GENIE-HOST DIES, WHAT IT SUPERVISED DIES WITH IT. The host's
 * supervised processes (sites, Caddy, workers) run in its `supervised` spawn-host child; the child's parent is genie-host,
 * never a window. So:
 *  (2) a window going ("Just close the UI", or a window crash) leaves every one running — the child's parent is alive;
 *  (1) genie-host KILLED (no clean shutdown) leaves none behind: its child's link closes and it ends what it runs.
 * The gauge reads the supervised program's OWN pid (it writes it), not a shell's — a process left under a dead shell
 * counts. POSITIVE CONTROL in the same run: the gauge sees it alive while the host lives.
 * Docker is not involved: this home has no engine, and (b) in p5a3-hosting-shutdown.test.ts pins that containers are
 * never stopped.
 */

let home: string;
let workspace: string;
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
        await sleep(100);
    }
}
const readText = async (file: string) => { try { return await readFile(file, 'utf8'); } catch { return null; } };

/** DIAGNOSTIC PROBE: every process as { pid, ppid, name } — PowerShell on Windows, ps elsewhere. */
function processTable(): Array<{ pid: number; ppid: number; name: string; cmd: string }> {
    if (process.platform === 'win32') {
        const json = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return (JSON.parse(json) as Array<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }>).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: (p.CommandLine ?? '').slice(0, 160) }));
    }
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).split('\n').filter((l) => l.trim()).map((l) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l)!;
        return { pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!, cmd: (m[4] ?? '').slice(0, 160) };
    });
}
function chainOf(pid: number): Array<{ pid: number; ppid: number; name: string; cmd: string }> {
    const table = processTable();
    const chain: Array<{ pid: number; ppid: number; name: string; cmd: string }> = [];
    let at = table.find((p) => p.pid === pid);
    while (at && chain.length < 12) { chain.push(at); const ppid = at.ppid; at = table.find((p) => p.pid === ppid); }
    return chain;
}
function childrenOf(pid: number): Array<{ pid: number; ppid: number; name: string; cmd: string }> {
    return processTable().filter((p) => p.ppid === pid);
}

async function window(): Promise<{ client: SessionEngineClient; transport: ClientTransport }> {
    const token = (await readFile(join(home, 'runtime', 'host.token'), 'utf8')).trim();
    const transport = await connectSocket(record.endpoint);
    const client = new SessionEngineClient({ env: () => ({ ...process.env }) });
    expect(await client.connect(transport, token)).toMatchObject({ ok: true });
    return { client, transport };
}

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie-host-killed-'));
    workspace = await mkdtemp(join(tmpdir(), 'genie-host-killed-ws-'));
    await mkdir(join(home, 'runtime'), { recursive: true });
    await writeFile(join(home, 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'ws', path: workspace }]));
    // The supervised program: it writes its OWN pid, then runs until it is ended.
    await writeFile(join(workspace, 'worker.cjs'), `require('fs').writeFileSync(${JSON.stringify(join(workspace, 'worker.pid'))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    hostProcess = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'killed-test', GENIE_HOST_IDLE_MS: '600000', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    hostProcess.stdout?.on('data', (d) => { hostLog += String(d); });
    hostProcess.stderr?.on('data', (d) => { hostLog += String(d); });
    record = await until('host.json', async () => {
        const r = parseHostRecord(await readText(join(home, 'runtime', 'host.json')));
        return r && r.pid === hostProcess.pid ? r : null;
    }, 120_000);
}, 180_000);

let workerPid: number | null = null;
afterAll(async () => {
    if (hostProcess.exitCode === null) hostProcess.kill('SIGKILL');
    if (workerPid !== null && pidAlive(workerPid)) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(500);
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('genie-host’s supervised processes live and die with the HOST, not the window', () => {
    it('(2) a window going leaves the worker running; (1) the host KILLED leaves no worker behind', async () => {
        const first = await window();
        first.client.supervisor().start({ id: 'proc:worker', workspaceId: 'ws', name: 'worker', command: `"${process.execPath}" worker.cjs`, cwd: workspace, restart: 'always' });
        workerPid = await until('the worker’s own pid', async () => { const t = await readText(join(workspace, 'worker.pid')); return t ? Number(t) : null; }, 60_000);
        expect(pidAlive(workerPid)).toBe(true); // POSITIVE CONTROL: the gauge sees it while the host lives

        first.transport.close(); // (2) the window goes: the spawn host's parent is genie-host, still alive
        await sleep(3_000);
        expect(pidAlive(workerPid)).toBe(true);

        // DIAGNOSTIC PROBE: who is who, before the kill.
        const chain = chainOf(workerPid);
        const hostKids = childrenOf(hostProcess.pid!);
        const watched = new Map<number, string>([...chain, ...hostKids].map((p) => [p.pid, `${p.name} ${p.cmd}`]));
        for (const k of hostKids) for (const g of childrenOf(k.pid)) watched.set(g.pid, `${g.name} ${g.cmd}`);
        console.log(`[PROBE] host pid=${hostProcess.pid} worker pid=${workerPid}`);
        console.log(`[PROBE] worker chain: ${JSON.stringify(chain)}`);
        console.log(`[PROBE] host children: ${JSON.stringify(hostKids)}`);
        const t0 = Date.now();
        hostProcess.kill('SIGKILL'); // (1) the host dies with no shutdown at all
        const died = new Map<number, number>();
        for (let i = 0; i < 60 && died.size < watched.size; i += 1) {
            for (const pid of watched.keys()) if (!died.has(pid) && !pidAlive(pid)) died.set(pid, Date.now() - t0);
            await sleep(250);
        }
        for (const [pid, what] of watched) console.log(`[PROBE] pid=${pid} ${died.has(pid) ? `died at +${died.get(pid)} ms` : 'STILL ALIVE after 15 s'} :: ${what}`);
        console.log(`[PROBE] host log tail: ${hostLog.split('\n').filter((l) => /spawn|PROBE|relay/.test(l)).slice(-20).join(' | ')}`);
        await until('the host to be gone', () => hostProcess.exitCode !== null || hostProcess.signalCode !== null, 15_000);
        await until(`the worker (pid ${workerPid}) to end with its host`, () => !pidAlive(workerPid!), 20_000);
    }, 180_000);
});

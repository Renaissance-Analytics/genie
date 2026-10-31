import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { connectSocket, pidAlive } from '../src/main/engine-launch.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

/**
 * THE HOST IS ITS OWN PROCESS, AND AN AGENT OUTLIVES ITS WINDOW (the host split, phase 1).
 *
 * The real `genie-host` entry (src/main/genie-host.ts), run as its own Node process, with a real provider process: the
 * busy stub codex (scripts/perf-lag/stub-codex-busy.mjs), the same App Server protocol the real CodexDriver speaks,
 * streaming a reply and running commands for as long as its turn lasts. A window is played by a `SessionEngineClient`
 * on the real socket. The window "crashes" (its socket is destroyed); the provider must keep running and keep writing,
 * and the next window must adopt the host and see the run — including what happened while no window was there.
 *
 * Runs in the test VMs (spawns processes); never on the owner's desktop.
 */

const STUB = resolve('scripts/perf-lag/stub-codex-busy.mjs');
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

async function window(): Promise<{ client: SessionEngineClient; transport: ClientTransport }> {
    const token = (await readFile(join(home, 'runtime', 'host.token'), 'utf8')).trim();
    const transport = await connectSocket(record.endpoint);
    const client = new SessionEngineClient();
    const connected = await client.connect(transport, token);
    expect(connected).toMatchObject({ ok: true });
    return { client, transport };
}

/** The provider processes the host recorded for its agents (the spawn ledger, `runtime/children.json`). */
async function providerPids(): Promise<number[]> {
    const text = await readText(join(home, 'runtime', 'children.json'));
    if (!text) return [];
    const parsed = JSON.parse(text) as { records: Array<{ processes: Array<{ pid: number }> }> };
    return parsed.records.flatMap((r) => r.processes.map((p) => p.pid));
}

async function threadBytes(): Promise<number> {
    const dir = join(home, 'runtime', 'sessions');
    let total = 0;
    for (const name of await readdir(dir).catch(() => [] as string[])) total += (await stat(join(dir, name))).size;
    return total;
}

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie-host-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'genie-host-ws-'));
    hostProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'test-build', GENIE2_CODEX_BINARY: STUB, GENIE_HOST_IDLE_MS: '600000' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    hostProcess.stdout?.on('data', (d) => { hostLog += String(d); });
    hostProcess.stderr?.on('data', (d) => { hostLog += String(d); });
    record = await until('host.json', async () => {
        const r = parseHostRecord(await readText(join(home, 'runtime', 'host.json')));
        return r && r.pid === hostProcess.pid ? r : null;
    }, 120_000);
}, 180_000);

afterAll(async () => {
    if (hostProcess.exitCode === null) hostProcess.kill('SIGKILL');
    for (const pid of await providerPids().catch(() => [])) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(500);
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('genie-host as its own process', () => {
    it('writes host.json with its own pid, the protocol and the build it was started as', () => {
        expect(record).toMatchObject({ pid: hostProcess.pid, protocol: 1, build: 'test-build' });
    });

    it('a second host for the same user finds the endpoint taken and exits, leaving the first serving', async () => {
        const second = spawn(process.execPath, ['--import', 'tsx', 'src/main/genie-host.ts'], { env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'other' }, stdio: 'ignore' });
        const code = await new Promise<number | null>((r) => second.once('exit', r));
        expect(code).toBe(0);
        expect(parseHostRecord(await readText(join(home, 'runtime', 'host.json')))?.pid).toBe(hostProcess.pid);
    }, 120_000);

    it('an agent keeps running and writing while no window is connected, and the next window adopts it', async () => {
        const first = await window();
        const agent = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'busy' });
        expect(await first.client.start(agent, workspace)).toEqual({ ok: true });
        await until('the agent to take a prompt', () => first.client.promptable(agent.id) !== null, 60_000);
        expect(await first.client.prompt(agent.id, 'work', 'you')).toBe(true);
        await until('streamed rows', () => first.client.rowsFor(agent.id).length > 3, 60_000);
        const pids = await until('the provider in the spawn ledger', async () => { const p = await providerPids(); return p.length > 0 ? p : null; }, 30_000);
        expect(pids.every(pidAlive)).toBe(true); // positive control: the gauge sees the provider alive

        const rowsAtCrash = first.client.rowsFor(agent.id).length;
        first.transport.close(); // the window crashed
        const bytesAtCrash = await threadBytes();
        await sleep(3_000);

        // No window: the host and the provider still run, and the agent's thread keeps growing.
        expect(pidAlive(hostProcess.pid!)).toBe(true);
        expect(pids.every(pidAlive)).toBe(true);
        expect(await threadBytes()).toBeGreaterThan(bytesAtCrash);

        const second = await window();
        expect(second.client.runOf(agent.id)).not.toBeNull();
        expect(second.client.probe(agent.id)?.running).toBe(true);
        // What happened while no window was there is in the adopted run.
        expect(second.client.rowsFor(agent.id).length).toBeGreaterThan(rowsAtCrash);

        // The graceful end: sessions stopped and verified, then the process exits and its providers are gone.
        expect(await second.client.shutdown()).toBe(true);
        await until('the host to exit', () => hostProcess.exitCode !== null, 30_000);
        await until('the provider to be gone', () => pids.every((p) => !pidAlive(p)), 15_000);
        expect(await readText(join(home, 'runtime', 'host.json'))).toBeNull();
    }, 240_000);
});

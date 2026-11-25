import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseHostRecord, type HostRecord } from '../src/core/engine-protocol.js';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import { connectSocket, pidAlive } from '../src/main/engine-launch.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';

const TSX = import.meta.resolve('tsx');

/**
 * A RESTARTED GENIE-HOST GIVES ITS PROCESSES THE WORKSPACE'S SERVICE VARIABLES, WITH NO AGENT STARTED (Tynn #1044).
 *
 * The real `genie-host` entry, as its own Node process, booting on a home that already holds what an earlier run left: the
 * workspace, its dedicated MySQL engine in services.json (stopped by the person, so nothing pulls an image), and a kept
 * queue worker the person left running. That boot is a host restart: nothing in memory, no window yet, no agent started.
 *
 * A window connects and names Genie 1's database (none here), which opens the process book and flows, as main.ts does on
 * every connect. Then every way the host starts a command must hand it DB_PORT and DB_PASSWORD:
 *   1. the kept worker the boot RESTORES;
 *   2. a kept process created now;
 *   3. a scheduled task's Run now;
 *   4. a flow's `genie/terminal_run`.
 * On beta.65 every one of them printed nothing for both: the env came only from a window's `engine.start`.
 *
 * Runs in the test VMs (spawns processes); never on the owner's desktop.
 */

const PORT = '33061';
const PASSWORD = 'fixture-db-pass';
const ENGINE_ID = 'mysql-8-ws';
let home: string;
let workspace: string;
let hostProcess: ChildProcess;
let hostLog = '';
let record: HostRecord;
let client: SessionEngineClient;
let transport: { close(): void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: unknown = null;
    for (;;) {
        try {
            const v = await fn();
            if (v) return v as T;
        } catch (error) { last = error; }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (last: ${last instanceof Error ? last.message : String(last)})` : ''}\n--- host log ---\n${hostLog}`);
        await sleep(200);
    }
}
const readText = async (file: string) => { try { return await readFile(file, 'utf8'); } catch { return null; } };

/** A host-owned call, answered in the host's words or thrown with them. */
async function call(method: 'engine.processes' | 'engine.flows', name: string, args: unknown[]): Promise<unknown> {
    const reply = await client.call(method, [name, args]);
    if (!reply.ok) throw new Error(reply.reason);
    return reply.value;
}

/** The probe line a command printed, by its label: `ENVPROBE <label> port=<DB_PORT> password=<DB_PASSWORD>`. */
const probeLine = (text: string, label: string): string | null => {
    // By pattern, not by line: a flow run's output arrives inside its JSON, newlines escaped. A value is anything up to
    // whitespace, a quote or a backslash; an unset variable reads empty (`port= password=`).
    const found = [...text.matchAll(new RegExp(`ENVPROBE ${label} port=[^\\s"\\\\]* password=[^\\s"\\\\]*`, 'g'))].map((m) => m[0]);
    return found.at(-1) ?? null;
};
const EXPECTED = (label: string) => `ENVPROBE ${label} port=${PORT} password=${PASSWORD}`;
/** Run as a script file without a shell (genie-host-process.test.ts: cmd.exe mangles a quoted -e line on Windows). */
const probe = (label: string) => `"${process.execPath}" probe.cjs ${label}`;

async function logOf(id: string): Promise<string> {
    const log = (await call('engine.processes', 'log', [id])) as { text?: string } | null;
    return log?.text ?? '';
}

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'genie-host-svcenv-'));
    workspace = await mkdtemp(join(tmpdir(), 'genie-host-svcenv-ws-'));
    const runtime = join(home, 'runtime');
    await mkdir(runtime, { recursive: true });
    // `stay` keeps it running, as a queue worker does; anything else prints and exits.
    await writeFile(join(workspace, 'probe.cjs'), [
        "const label = process.argv[2];",
        "console.log(`ENVPROBE ${label} port=${process.env.DB_PORT ?? ''} password=${process.env.DB_PASSWORD ?? ''}`);",
        "if (label === 'restored') setInterval(() => {}, 60000);",
        '',
    ].join('\n'));
    await writeFile(join(runtime, 'workspaces.json'), JSON.stringify([{ id: 'ws', path: workspace }]));
    // What an earlier run of the host recorded: the workspace's own MySQL, and (below) its kept worker.
    await writeFile(join(runtime, 'services.json'), JSON.stringify({ instances: [{
        id: ENGINE_ID, engine: 'mysql', version: '8', scope: { kind: 'dedicated', workspaceId: 'ws' }, publishedPort: Number(PORT),
        credentials: { user: 'app', password: PASSWORD, database: 'app' }, active: true,
    }] }));
    // Stopped by the person: the boot's reconcile leaves it alone (no image pulled), and its variables are the workspace's all the same.
    await writeFile(join(runtime, 'engine-run-state.json'), JSON.stringify({ stopped: [ENGINE_ID] }));
    await writeFile(join(runtime, 'processes.json'), JSON.stringify({ processes: [{
        id: 'proc_restored', workspaceId: 'ws', name: 'queue worker', command: probe('restored'), cwd: workspace, restart: 'always', wanted: true, changedAt: Date.now(),
    }] }));
    hostProcess = spawn(process.execPath, ['--import', TSX, 'src/main/genie-host.ts'], {
        env: { ...process.env, GENIE_HOME: home, GENIE_HOST_BUILD: 'svcenv-test', GENIE_HOST_IDLE_MS: '600000', GENIE_SPAWN_HOST_ENTRY: resolve('src/main/spawn-host.ts') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    hostProcess.stdout?.on('data', (d) => { hostLog += String(d); });
    hostProcess.stderr?.on('data', (d) => { hostLog += String(d); });
    record = await until('host.json', async () => {
        const r = parseHostRecord(await readText(join(runtime, 'host.json')));
        return r && r.pid === hostProcess.pid ? r : null;
    }, 120_000);
    const token = (await readFile(join(runtime, 'host.token'), 'utf8')).trim();
    const socket = await connectSocket(record.endpoint);
    transport = socket;
    // A window that starts no agent and hands over no service env.
    client = new SessionEngineClient({ env: () => ({ ...process.env }) as Record<string, string> });
    expect(await client.connect(socket, token)).toMatchObject({ ok: true });
    // As main.ts does on connect: Genie 1's database (none on this machine), which opens the process book and the flows.
    await client.v1Import(join(home, 'no-genie-1', 'genie.db'));
}, 180_000);

afterAll(async () => {
    // The restored worker stays up by design: stopped by the host first, as the person's Stop does.
    if (client) await call('engine.processes', 'stop', ['proc_restored']).catch(() => {});
    transport?.close();
    if (hostProcess && hostProcess.exitCode === null) hostProcess.kill('SIGKILL');
    await sleep(500);
    // The restored worker stays up by design: end it by the pid the host recorded for it.
    const children = await readText(join(home, 'runtime', 'children.json'));
    for (const pid of children ? (JSON.parse(children) as { records: Array<{ processes: Array<{ pid: number }> }> }).records.flatMap((r) => r.processes.map((p) => p.pid)) : []) {
        if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('a restarted genie-host hands its processes the workspace\'s service env, with no agent started (Tynn #1044)', () => {
    it('1. the kept queue worker the boot RESTORES gets DB_PORT and DB_PASSWORD', async () => {
        const line = await until('the restored worker\'s probe line', async () => probeLine(await logOf('proc_restored'), 'restored'), 60_000);
        expect(line).toBe(EXPECTED('restored'));
    }, 90_000);

    it('2. a kept process created now gets them', async () => {
        const started = (await until('the process book', () => call('engine.processes', 'create', [{ workspaceId: 'ws', workspacePath: workspace, name: 'probe once', command: probe('created'), restart: 'never' }]), 30_000)) as { id: string };
        const line = await until('the created process\'s probe line', async () => probeLine(await logOf(started.id), 'created'), 60_000);
        expect(line).toBe(EXPECTED('created'));
    }, 120_000);

    it('3. a scheduled task\'s Run now gets them', async () => {
        const task = (await call('engine.processes', 'create', [{ workspaceId: 'ws', workspacePath: workspace, name: 'nightly probe', command: probe('scheduled'), restart: 'never', schedule: { cron: '0 3 * * *', kind: 'command' } }])) as { id: string };
        expect(await call('engine.processes', 'runNow', [task.id])).not.toBe('held');
        const line = await until('the scheduled task\'s probe line', async () => probeLine(await logOf(task.id), 'scheduled'), 60_000);
        expect(line).toBe(EXPECTED('scheduled'));
    }, 120_000);

    it('4. a flow\'s terminal_run gets them', async () => {
        const trigger = { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } };
        const step = { id: 's', kind: 'genie/terminal_run', position: { x: 240, y: 0 }, config: { workspace: 'ws', command: probe('flow') } };
        const document = { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [trigger, step], edges: [{ id: 'e1', source: 't', target: 's' }] } };
        const flow = (await until('the flows', () => call('engine.flows', 'create', [{ workspaceId: 'ws', name: 'env probe', document, by: { kind: 'user' } }]), 30_000)) as { id: string };
        const run = await call('engine.flows', 'runNow', [flow.id]);
        expect(run).toMatchObject({ outcome: 'ran' });
        expect(probeLine(JSON.stringify(run), 'flow')).toBe(EXPECTED('flow'));
    }, 120_000);
});

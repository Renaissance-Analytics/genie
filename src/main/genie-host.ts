import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_PROTOCOL, hostEndpoint, parseHostRecord, type HostRecord } from '../core/engine-protocol.js';
import { lineTransport } from '../core/line-transport.js';
import { describeProcesses, systemProcessTree } from '../core/process-tree.js';
import { doctorHoldNow } from './genie-running-file.js';
import { openLifecycleLog } from './lifecycle-log.js';
import { genieHome, runtimeDir } from './paths.js';
import { prepareGenieSupervisor, removeStaleSupervisorBuilds, supervisorImagesRunning } from './prism-supervisor.js';
import { SessionEngineServer } from './session-engine-server.js';
import { SessionHost } from './session-host.js';
import { SpawnLedger } from './spawn-ledger.js';
import { startSpawnRelay, type SpawnRelay } from './spawn-relay.js';
import { FilesWatchHub } from './files-watch-hub.js';
import { gitTreeStatus } from './git-ports.js';
import { repoStatus } from './repo-git.js';

/**
 * GENIE-HOST — the per-user host process (the host split, phase 1: `.ai/plans/genie-2-host-split-2026-10-31.md`).
 *
 * The owner, 2026-10-31: "the actions agents take should not be routed through my UI … All work should be handled on the
 * host side." This process runs every agent: its provider, its ACP parsing, its ledger, its thread writes, its
 * containment and the record of what it spawned. The window (Electron main) is a client of it over the engine protocol
 * (core/engine-protocol.ts) and keeps only a replica. A window that freezes, crashes or restarts does not stop an agent.
 *
 * Imports nothing from `electron`: it runs on Electron's binary as plain Node (`ELECTRON_RUN_AS_NODE=1`, started by
 * main/engine-launch.ts) and later on a standalone runtime (plan phase 6).
 *
 * Its files, in `<genieHome>/runtime/`:
 *  - `host.json`  — `{pid, endpoint, protocol, build, startedAt}`: how a window finds it and decides adopt/replace;
 *  - `host.token` — the token a window says in `hello` (0600; a new one per start);
 *  - `host.sock`  — the endpoint (not Windows, where it is a per-user named pipe).
 *
 * It exits when told to (`engine.shutdown`, SIGTERM), or once nothing has run and no window has been connected for
 * `GENIE_HOST_IDLE_MS` (10 minutes). Whether it should stay up longer is the owner's decision O1 in the plan.
 */

const home = process.env.GENIE_HOME && process.env.GENIE_HOME.length > 0 ? process.env.GENIE_HOME : genieHome();
const runtime = runtimeDir(home);
const build = process.env.GENIE_HOST_BUILD ?? 'dev';
const IDLE_MS = Number(process.env.GENIE_HOST_IDLE_MS ?? 10 * 60_000);
const recordFile = join(runtime, 'host.json');
const tokenFile = join(runtime, 'host.token');

mkdirSync(runtime, { recursive: true });
const lifecycleLog = openLifecycleLog(runtime);
const say = (line: string): void => {
    console.log(`[genie-host] ${new Date().toISOString()} ${line}`);
};

// A fault in one agent's handling never takes every agent down with the process (main.ts's policy, the same here).
process.on('uncaughtException', (error) => say(`uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
process.on('unhandledRejection', (error) => say(`unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));

async function main(): Promise<void> {
    const userKey = createHash('sha256').update(home).digest('hex').slice(0, 16);
    const endpoint = hostEndpoint(process.platform, runtime, userKey);

    // ONE HOST PER USER, by the endpoint: bound FIRST, before anything is swept or spawned. A second host finds it taken
    // and leaves the running one alone (Genie 1 genie#774: a second host over a live one took the fleet down).
    const server: Server = createServer();
    const bound = await listenOnce(server, endpoint);
    if (!bound) {
        say(`another host already serves ${endpoint}; this one exits`);
        process.exit(0);
    }
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600);

    lifecycleLog(`host boot pid=${process.pid} build=${build} endpoint=${endpoint}`);
    /*
     * THE SPAWN LEDGER AND ITS SWEEP, here now (they were main.ts's): what a previous host left running — a crash, a
     * kill, an installer — is ended BEFORE any agent starts, from the record only (pid, start time and name must match).
     * A window that adopts a live host never sweeps: that would end the host's own providers.
     */
    const spawnLedger = SpawnLedger.open(join(runtime, 'children.json'), randomUUID());
    spawnLedger.sweep(systemProcessTree, lifecycleLog);
    // prism-acp's supervisor (a Job Object on Windows) before any agent starts: a provider is never run uncontained.
    const supervisor = await prepareGenieSupervisor(runtime).catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        lifecycleLog(`containment unready reason=${why}`);
        say(`agents cannot start contained: ${why}`);
        return null;
    });
    // What other supervisor sources left beside it is removed off the start path — never what a running process uses.
    if (supervisor !== null) {
        void removeStaleSupervisorBuilds(runtime, { current: supervisor, runningImages: supervisorImagesRunning }).then(
            (sweep) => { for (const path of sweep.removed) lifecycleLog(`supervisor stale removed path=${path}`); },
            (error: unknown) => lifecycleLog(`supervisor stale sweep failed reason=${error instanceof Error ? error.message : String(error)}`),
        );
    }

    const token = randomBytes(32).toString('hex');
    let shuttingDown = false;
    let lastBusy = Date.now();
    // The spawn-host children (the host split, P2.1), bound late: they and the engine server refer to each other.
    let relay: SpawnRelay | null = null;
    /*
     * THE FILE WATCHER AND GIT (the host split, P2.2; plan §11b): one watcher per workspace while a window's view holds
     * it, one batch per 250 ms to the windows watching, git once per batch. Here, so none of it runs in the window.
     */
    let files: FilesWatchHub | null = null;
    const engine = new SessionEngineServer({
        token,
        build,
        pid: process.pid,
        log: say,
        onShutdown: () => void shutdown('a window asked'),
        onClients: (n) => { lastBusy = Date.now(); say(`windows connected: ${n}`); },
        spawn: { send: (profile, frame) => relay?.send(profile, frame), windowGone: () => relay?.windowGone() },
        files: {
            subscribe: (owner, viewId, workspace, want) => files?.subscribe(owner, viewId, workspace, want),
            unsubscribe: (owner, viewId) => files?.unsubscribe(owner, viewId),
            dropOwner: (owner) => files?.dropOwner(owner),
        },
    });
    files = new FilesWatchHub({ send: (owner, event) => engine.filesEvent(owner, event), gitTree: gitTreeStatus, repoStatus, log: say });
    const host = new SessionHost({
        userData: home,
        ...engine.hostOptions(),
        // Doctor mode beside Genie holds the workspace it runs an agent in (core/genie-running.ts): a file read, here.
        heldElsewhere: (record) => {
            const hold = doctorHoldNow(home);
            return hold !== null && hold.workspaceId === record.workspaceId
                ? `doctor mode is running an agent in this workspace (pid ${hold.pid}); stop it there, or close doctor mode, then start ${record.name}`
                : null;
        },
        lifecycle: {
            spawned: (agentId, run, processes) => {
                spawnLedger.record({ kind: 'agent', ownerId: agentId, run, processes });
                lifecycleLog(`spawn kind=agent owner=${agentId} run=${run} pids=${describeProcesses(processes)}`);
            },
            ended: (agentId, run, verdict) => {
                if (verdict.verified) {
                    spawnLedger.forget('agent', agentId, run);
                    lifecycleLog(`exit kind=agent owner=${agentId} run=${run} verified ended=${verdict.ended}`);
                    return;
                }
                if (verdict.survivors.length > 0) spawnLedger.record({ kind: 'agent', ownerId: agentId, run, processes: verdict.survivors });
                lifecycleLog(`refused kind=agent owner=${agentId} run=${run} survivors=${describeProcesses(verdict.survivors)} reason=${verdict.reason}`);
                engine.callback({ name: 'stopUnverified', agentId, reason: verdict.reason });
            },
            straggler: (agentId, run) => lifecycleLog(`straggler kind=agent owner=${agentId} run=${run} output after stop, not recorded`),
        },
    });
    engine.attach(host);
    host.subscribe(() => { lastBusy = Date.now(); });
    /*
     * EVERY PROCESS THE WINDOW STARTS, STARTED HERE (the host split, P2.1; plan §11a): #1405's spawn host as THIS
     * process's children — `processes` (exec, streams, supervised ptys) and `terminals` (interactive shells) — so a site,
     * a queue worker and an open terminal outlive the window, and the next window takes them back.
     */
    relay = startSpawnRelay({
        entry: process.env.GENIE_SPAWN_HOST_ENTRY && process.env.GENIE_SPAWN_HOST_ENTRY.length > 0 ? process.env.GENIE_SPAWN_HOST_ENTRY : join(dirname(fileURLToPath(import.meta.url)), 'spawn-host.js'),
        send: (profile, frame) => engine.spawnFrame(profile, frame),
        log: (line) => { say(line); lifecycleLog(line); },
    });

    server.on('connection', (socket) => engine.accept(lineTransport(socket)));

    // The token first, then the record that points at it: a window that reads the record can always read the token.
    writeFileSync(tokenFile, token, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(tokenFile, 0o600);
    const record: HostRecord = { pid: process.pid, endpoint, protocol: ENGINE_PROTOCOL, build, startedAt: Date.now() };
    writeFileSync(recordFile, JSON.stringify(record), { mode: 0o600 });
    say(`serving ${endpoint} (protocol ${ENGINE_PROTOCOL}, build ${build})`);

    async function shutdown(why: string): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        say(`shutting down: ${why}`);
        lifecycleLog(`host shutdown pid=${process.pid} reason=${why}`);
        const bound = new Promise<void>((r) => setTimeout(r, 10_000).unref());
        // Every session stopped and its stop verified, every write drained — bounded, so a stuck stop never keeps a
        // host nobody wants.
        await Promise.race([host.stopAll().then(() => host.drained(2_000)), bound]).catch(() => undefined);
        // Then every process the window started ("Shut down everything"): the spawn-host children end their ptys.
        files?.close();
        await relay?.stop().catch(() => undefined);
        server.close();
        // Only this host's record: a newer host may already have written its own.
        const current = parseHostRecord(readOrNull(recordFile));
        if (current?.pid === process.pid) {
            rmSync(recordFile, { force: true });
            rmSync(tokenFile, { force: true });
        }
        process.exit(0);
    }
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    // IDLE EXIT: nothing running and no window for IDLE_MS. While an agent runs, the host stays — that is the point.
    setInterval(() => {
        if (host.count > 0 || engine.clients > 0 || (relay?.live() ?? 0) > 0) { lastBusy = Date.now(); return; }
        if (Date.now() - lastBusy >= IDLE_MS) void shutdown(`idle ${Math.round(IDLE_MS / 1000)} s with no agent and no window`);
    }, Math.min(30_000, Math.max(1_000, Math.floor(IDLE_MS / 4)))).unref?.();
    // Kept alive by the server; the interval above is unref'd so it never holds a host that is otherwise done.
}

function readOrNull(file: string): string | null {
    try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Listen on the endpoint once. On POSIX a socket file left by a host that died is removed — but only after a connect to
 * it is refused (a live host answers). `false` = a live host owns it.
 */
function listenOnce(server: Server, endpoint: string): Promise<boolean> {
    const attempt = (): Promise<'ok' | 'busy'> => new Promise((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => { server.off('listening', onListening); if (error.code === 'EADDRINUSE') resolve('busy'); else reject(error); };
        const onListening = (): void => { server.off('error', onError); resolve('ok'); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(endpoint);
    });
    return attempt().then(async (first) => {
        if (first === 'ok') return true;
        if (process.platform === 'win32') return false;
        const live = await new Promise<boolean>((resolve) => {
            const probe = connect(endpoint);
            probe.once('connect', () => { probe.destroy(); resolve(true); });
            probe.once('error', () => resolve(false));
        });
        if (live) return false;
        rmSync(endpoint, { force: true });
        return (await attempt()) === 'ok';
    });
}

void main().catch((error: unknown) => {
    say(`could not start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
});

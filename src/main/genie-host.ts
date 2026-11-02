import './close-inherited-fds.js';
// ^ FIRST (bug A, VM job 76): the window's sockets — its DevTools port among them — never live on in this host or below it.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_PROTOCOL, hostEndpoint, parseHostRecord, type HostRecord } from '../core/engine-protocol.js';
import { lineTransport } from '../core/line-transport.js';
import { describeProcesses, systemProcessTree } from '../core/process-tree.js';
import { doctorHoldNow } from './genie-running-file.js';
import { openLifecycleLog } from './lifecycle-log.js';
import { genieHome, osaHomeDir, runtimeDir } from './paths.js';
import { prepareGenieSupervisor, removeStaleSupervisorBuilds, supervisorImagesRunning } from './prism-supervisor.js';
import { SessionEngineServer } from './session-engine-server.js';
import { SessionHost } from './session-host.js';
import { SpawnLedger } from './spawn-ledger.js';
import { startSpawnRelay, type SpawnRelay } from './spawn-relay.js';
import { SpawnHostClient } from './spawn-host-client.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { SupervisorService } from './supervisor-host.js';
import { TerminalHost } from './terminal-host.js';
import { TerminalsService } from './terminals-host.js';
import { ProcessBook } from './process-book.js';
import { ProcessScheduler } from './process-scheduler.js';
import { ProcessBookReplica, ProcessesService } from './processes-host.js';
import { FlowStore } from './flow-store.js';
import { FlowsReplica, FlowsService } from './flows-host.js';
import { startFlowsEngine } from './flows-engine.js';
import { FlowCallers, createFlowToolCaller } from './flow-tools.js';
import { runV1FlowImport } from './v1-flows.js';
import { moveScheduledTasksOutOfFlows } from './scheduled-tasks-move.js';
import { startForWork } from './start-on-demand.js';
import { startRefusal } from './workspace-ops-host.js';
import { agentCapFrom } from '../core/inbox.js';
import { limitOf } from '../core/shell-limits.js';
import { resolveAddress as resolveOnRoster } from '../core/inbox.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { pidAlive } from './engine-launch.js';
import { FilesWatchHub } from './files-watch-hub.js';
import { openHostKeychain } from './host-keychain.js';
import { GithubAccount } from './github-account.js';
import { GithubAccountService } from './github-account-service.js';
import { hostHttpsFetch } from './host-https-fetch.js';
import { hostAgentKeys } from './host-agent-keys.js';
import { readFile as readFileText } from 'node:fs/promises';
import { machineKeyOf, readMachineId } from './machine-key.js';
import { execFileText } from './toolchain-runner.js';
import { workstationKeyStore } from './workstation-identity.js';
import { WorkstationService } from './workstation-service.js';
import { DeviceLinkService, type DeviceSocket } from './device-link-service.js';
import { deviceTokenStore } from './device-tokens.js';
import { KeyringService } from './keyring-service.js';
import { hostTynnRecovery } from './host-tynn-recovery.js';
import { hostTynnPorts } from './host-tynn-account.js';
import { ProxyMemory } from './proxy-memory.js';
import { TynnAccount } from './tynn-account.js';
import { TynnAccountService } from './tynn-account-service.js';
import { Keychain } from './keychain.js';
import { TYNN_HOST } from '../core/tynn.js';
import { procStart, readPtyLedger, reapLeftoverPtys, realReapPorts, writePtyLedger } from './pty-ledger.js';
import { AgentStoresService } from './agent-stores-host.js';
import { ApprovalQueue, SWITCH_ANSWERS } from './approval-queue.js';
import { importV1Inbox, importV1Knowledge, openAgentStores } from './agent-stores-open.js';
import { startHostMcp, type HostMcp } from './host-mcp.js';
import type { ForwardedToolCall } from './mcp-host-tools.js';
import type { McpToolResult } from '@particle-academy/prism-mcp';
import { readV1Knowledge } from './v1-import.js';
import { readV1Inbox } from './v1-inbox.js';
import { SettingsStore } from './settings-store.js';
import { ChatDraftStore } from './chat-draft-store.js';
import { readV1Settings } from './v1-settings.js';
import { Store } from './store.js';
import { HostRegistry } from './host-registry.js';
import { wireHostMailWake } from './host-mail-wake.js';
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
    // THE KEYCHAIN (P3.4 cut a): said in the log, off the boot path. No keychain refuses secrets; it never stops the host.
    const keychain = new Keychain();
    const keychainOpening = openHostKeychain({ keychain });
    void keychainOpening.then((opened) => { const line = `keychain: ${opened.state()}`; say(line); lifecycleLog(line); }, (error: unknown) => { const line = `keychain: could not open: ${error instanceof Error ? error.message : String(error)}`; say(line); lifecycleLog(line); });
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
    /*
     * THE STORES AGENTS WRITE TO, AND GENIE'S MCP SERVER (the host split, P3.1; plan §11d): their one writer is this host,
     * so an agent's agentinbox, ForceTheQuestion, imDone, lists, plan and knowledge work with or without a window.
     */
    const own = await openAgentStores(home, () => new Date().toISOString());
    // THE SETTINGS AND THE CHAT DRAFTS (P3.2): one file each, one writer — this host. Every window a replica; hot-swap kept.
    const settings = await SettingsStore.open(home);
    const drafts = await ChatDraftStore.open(home);
    // THE REGISTRY'S FILES (P3.2): this host writes them (windows through it) and reads them for its own tools and approvals.
    const registryStore = new Store(home);
    const hostRegistry = new HostRegistry(registryStore);
    await hostRegistry.refresh();
    let engineRef: SessionEngineServer | null = null;
    const approvals = new ApprovalQueue({
        autoApproved: (caller) => hostRegistry.listAgents().some((a) => a.id === caller.agentId && a.autoApprove === true),
        granted: (caller, action) => {
            const flag = SWITCH_ANSWERS[action];
            return flag !== undefined && hostRegistry.listAgents().some((a) => a.id === caller.agentId && a[flag] === true);
        },
    });
    // The agent's calls while a window runs them (P3.1): a window tool's approval in this queue ends with its call (genie#1360).
    const forwardedCalls = new Map<string, import('./mcp-tools.js').McpCall>();
    const stores = new AgentStoresService({ ...own, approvals, settings, drafts, registry: { store: registryStore, model: hostRegistry } }, { forwardedCall: (id) => forwardedCalls.get(id) });
    let mcp: HostMcp | null = null;
    let v1Done = false;
    /*
     * THE PROCESS SUPERVISOR (P3.3b; plan §11e, decision 1a): sites' servers, queue workers, kept processes and the front
     * door, under THIS process — their restart policy and their logs run here, so a crashed queue worker restarts with the
     * UI closed. Its ptys are the `supervised` spawn-host child's, reached by a client inside this host (never a window).
     */
    const supervisedClient = new SpawnHostClient({ entry: '', link: { send: (frame) => relay?.send('supervised', frame) }, log: lifecycleLog });
    const processSupervisor = new ProcessSupervisor(
        supervisedClient.ptyPort(),
        { now: () => Date.now(), schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } },
        { pidAlive },
    );
    processSupervisor.watchLiveness();
    const supervisorService = new SupervisorService(processSupervisor);
    /*
     * THE TERMINALS (P3.3e): the `terminals` spawn-host child is this host's own now — its shells (and their scrollback)
     * outlive the window, and an agent's `manageTerminals` works with none. Windows drive them through the service.
     */
    const terminalsClient = new SpawnHostClient({ entry: '', link: { send: (frame) => relay?.send('terminals', frame) }, log: lifecycleLog });
    const terminalHost = new TerminalHost(terminalsClient.ptyPort(), { terminals: (workspaceId) => limitOf(settings.snapshotFor(workspaceId), 'terminals') });
    const terminalsService = new TerminalsService(terminalHost);
    /** This host's own spawn-host children (no window reaches them): their frames, and their "ready". */
    const ownChildren: Record<'supervised' | 'terminals', SpawnHostClient> = { supervised: supervisedClient, terminals: terminalsClient };
    /*
     * THE PROCESS BOOK AND THE SCHEDULER (P3.3c): what the person keeps running is restored and started here, and a
     * scheduled task fires on this host's clock, with no window. Opened at the first window's v1 import (it names Genie 1's
     * database, whose background processes the book takes once) — the host is only ever started by a window until P6.
     */
    const processesService = new ProcessesService();
    /*
     * FLOWS (P3.3d): the flows file, the scheduler, the runner and the file trigger — an armed flow fires on this host's
     * clock with no window, its prompts reaching this host's sessions, its commands this host's supervisor, its tool steps
     * this host's tools. Opened at the first window's v1 import, like the process book.
     */
    const flowsService = new FlowsService();
    const flowCallers = new FlowCallers((id) => hostRegistry.workspace(id)?.path ?? null);
    // The flows as the host's own `flows` tool reads and drives them: the service's list, its actions in place.
    const hostFlows = new FlowsReplica((method, args) => flowsService.call(method, args));
    flowsService.onEvent((event) => hostFlows.apply(event));
    // The book as the host's own `processes` tool reads and drives it: the service's list, its actions in place.
    const hostBook = new ProcessBookReplica((method, args) => processesService.call(method, args));
    processesService.onEvent((dump) => hostBook.rebase(dump));
    const proxyMemory = ProxyMemory.open(join(runtime, 'host-proxy.json'), say);
    const tynnOpening = proxyMemory.then((memory) => TynnAccount.open(hostTynnPorts({
        file: join(home, 'credentials', 'tynn.json'),
        host: () => TYNN_HOST,
        secrets: keychain,
        proxyRoutes: (url) => memory.routesFor(url),
        log: say,
        schedule: (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
    })));
    // GITHUB'S ACCOUNT (P3.4 cut c): its tokens and the authenticated git are here, and never cross to a window.
    const githubOpening = proxyMemory.then((memory) => {
        const send = hostHttpsFetch({ proxyRoutes: (url) => memory.routesFor(url), log: say, followSameOrigin: 5 });
        return GithubAccount.open({
            file: join(home, 'github.json'),
            secrets: keychain,
            fetch: (url, init) => send(url, { ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60_000) } as never) as never,
        });
    });
    void githubOpening.then((account) => account.refresh(), (error: unknown) => say(`the GitHub account could not open: ${error instanceof Error ? error.message : String(error)}`));
    let hostTynn: TynnAccount | null = null;
    void tynnOpening.then((account) => { hostTynn = account; }, (error: unknown) => say(`the Tynn account could not open: ${error instanceof Error ? error.message : String(error)}`));
    // THE HOST PREPARES ITS AGENTS (P3.4 cut c), with a window open or not. A start waits for the account: opening has its own deadline.
    const agentKeys = hostAgentKeys({
        vaultFile: join(home, 'agent-credentials', 'agents.json'),
        keychain,
        tynn: () => hostTynn,
        workspaces: () => hostRegistry.listWorkspaces(),
        ready: () => tynnOpening.catch(() => null),
        settled: () => stores.registrySettled(),
        onPrepared: () => tynnRecovery?.kick(),
    });
    // THE HOST BRINGS TYNN TOOLS BACK, with no window (host-tynn-recovery.ts). Built once the session host exists.
    let tynnRecovery: ReturnType<typeof hostTynnRecovery> | null = null;
    /** Thread ids heard while no window may be there to record them: a restart resumes this conversation. */
    const threadsHeard = new Map<string, string>();
    const engine = new SessionEngineServer({
        token,
        build,
        pid: process.pid,
        log: say,
        onShutdown: () => void shutdown('a window asked'),
        onClients: (n) => { lastBusy = Date.now(); say(`windows connected: ${n}`); },
        // A window reaches its own profiles only: `supervised` is this host's supervisor's, and no window sends into it.
        // A window reaches the `processes` child only: `supervised` and `terminals` are this host's own (P3.3b, P3.3e).
        spawn: { send: (profile, frame) => { if (profile === 'processes') relay?.send('processes', frame); }, windowGone: () => relay?.windowGone() },
        terminals: terminalsService,
        supervisor: supervisorService,
        processes: processesService,
        flows: flowsService,
        stores,
        keychain,
        // THE TYNN ACCOUNT (P3.4 cut c). Opening asks Tynn who it is, so it is not awaited here: the host's boot does not wait on the network.
        tynn: new TynnAccountService(tynnOpening, { host: TYNN_HOST, recovery: async (asked) => { await tynnRecovery?.recover(asked); return []; } }),
        github: new GithubAccountService(githubOpening),
        // THIS MACHINE'S KEY IS HERE (P3.4). The relay is the window's until P5, so it asks this to sign.
        // Other machines: the host dials them, and holds the tokens that open them (P3.4 cut e).
        deviceLink: new DeviceLinkService({
            tokens: deviceTokenStore(join(runtime, 'device-hosts.json'), keychain),
            socket: (url) => new WebSocket(url) as unknown as DeviceSocket,
            send: (owner, event) => engine.deviceEvent(owner, event),
            log: say,
        }),
        workstation: new WorkstationService({
            store: workstationKeyStore(join(home, 'workstation.json'), keychain),
            request: async (path, init) => (await tynnOpening).request(path, init),
            host: () => TYNN_HOST,
            hostname,
            machineKey: () => readMachineId({
                platform: process.platform,
                readFile: (path) => readFileText(path, 'utf8'),
                exec: (command, args) => execFileText(command, [...args], { timeoutMs: 10_000 }),
            }).then((id) => (id ? machineKeyOf(id) : null)),
        }),
        // THE KEYRING CARD READS THIS HOST (P3.4 cut c). When the keychain comes to answer, what reads secrets reads again, with nobody restarting anything.
        keyring: new KeyringService(keychainOpening.then((opened) => opened.keyring, () => null), {
            onReady: () => {
                void tynnOpening.then((account) => account.reload()).catch(() => {});
                void githubOpening.then((account) => account.reload()).catch(() => {});
                void tynnRecovery?.recover({ secretsMoved: true });
            },
        }),
        // What the OS said about proxies, from the last window. A new answer may be the cure, so Tynn is asked again if it is out of reach.
        proxy: {
            remember: async (answers) => {
                await (await proxyMemory).remember(answers);
                const account = await tynnOpening.catch(() => null);
                if (account && !account.status().signedIn && account.savedUserId() !== null) await account.recheck();
            },
        },
        agentKeys,
        mcp: {
            setView: (view) => mcp!.setView(view as never),
            sessionServers: (record) => mcp!.sessionServers(record),
            status: () => mcp!.status(),
            runNative: (call) => mcp!.runNative(call),
        },
        // Genie 1's memories and AgentInbox history, once, from the database only the window can locate.
        v1Import: async (databasePath) => {
            if (v1Done) return;
            v1Done = true;
            // Genie 1's settings carried over once (the store records it), then its memories and mail.
            await settings.carryOverFromV1(readV1Settings(databasePath)).catch((error: unknown) => say(`v1 settings carry-over failed: ${error instanceof Error ? error.message : String(error)}`));
            importV1Knowledge(own.knowledge, () => readV1Knowledge(databasePath), say);
            await openProcessBook(databasePath);
            await openFlows(databasePath);
            await importV1Inbox(own.inbox, () => readV1Inbox(databasePath), hostRegistry.listAgents(), Date.now());
        },
        files: {
            subscribe: (owner, viewId, workspace, want) => files?.subscribe(owner, viewId, workspace, want),
            unsubscribe: (owner, viewId) => files?.unsubscribe(owner, viewId),
            dropOwner: (owner) => files?.dropOwner(owner),
        },
    });
    engineRef = engine;
    files = new FilesWatchHub({ send: (owner, event) => engine.filesEvent(owner, event), gitTree: gitTreeStatus, repoStatus, log: say });
    const engineHostOptions = engine.hostOptions();
    const host = new SessionHost({
        userData: home,
        ...engineHostOptions,
        onThreadId: (agentId, threadId) => { threadsHeard.set(agentId, threadId); engineHostOptions.onThreadId(agentId, threadId); },
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
    tynnRecovery = hostTynnRecovery({
        names: (asked) => agentKeys.recovery(asked),
        waiting: () => agentKeys.waiting(),
        recheck: async () => { await hostTynn?.recheck(); },
        host,
        record: (id) => hostRegistry.find(id),
        threadOf: (id) => threadsHeard.get(id) ?? null,
        cwdFor: (record) => hostRegistry.workspace(record.workspaceId)?.path ?? osaHomeDir(),
        log: say,
    });
    void tynnOpening.then((account) => {
        account.onChange(() => { void tynnRecovery?.recover(); });
        // Agents may have started while it opened.
        void tynnRecovery?.recover();
        tynnRecovery?.kick();
    }, () => {});
    /** Kept processes' app-inbox credentials, as a window minted them (P3.3c); none with no window since the host began. */
    const appEnvCache = new Map<string, Readonly<Record<string, string>>>();
    const refreshAppEnvs = async (book: ProcessBook): Promise<void> => {
        const kept = book.kept().map((p) => ({ id: p.id, name: p.name, workspaceId: p.workspaceId }));
        if (kept.length === 0 || !engine.windowConnected()) return;
        const envs = await engine.appEnvs(kept).catch(() => ({} as Record<string, Record<string, string>>));
        for (const [id, env] of Object.entries(envs)) appEnvCache.set(id, env);
    };
    /** Flows (P3.3d), once — at the first window's v1 import, after the book (the old scheduled tasks move into it). */
    let flowsOpening: Promise<void> | null = null;
    let processBookNow: ProcessBook | null = null;
    const openFlows = (databasePath: string): Promise<void> => {
        flowsOpening ??= (async () => {
            const store = await FlowStore.open(home);
            // Genie 1's FLOWS (genie#1204), once, DISARMED — before the scheduler plans, which arms nothing they bring.
            await runV1FlowImport(store, { database: databasePath, workspaces: hostRegistry.listWorkspaces() }).catch((error: unknown) => say(`v1 flows import failed: ${error instanceof Error ? error.message : String(error)}`));
            // The scheduled tasks earlier betas imported as FLOWS move to the processes they were in Genie 1 — once, by a marker.
            if (processBookNow) await moveScheduledTasksOutOfFlows(store, processBookNow, (id) => hostRegistry.workspace(id)?.path ?? null).catch((error: unknown) => say(`scheduled tasks could not be moved out of Flows: ${error instanceof Error ? error.message : String(error)}`));
            const cwdOf = (r: AgentRecord): string => hostRegistry.workspace(r.workspaceId)?.path ?? osaHomeDir();
            const engineFlows = startFlowsEngine({
                store,
                now: Date.now,
                asleep: (id) => hostRegistry.workspace(id)?.asleep === true,
                workspacePath: (id) => hostRegistry.workspace(id)?.path ?? null,
                sessions: {
                    session: (id) => host.probe(id as AgentId),
                    rows: (id) => host.rowsFor(id as AgentId),
                    // A flow's prompt is work: an agent not running is started for it, under the person's refusals (q_04ce323c).
                    start: async (id) => {
                        const record = hostRegistry.find(id);
                        if (!record) return false;
                        const refusal = (r: AgentRecord) => startRefusal({ registry: hostRegistry }, r, {
                            running: hostRegistry.listAgents().filter((a) => a.workspaceId === r.workspaceId && host.probe(a.id as AgentId)?.running === true).length,
                            cap: agentCapFrom(settings.snapshotFor(r.workspaceId)),
                        });
                        return (await startForWork({ probe: (x) => host.probe(x), start: (r, cwd) => host.start(r, cwd), cwdFor: cwdOf, startRefusal: refusal }, record)).ok;
                    },
                    prompt: (id, text, by) => host.prompt(id as AgentId, text, by),
                    subscribe: (listener) => host.subscribe(listener),
                },
                resolve: (text) => resolveOnRoster(text, hostRegistry.listAgents(), hostRegistry.workspaceSlugs()),
                agent: (id) => { const r = hostRegistry.find(id); return r ? { name: r.name, workspaceId: r.workspaceId } : null; },
                supervisor: processSupervisor,
                envFor: (id) => engine.serviceEnvFor(id),
                addKnowledge: async (entry) => ({ id: own.knowledge.add(entry as never).id }),
                attention: own.attention,
            });
            // Genie's tools as flow steps: the host's MCP server's own (its native ones in place, the window's forwarded).
            const regs = mcp?.registrations() ?? [];
            if (regs.length > 0) engineFlows.setToolCaller(createFlowToolCaller({ registrations: regs, callers: flowCallers }));
            flowsService.attach({ store, scheduler: engineFlows.scheduler });
            // A hibernate or a wake changes what may fire: plan again on every registry write.
            stores.onEvent((event) => { if (event.store === 'registry') engineFlows.scheduler.plan(); });
            lifecycleLog(`flows open: ${store.list().length} flow(s)`);
        })();
        return flowsOpening;
    };
    /** The process book and its scheduler (P3.3c), once — at the first window's v1 import, which names Genie 1's database. */
    let bookOpening: Promise<void> | null = null;
    const openProcessBook = (databasePath: string): Promise<void> => {
        bookOpening ??= (async () => {
            const deps = {
                supervisor: processSupervisor,
                // The workspace's service variables the last window handed over (its engines are the window's until P5).
                envFor: (workspaceId: string) => engine.serviceEnvFor(workspaceId),
                appEnv: (p: { readonly id: string }) => appEnvCache.get(p.id) ?? {},
                asleep: (workspaceId: string) => hostRegistry.workspace(workspaceId)?.asleep === true,
            };
            const processBook = await ProcessBook.open(home, {
                ...deps,
                limit: (workspaceId) => limitOf(settings.snapshotFor(workspaceId), 'processes'),
                v1: { database: databasePath, workspaces: () => hostRegistry.listWorkspaces(), roster: () => hostRegistry.listAgents() },
            });
            const scheduler = new ProcessScheduler({
                ...deps,
                book: processBook,
                // A nudge reaches its agent by its address, on the host's roster, at its turn's end.
                nudge: (address, text, from) => {
                    const found = resolveOnRoster(address, hostRegistry.listAgents(), hostRegistry.workspaceSlugs());
                    return found.kind === 'one' ? host.deliver(found.id as AgentId, text, `scheduled task "${from}"`) : false;
                },
                now: Date.now,
                schedule: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 2 ** 31 - 1)); return () => clearTimeout(t); },
            });
            scheduler.plan();
            // A workspace hibernated or woken changes what may fire: plan again on every registry write.
            stores.onEvent((event) => { if (event.store === 'registry') scheduler.plan(); });
            processesService.attach({ book: processBook, scheduler, supervisor: processSupervisor });
            processBookNow = processBook;
            // Each kept process's app-inbox credential, minted by the window that is here, BEFORE they are restored.
            await refreshAppEnvs(processBook);
            const restored = processBook.restore();
            lifecycleLog(`process book open: ${restored.started.length} restored, ${restored.heldBack.length} held back`);
        })();
        return bookOpening;
    };
    // THE MAIL WAKE (P3.2): mail reaches its agent with no window — told, or started for it under the person's refusals.
    wireHostMailWake({ inbox: own.inbox, host, registry: hostRegistry, settings, osaDir: osaHomeDir(), log: (line) => { say(line); lifecycleLog(line); } });
    mcp = startHostMcp({
        stores: stores.stores,
        settings,
        records: () => hostRegistry.listAgents(),
        registry: hostRegistry,
        probe: (id) => host.probe(id),
        lastRowAt: (id) => host.rowsFor(id).at(-1)?.at ?? null,
        reportPlan: (id, steps) => host.reportPlan(id, steps),
        window: { connected: () => engine.windowConnected(), call: (call: ForwardedToolCall) => engine.forwardTool(call) as Promise<McpToolResult> },
        openFileLater: (call) => engine.callback({ name: 'openFileForUser', call }),
        signal: (signal) => engine.callback({ name: 'toolSignal', signal }),
        forwardedCalls,
        processes: { book: hostBook, logs: (id, lines) => processSupervisor.readLog(id, lines), runNow: (id) => hostBook.runNow(id) },
        terminals: { list: () => terminalHost.list(), open: (options) => terminalHost.open(options), write: (id, data) => terminalHost.write(id, data), scrollback: (id) => terminalHost.scrollback(id), finished: (id) => terminalHost.finished(id), refusal: (ws) => terminalHost.refusal(ws), scrollbackCap: 1_000_000 },
        // A shell an agent opens sees the workspace's service variables and Genie's MCP endpoint, as the person's do.
        terminalEnv: (workspaceId) => {
            const endpoint = mcp?.endpoint() ?? null;
            return { ...engine.serviceEnvFor(workspaceId), ...(endpoint ? { GENIE_MCP_URL: endpoint.url, GENIE_MCP_TOKEN: endpoint.token } : {}) };
        },
        flows: { store: hostFlows, runNow: (id) => hostFlows.runNow(id) },
        flowCallers,
        endpointFile: join(home, 'mcp-endpoint.json'),
        log: (line) => { say(line); lifecycleLog(line); },
    });
    host.subscribe(() => { lastBusy = Date.now(); });
    /*
     * EVERY PROCESS THE WINDOW STARTS, STARTED HERE (the host split, P2.1; plan §11a): #1405's spawn host as THIS
     * process's children — `processes` (exec, streams, supervised ptys) and `terminals` (interactive shells) — so a site,
     * a queue worker and an open terminal outlive the window, and the next window takes them back.
     */
    // A PTY NEVER OUTLIVES ITS OWNER (bug B, VM job 76): what a dead host left running — its spawn hosts SIGKILLed with it,
    // so nothing ended their ptys — is reaped before this host starts its own (main/pty-ledger.ts). Then the ledger is ours.
    const ptyLedgerFile = join(runtime, 'ptys.json');
    const leftover = readPtyLedger(ptyLedgerFile);
    if (leftover) reapLeftoverPtys(leftover, realReapPorts((line) => { say(line); lifecycleLog(line); }));
    const writePtys = (ptys: ReadonlyArray<{ profile: string; id: string; pid: number }>): void => {
        try { writePtyLedger(ptyLedgerFile, { owner: process.pid, ptys: ptys.map((p) => ({ ...p, start: procStart(p.pid) })) }); } catch (error) { say(`pty ledger not written: ${error instanceof Error ? error.message : String(error)}`); }
    };
    writePtys([]);
    relay = startSpawnRelay({
        entry: process.env.GENIE_SPAWN_HOST_ENTRY && process.env.GENIE_SPAWN_HOST_ENTRY.length > 0 ? process.env.GENIE_SPAWN_HOST_ENTRY : join(dirname(fileURLToPath(import.meta.url)), 'spawn-host.js'),
        send: (profile, frame) => {
            if (profile === 'processes') { engine.spawnFrame(profile, frame); return; }
            // This host's own children: their frames are its own, and their "ready" is when their clients may open.
            const client = ownChildren[profile];
            client.linkFrame(frame);
            if (frame.kind === 'event' && frame.channel === 'host.ready') {
                void client.linkUp().catch((error: unknown) => lifecycleLog(`${profile} spawn host did not come up: ${error instanceof Error ? error.message : String(error)}`));
            }
        },
        // Between their lives, opens are refused in words (a crash the supervisor backs off from), never sent into nothing.
        onChildExit: (profile) => { if (profile !== 'processes') ownChildren[profile].linkDown(`the ${profile} spawn host exited`); },
        log: (line) => { say(line); lifecycleLog(line); },
        onPtys: writePtys,
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
        await mcp?.stop();
        approvals.cancelAll('Genie is shutting down');
        own.knowledge.close();
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

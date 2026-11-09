import './process-start.js';
import './close-inherited-fds.js';
// ^ FIRST but for the line above, which opens nothing (bug A, VM job 76): the window's sockets — its DevTools port among them — never live on in this host or below it.
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
import { genieRoot, osaHomeDir, runtimeDir } from './paths.js';
import { prepareGenieSupervisor, removeStaleSupervisorBuilds, supervisorImagesRunning } from './prism-supervisor.js';
import { SessionEngineServer } from './session-engine-server.js';
import { readTynnPage } from './tynn-page-client.js';
import { StallWatchdog } from './stall-watchdog.js';
import { HangWatchdog } from './hang-watchdog.js';
import { CrashStateHost } from './crash-state-host.js';
import { crashHeader, previousRunCause, previousRunRecord, readLifecycleTail, writeCrashRecord } from './crash-records.js';
import { runningAgentNote } from '../core/crash-record.js';
import { providerBinary, realListModels, SessionHost } from './session-host.js';
import { HostRegistryStore } from './agent-stores-replica.js';
import { ProviderModelCache } from '../core/provider-models.js';
import { HeadroomFeed, headroomBufferMs } from '../core/headroom-board.js';
import { TrustVerdicts } from './trust-verdict.js';
import { setGitReadPolicy, trustAwarePolicy } from './git-read-policy.js';
import { writeGenieInstructions } from './genie-instructions.js';
import { SpawnLedger } from './spawn-ledger.js';
import { startSpawnRelay, type SpawnRelay } from './spawn-relay.js';
import { routeExecThroughSpawnHost, SpawnHostClient } from './spawn-host-client.js';
import { setGitExecRoute } from './git-exec.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { SupervisorService } from './supervisor-host.js';
import { LinkGate } from './linked-stream.js';
import { composeHosting, type HostingStack } from './hosting-compose.js';
import { HostingService, WindowElevation } from './hosting-host.js';
import { AppInboxHost } from './app-inbox-host.js';
import { shutDownHosted } from './host-shutdown.js';
import { startBeat } from './safe-mode-beat.js';
import { SafeMode } from './safe-mode-host.js';
import { hostHostingOptions, hostMachinePaths } from './hosting-inputs.js';
import { TerminalHost } from './terminal-host.js';
import { TerminalsService } from './terminals-host.js';
import { TakeOverHost } from './take-over-host.js';
import { WorkspaceColors } from './workspace-color-host.js';
import { nodeEnvelopeFs } from './envelope-sites-host.js';
import { scratchArea } from './scratch-area.js';
import { TakeOverService } from './take-over-service.js';
import { ProcessBook } from './process-book.js';
import { BrowserService } from './browser-service.js';
import { spawnBrowserProcess, spawnGenieWindow, spawnUpdaterProcess } from './engine-launch.js';
import { clearUpdateFailed, helperLaunch, hostDrainAgents, readUpdateFailed, relaunchSpec, updaterDefaultLaunch, updaterHelperEnv, UpdatesService, writeUpdateFailed } from './updates-host.js';
import { killProcessAsync, listProcessesAsync, tcpSocketsOwnedByAsync } from './process-list.js';
import { windowReleased } from './window-release.js';
import { channelFrom } from '../core/update-channel.js';
import type { ReleaseLike } from '../core/update-notes.js';
import { hostIdleMs, hostIdleStep } from '../core/host-idle.js';
import { NO_BROWSER_HERE, NO_UPDATES_HERE, hostCapabilities } from '../core/host-runtime.js';
import { fts5Refusal } from './fts5-check.js';
import { restrictHostPipe } from './host-pipe-acl.js';
import { onTheClock } from '../core/tray-only.js';
import { ProcessScheduler } from './process-scheduler.js';
import { ProcessBookReplica, ProcessesService } from './processes-host.js';
import { FlowStore } from './flow-store.js';
import { FlowsReplica, FlowsService } from './flows-host.js';
import { startFlowsEngine } from './flows-engine.js';
import { FlowCallers, createFlowToolCaller } from './flow-tools.js';
import { GAppBridge, GAppCallers, createGAppToolRunner } from './gapp-bridge.js';
import { gappsApi } from './gapps-api.js';
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
import { workerWatchSource } from './files-watch-worker.js';
import { openHostKeychain } from './host-keychain.js';
import { GithubAccount } from './github-account.js';
import { GithubAccountService } from './github-account-service.js';
import { hostHttpsFetch } from './host-https-fetch.js';
import { hostAgentKeys } from './host-agent-keys.js';
import { chmod, mkdir, readFile as readFileText } from 'node:fs/promises';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { transportHub } from '../core/remote-protocol.js';
import { REMOTE_PORT } from '../core/tailscale.js';
import { resolveProgram } from '../core/program-lookup.js';
import { remoteListener } from './remote-listen.js';
import { remoteAccess } from './remote-access.js';
import { staticServer } from './static-page.js';
import { hostRemoteApi, RemoteAccessHost, RemoteAccessService } from './remote-access-host.js';
import { RelayHostService } from './relay-host-service.js';
import { droneRefusal } from '../core/workstation-role.js';
import { readWorkstationRole } from './workstation-role-reader.js';
import { dialFrontDoor } from './relay-site.js';
import type { HostApi } from './remote-host.js';
import { hostAloneApi } from './host-alone-api.js';
import { Registry } from './registry.js';
import { FilesHost } from './files-host.js';
import { fileEventsOf } from '../core/files-panel.js';
import { gitFileStatus, gitShowHead } from './git-ports.js';
import { assembleDeckItems } from './deck-assembly.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { AGENT_PUSH_INTERVAL_MS } from './agent-push.js';
import { isOsAgent } from '../core/os-agent.js';
import { machineKeyOf, readMachineId } from './machine-key.js';
import { execFileText } from './toolchain-runner.js';
import { workstationKeyStore } from './workstation-identity.js';
import { WorkstationService } from './workstation-service.js';
import { setWin32ProcessReader } from '../core/process-tree.js';
import { sharedWindowsHelper } from './private-credentials.js';
import { writeTextPrivate } from './store.js';
import { openRelayMember, PopKeypair } from './relay-member.js';
import { mintConnectGrant, relayHostPorts, startRelayHost } from './tynn-network.js';
import { RemoteBrowsers } from './remote-browsers.js';
import { siteDoor } from './relay-site.js';
import { DeviceLinkService } from './device-link-service.js';
import { deviceSocket } from './device-socket.js';
import { configWriter, writeWorkspaceConfig } from './workspace-config-sync.js';
import { deviceTokenStore } from './device-tokens.js';
import { KeyringService, restartBrowserOnUnlock } from './keyring-service.js';
import { hostTynnRecovery, wallClockJumps } from './host-tynn-recovery.js';
import { hostTynnPorts } from './host-tynn-account.js';
import { ProxyMemory } from './proxy-memory.js';
import { TynnAccount } from './tynn-account.js';
import { TynnAccountService } from './tynn-account-service.js';
import { openSecretKeychain } from './file-secrets.js';
import { TYNN_HOST } from '../core/tynn.js';
import { procStart, readPtyLedger, reapLeftoverPtys, realReapPorts, writePtyLedger } from './pty-ledger.js';
import { AgentStoresService } from './agent-stores-host.js';
import { ApprovalQueue, SWITCH_ANSWERS } from './approval-queue.js';
import { importV1Inbox, importV1Knowledge, openAgentStores } from './agent-stores-open.js';
import { attentionLimitsFrom } from './attention-store.js';
import { startHostMcp, type HostMcp } from './host-mcp.js';
import { hostPluginTools } from './plugins-host.js';
import { MARKETPLACE_PAGE_BYTES, openMarketplacePlugins } from './marketplace-client.js';
import { MarketplaceHost } from './marketplace-host.js';
import { MARKETPLACE_ARCHIVE_BYTES } from './marketplace-archive.js';
import { CatalogService } from './catalog-host.js';
import { GAppBook } from './gapps-host.js';
import { GAppServer } from './gapp-server.js';
import { setOfferedFlowKinds } from '../core/flow-canvas.js';
import { catalogFlowKinds } from '../core/catalog-projections.js';
import { hostCatalog } from './genie-catalog.js';
import { PUBLISHER_KEYS } from '../core/plugin-keys.js';
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
import { IssueWatchService, TynnBoardHub } from './issue-watch-host.js';
import { TYNN_ISSUES_FEED } from './tynn-issues-live.js';
import { TYNN_FEATURES_FEED } from './tynn-features-live.js';
import type { SocketLike } from './issue-watch-client.js';
import { dialTynnSocket } from './tynn-socket.js';
import { tynnProjectIdOf } from '../core/issue-watch.js';
import { workspaceNameFor } from './workspace-names.js';
import { gitTreeStatus } from './git-ports.js';
import { setThreadStoreSlowLog } from '../core/thread-store.js';
import { supervisorFailureWords } from '../core/supervisor-failure.js';
import { setProviderChoiceFile } from './provider-choice.js';
import { warmLockIdentity } from '@particle-academy/prism-harness';
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
 * It exits when told to (`engine.shutdown`, SIGTERM), or once it has held nothing (core/host-idle.ts) and no window has been
 * connected for `GENIE_HOST_IDLE_MS` (10 minutes; `0` = never, for a host no window will come back to: genie-cloud's, P10).
 *
 * It runs on Electron's binary as Node in the app, and on plain Node 22.13+ in genie-cloud's container (P10.1b): there, what
 * needs Electron — the Genie browser's process, and so `pages` — says it is not available on this host.
 */

const home = genieRoot();
const osaHome = osaHomeDir(home);
const runtime = runtimeDir(home);
const build = process.env.GENIE_HOST_BUILD ?? 'dev';
const IDLE_MS = hostIdleMs(process.env.GENIE_HOST_IDLE_MS);
/** What this host can have — a window, the Genie browser, an elevation — from ONE helper: all three in the app, none on plain Node (genie-cloud). */
const capabilities = hostCapabilities();
const recordFile = join(runtime, 'host.json');
const tokenFile = join(runtime, 'host.token');

mkdirSync(runtime, { recursive: true });
// Off the host's thread (Tynn #548): a line is queued and written in order; an exit writes what is left.
const lifecycleLog = openLifecycleLog(runtime, { async: true });
// A thread-store step past STORE_SLOW_MS names itself here (Tynn #557): the next stall says which await it was.
setThreadStoreSlowLog(lifecycleLog);
setProviderChoiceFile(join(runtime, 'provider-programs.json'));
const say = (line: string): void => {
    console.log(`[genie-host] ${new Date().toISOString()} ${line}`);
};

// A fault in one agent's handling never takes every agent down with the process (main.ts's policy, the same here).
process.on('uncaughtException', (error) => say(`uncaught: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
process.on('unhandledRejection', (error) => say(`unhandled rejection: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));

async function main(): Promise<void> {
    // FTS5 FIRST (P10.1b): a Node whose node:sqlite has none (before 22.16) refuses here, in words, with nothing bound.
    const noFts5 = fts5Refusal();
    if (noFts5 !== null) {
        say(noFts5);
        lifecycleLog(`host refused: ${noFts5}`);
        process.exit(1);
    }
    /*
     * WHERE SECRETS GO, chosen FIRST (P10.1a): the OS keychain, or with GENIE_SECRET_BACKEND=file the sealed files under
     * <root>/secrets (file-secrets.ts). A file backend that is misconfigured stops the host here, in words that say what to
     * fix, before it binds its endpoint: no window ever connects to a host that is about to exit, and it never runs on with
     * the other store, or with none.
     */
    const secrets = await openSecretKeychain(process.env, home);
    if (secrets.kind === 'refused') {
        say(secrets.reason);
        lifecycleLog(`host refused to start: ${secrets.reason}`);
        process.exit(1);
    }
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
    // THE PIPE ANSWERS ITS OWN USER ONLY (Tynn #398; host-pipe-acl.ts): on Windows, before host.json names it to anyone.
    const pipeAcl = await restrictHostPipe(server, endpoint);
    if (pipeAcl?.ok === true) lifecycleLog(`host pipe: its user and SYSTEM only (${pipeAcl.sddl})`);
    else if (pipeAcl) { say(`the host pipe keeps Windows' default access: ${pipeAcl.reason}`); lifecycleLog(`host pipe: NOT restricted: ${pipeAcl.reason}`); }
    /*
     * SAFE MODE (Tynn #386; safe-mode-host.ts), opened here: only the host that holds the endpoint reads and removes the
     * clean-exit marker (a second host exited above, touching nothing). With no marker the last run did not end cleanly,
     * and NOTHING starts by itself — every automatic start below asks it: the mail wake and IssueWatch's push, the
     * flows, the scheduled tasks, the kept processes, the sites, the engines; and the window's boot restore, over the link.
     */
    // Its cause (cut 3): the newest crash record since the previous host started — its host.json is still here until this one writes its own.
    // Its beat written off this host's thread (Tynn #538): a synchronous one held it 233 ms under a build's disk load.
    const safeMode = SafeMode.open(runtime, { asyncBeat: true, log: (line) => { say(line); lifecycleLog(line); }, cause: () => previousRunCause(join(runtime, 'crash'), parseHostRecord(readOrNull(recordFile))?.startedAt ?? null) });
    const safeNow = () => safeMode.active();
    // THE CRASH STATE (Tynn #386): the previous run's newest record (its host.json is still the old one here) and, after a
    // hang, the reopened window's notice; local windows are told both (crash-state-host.ts).
    const crashState = new CrashStateHost(previousRunRecord(join(runtime, 'crash'), parseHostRecord(readOrNull(recordFile))?.startedAt ?? null));
    // THE KEYCHAIN (P3.4 cut a): said in the log, off the boot path. No OS keychain refuses secrets; it never stops the host.
    const keychain = secrets.keychain;
    const keychainOpening = openHostKeychain({ keychain, backend: secrets.kind });
    void keychainOpening.then((opened) => { const line = `keychain: ${opened.state()}`; say(line); lifecycleLog(line); }, (error: unknown) => { const line = `keychain: could not open: ${error instanceof Error ? error.message : String(error)}`; say(line); lifecycleLog(line); });
    /*
     * THE SPAWN LEDGER AND ITS SWEEP, here now (they were main.ts's): what a previous host left running — a crash, a
     * kill, an installer — is ended BEFORE any agent starts, from the record only (pid, start time and name must match).
     * A window that adopts a live host never sweeps: that would end the host's own providers.
     */
    // On Windows, one long-lived PowerShell for this host's process readings and its private files (windows-helper.ts). It ends when this process does, however it does.
    if (process.platform === 'win32') setWin32ProcessReader((script) => { const helper = sharedWindowsHelper(); return helper ? helper.run(script).completed.then((r) => r.stdout) : Promise.reject(new Error('no helper')); });
    // prism-harness 0.10.3's lock identity (a CIM query on Windows), read ASYNCHRONOUSLY and started now; awaited below,
    // before the session host takes work, so no thread write ever pays for it. A failed read follows the SDK's own retry.
    const lockIdentity = warmLockIdentity().catch((error: unknown) => { lifecycleLog(`lock identity unread: ${error instanceof Error ? error.message : String(error)}`); });
    const spawnLedger = SpawnLedger.open(join(runtime, 'children.json'), randomUUID());
    spawnLedger.sweep(systemProcessTree, lifecycleLog);
    // prism-acp's supervisor (a Job Object on Windows) before any agent starts: a provider is never run uncontained.
    const supervisor = await prepareGenieSupervisor().catch((error: unknown) => {
        const why = supervisorFailureWords(error) ?? (error instanceof Error ? error.message : String(error));
        lifecycleLog(`containment unready reason=${why}`);
        say(`agents cannot start contained: ${why}`);
        return null;
    });
    // What other supervisor sources left beside it is removed off the start path — never what a running process uses.
    if (supervisor !== null) {
        void removeStaleSupervisorBuilds(runtime, { runningImages: supervisorImagesRunning }).then(
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
    // AgentInbox's automatic reply to a paused recipient (genie#1515) reads this host's live sessions: bound once they exist.
    let sessionsForInbox: SessionHost | null = null;
    // THE SETTINGS AND THE CHAT DRAFTS (P3.2): one file each, one writer — this host. Every window a replica; hot-swap kept.
    // Opened before the stores: attention keeps as much finished history as they say (Tynn #549).
    const settings = await SettingsStore.open(home);
    const own = await openAgentStores(home, () => new Date().toISOString(), (id) => sessionsForInbox?.probe(id) ?? null, () => attentionLimitsFrom(settings.snapshot()));
    const drafts = await ChatDraftStore.open(home);
    // THE REGISTRY'S FILES (P3.2): this host writes them (windows through it) and reads them for its own tools and approvals.
    const registryStore = new Store(home);
    // What a quit or an upgrade recorded is KEPT in safe mode (never taken), and listed on the banner with its own Start.
    if (safeMode.active()) void Promise.all([registryStore.readRunningAtQuit(), registryStore.readInterruptedAtQuit()]).then(([running, interrupted]) => safeMode.wasRunning([...running, ...interrupted]), () => {});
    const hostRegistry = new HostRegistry(registryStore);
    await hostRegistry.refresh();
    const hiddenWorkspaces = () => hostRegistry.workspaceStates().filter((w) => w.asleep === true).map((w) => w.id);
    own.knowledge.setHiddenWorkspaces(hiddenWorkspaces);
    own.inbox.setVisibility((message) => hostRegistry.mailParticipantVisible(message.from) && hostRegistry.mailParticipantVisible(message.to), () => hostRegistry.mailVisibilityVersion());
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
    /**
     * The `supervised` child's link: up once it is ready and reconciled, down when it exits (or while it never came up).
     * Streams started there wait for it, and while it is down Hosting says the engines' live status is paused.
     */
    const supervisedLink = new LinkGate();
    const supervisedStream = supervisedLink.stream(supervisedClient.stream);
    /*
     * GENIE'S HOSTING (the host split, P5a): the front door, the service engines and the site routes are built HERE, under
     * this host's supervisor, so sites stay served and routed with the UI closed; windows read and drive them through the
     * service. This host never raises an OS prompt itself: an elevation is asked of a connected window, and with none it
     * waits (WindowElevation) and the next window is told.
     */
    const hostingElevation = new WindowElevation({
        connected: () => engineRef?.localWindowConnected() ?? false,
        ask: (steps) => (engineRef ? engineRef.elevate(steps) : Promise.reject(new Error('no Genie window is connected'))),
        elevation: capabilities.elevation,
    });
    /*
     * THE APP DOOR (genie#1345; P5a.2 ruling 3): the door apps and scripts post through, and its keys — one writer of
     * app-inbox.json — run HERE, so every site's and kept process's credential is minted here, with or without a window,
     * and the door that accepts it is up as long as the host is. Before the hosting: a site started at boot gets one.
     */
    let hostingNow: HostingStack | null = null;
    const appInboxDoor = await AppInboxHost.start({
        home,
        inbox: own.inbox,
        roster: () => hostRegistry.listAgents(),
        slugs: () => hostRegistry.workspaceSlugs(),
        defaultAgentOf: (workspaceId) => hostRegistry.defaultAgentOf(workspaceId),
        refusalForRecipient: (text, workspaceId) => hostRegistry.mailRefusal(text, workspaceId),
        enabled: (workspaceId) => settings.snapshotFor(workspaceId).app_inbox !== false,
        siteHosts: (workspaceId) => hostingNow?.sites.list(workspaceId).map((s) => s.host) ?? [],
        workspaces: () => hostRegistry.listWorkspaces().map((w) => w.id),
        log: (line) => { say(line); lifecycleLog(line); },
    });
    const workspacesListeners = new Set<() => void>();
    stores.onEvent((event) => {
        if (event.store !== 'registry') return;
        void stores.registrySettled().then(() => { for (const l of [...workspacesListeners]) l(); });
    });
    let hosting: HostingStack | null = null;
    /** GApps v2 V4: the server of installed apps, once the book is open; the front door asks it for their routes. */
    let gappServer: GAppServer | null = null;
    const gappRouteListeners = new Set<() => void>();
    /** Genie Mail G5: the process book, once open, whose running processes restart with new mail credentials. */
    let mailProcessBook: ProcessBook | null = null;
    /** The running agents compared with their workspace's verdict (genie#1519): bound once the sessions exist. */
    let hostVerdicts: TrustVerdicts | null = null;
    try {
        hosting = await composeHosting({
            gappRoutes: () => gappServer?.routes() ?? [],
            onGappRoutesChange: (listener) => { gappRouteListeners.add(listener); },
            // THE HOST OWNS TRUST (genie#1519): the record and the verdicts are this host's, beside the sites that read them.
            onTrustVerdict: (workspaceId) => hostVerdicts?.changed(workspaceId),
            ...(await hostHostingOptions(hostMachinePaths(process.env, home), say)),
            // ONE OWNER FOR EVERY PROCESS THE HOST STARTS: `docker events` runs under this host's `supervised` spawn-host
            // child, which ends its streams when this host dies however it dies (spawn-host.ts). Started by the host itself,
            // it was orphaned on Linux by a killed host (P5a.3's probe). It waits for the child's link at boot.
            dockerEvents: (args, onLine, onEnd) => supervisedStream('docker', args, onLine, onEnd),
            liveStatusLink: supervisedLink,
            userData: home,
            supervisor: processSupervisor,
            settings,
            // Genie Mail G5: the workspaces' default inbox passwords live in the host keychain, for env injection only.
            mailSecrets: {
                get: async (name) => { const read = await keychain.get(name); return read.kind === 'value' ? read.value : null; },
                set: async (name, value) => (await keychain.set(name, value)).ok,
            },
            // Before Mailpit reads the book, every running process of a workspace getting credentials restarts with them.
            // None open yet: none is running, and each reads the credentials as it starts.
            restartWorkspaceProcesses: async (workspaceIds) => {
                const book = mailProcessBook;
                if (!book) return { ok: true };
                const r = await book.restartRunning(workspaceIds);
                return r.failed.length === 0 ? { ok: true } : { ok: false, reason: r.failed.map((f) => `${f.name}: ${f.reason}`).join('; ') };
            },
            appEnv: (source) => appInboxDoor.envFor(source),
            elevate: (steps) => hostingElevation.run(steps),
            workspaces: () => hostRegistry.workspaceStates(),
            // Safe mode: no site and no stopped engine starts by itself; the held sites go on the banner.
            safeMode: safeNow,
            heldSite: (siteId, name) => safeMode.hold('site', { id: siteId, name }),
            onWorkspacesChange: (listener) => { workspacesListeners.add(listener); return () => { workspacesListeners.delete(listener); }; },
        });
    } catch (error) {
        say(`Genie's hosting could not start in the host: ${error instanceof Error ? error.message : String(error)}`);
    }
    const hostingStack = hosting;
    hostingNow = hostingStack;
    // No hosting, no trust record: git in this host checks every folder's config first, as in a workspace not trusted.
    if (!hostingStack) setGitReadPolicy(trustAwarePolicy(() => false));
    /** The verdict as last read, without reading. A workspace not read yet, or a host with no hosting, is not trusted. */
    const hostUntrustedNow = (record: { readonly workspaceId: string }): boolean => {
        if (!hostRegistry.workspace(record.workspaceId)) return false;
        return hostingStack?.trust.view(record.workspaceId)?.trusted !== true;
    };
    /** A registered workspace's folder takes Genie's files only once trusted; with no hosting, none is. */
    const hostMayWriteInto = (folder: string): Promise<boolean> => (hostingStack
        ? hostingStack.trust.mayWriteInto(folder)
        : Promise.resolve(!hostRegistry.workspaceStates().some((w) => w.path === folder)));
    const hostingService = hostingStack ? new HostingService(hostingStack, {
        workspaces: () => hostRegistry.listWorkspaces().map((w) => w.id),
        registeredFolders: () => hostRegistry.workspaceStates().map((w) => w.path),
        elevation: hostingElevation,
        // An engine's dependents name the running processes; the workspaces are the registry's.
        onChange: (listener) => {
            const off = processSupervisor.onChange(() => listener());
            workspacesListeners.add(listener);
            return () => { off(); workspacesListeners.delete(listener); };
        },
    }) : null;
    /*
     * THE TERMINALS (P3.3e): the `terminals` spawn-host child is this host's own now — its shells (and their scrollback)
     * outlive the window, and an agent's `manageTerminals` works with none. Windows drive them through the service.
     */
    const terminalsClient = new SpawnHostClient({ entry: '', link: { send: (frame) => relay?.send('terminals', frame) }, log: lifecycleLog });
    const terminalHost = new TerminalHost(terminalsClient.ptyPort(), { terminals: (workspaceId) => limitOf(settings.snapshotFor(workspaceId), 'terminals') });
    const terminalsService = new TerminalsService(terminalHost);
    // TAKE OVER'S ONE OWNER (Tynn #553, P5d.5c): who has a TUI open. This host opens no window; whoever clicked opens its own.
    const takeOverHost = new TakeOverHost({
        terminals: terminalHost,
        openWindow: () => {},
        mcp: () => { const e = mcp?.endpoint() ?? null; return e ? { mcpUrl: e.url, token: e.token } : null; },
    });
    const takeOverService = new TakeOverService({
        host: takeOverHost,
        find: (id) => hostRegistry.find(id),
        workspacePath: (record) => hostRegistry.workspace(record.workspaceId)?.path ?? null,
        tuiFor: (record) => providerBinary(record.provider) ?? record.provider,
        onChange: (view) => engineRef?.takeOverEvent(view),
    });
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
    const gappCallers = new GAppCallers((id) => hostRegistry.workspace(id)?.path ?? null);
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
    /** This host's Tynn account once open (Tynn #552): a relay connection asks it synchronously whether it is signed in. */
    let tynnAccountNow: TynnAccount | null = null;
    void tynnOpening.then((account) => { tynnAccountNow = account; }, () => {});
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
    /*
     * ISSUEWATCH AND THE LIVE BOARD (the host split, P5c; issue-watch-host.ts): Tynn's pushes are heard HERE, on this host's
     * account, so a GitHub change reaches the linked workspace's agents with no window open, through this host's one wake
     * (host-mail-wake.ts). Local windows read the state and play the sounds; their board views are followed per view.
     * One way to dial Tynn's socket server, with the Origin of the Tynn this account is for (tynn-socket.ts, genie#1478).
     */
    const tynnSocket = (url: string): SocketLike => dialTynnSocket(url, hostTynn?.host() ?? TYNN_HOST);
    const tynnTimer = (fn: () => void, ms: number): (() => void) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); };
    /** A workspace's Tynn project, by its project.json `tynn.projectId`; null = not linked. */
    const tynnProjectOf = (path: string): string | null => {
        let manifest: string | null = null;
        try { manifest = readFileSync(join(path, 'project.json'), 'utf8'); } catch { manifest = null; }
        return tynnProjectIdOf(manifest);
    };
    const workspaceTynnProject = (workspaceId: string): string | null => {
        const workspace = hostRegistry.workspace(workspaceId);
        return workspace ? tynnProjectOf(workspace.path) : null;
    };
    const issueWatch = new IssueWatchService({
        tynn: () => hostTynn,
        socket: tynnSocket,
        schedule: tynnTimer,
        projectFor: workspaceTynnProject,
        delivery: {
            agents: () => hostRegistry.listAgents(),
            defaultAgentOf: (workspaceId) => hostRegistry.defaultAgentOf(workspaceId),
            workspaceFor: (projectId) => {
                for (const w of hostRegistry.listWorkspaces()) if (tynnProjectOf(w.path) === projectId) return { id: w.id, name: workspaceNameFor(w.path) };
                return null;
            },
        },
        log: say,
    });
    const tynnBoard = new TynnBoardHub({
        tynn: () => hostTynn,
        socket: tynnSocket,
        schedule: tynnTimer,
        projectFor: workspaceTynnProject,
        send: (owner, event) => { engineRef?.tynnBoardEvent(owner, event); },
        log: say,
    });
    const tynnIssues = new TynnBoardHub({
        tynn: () => hostTynn,
        socket: tynnSocket,
        schedule: tynnTimer,
        projectFor: workspaceTynnProject,
        feed: TYNN_ISSUES_FEED,
        send: (owner, event) => { engineRef?.tynnIssuesEvent(owner, event); },
        log: say,
    });
    // The Features page (row F1) follows its own channel, as the Issues queue does.
    const tynnFeatures = new TynnBoardHub({
        tynn: () => hostTynn,
        socket: tynnSocket,
        schedule: tynnTimer,
        projectFor: workspaceTynnProject,
        feed: TYNN_FEATURES_FEED,
        send: (owner, event) => { engineRef?.tynnFeaturesEvent(owner, event); },
        log: say,
    });
    // Signing in or out of Tynn, or pointing at another one, starts it over with what is set now; and once the account opens.
    void tynnOpening.then((account) => {
        account.onChange(() => { issueWatch.restart(); });
        issueWatch.restart();
    }, () => { issueWatch.start(); });
    // THE HOST PREPARES ITS AGENTS (P3.4 cut c), with a window open or not. A start waits for the account: opening has its own deadline.
    // One writer of a workspace's agent config: preparing an agent and syncing hold the same lock.
    const withConfig = configWriter();
    const agentKeys = hostAgentKeys({
        withConfig,
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
    let windowsLinked = 0;
    /** Thread ids heard while no window may be there to record them: a restart resumes this conversation. */
    const threadsHeard = new Map<string, string>();
    /*
     * GENIE'S OWN PROCESSES ARE NOT CREATED ON THIS HOST'S THREAD (Tynn #535): the Genie browser's start held this host 238 ms
     * on the Linux runner, and the updater's is started here too (Windows creates a process synchronously on the calling
     * thread). The supervised spawn-host child creates them, detached, while it is up; between its lives, here, as before.
     */
    const startOwnDetached = (what: string, launch: { readonly file: string; readonly args: readonly string[] }, env: NodeJS.ProcessEnv, logName: string, hide: boolean, here: () => void): void => {
        if (!supervisedLink.up()) { here(); return; }
        const vars = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
        supervisedClient.spawnDetached(launch.file, launch.args, vars, join(home, 'logs', logName), hide).catch((error: unknown) => {
            lifecycleLog(`${what}: its spawn host could not start it (${error instanceof Error ? error.message : String(error)}); starting it here`);
            here();
        });
    };
    const browserService = new BrowserService({ ...(capabilities.browser ? {} : { unavailable: NO_BROWSER_HERE }), startBrowser: (launch) => {
        const here = () => { spawnBrowserProcess(launch, { logsDir: join(home, 'logs'), env: process.env }); };
        startOwnDetached('genie browser', launch, process.env, 'genie-browser.log', false, here);
    } });
    // A keyring unlocked while the Genie browser runs (Tynn story #388): that browser is restarted to use it, and the SCREEN says so.
    const keyringNotices: Array<(text: string | null) => void> = [];
    void keychainOpening.then(({ keyring }) => {
        if (!keyring) return;
        restartBrowserOnUnlock({
            keyring,
            browser: {
                restartForKeyring: () => browserService.restartForKeyring(),
                onDown: (l) => browserService.onEvent((e) => { if (e.kind === 'browserUp' && !e.up) l(); }),
            },
            notice: (text) => { for (const n of keyringNotices) n(text); },
            log: (line) => { say(line); lifecycleLog(line); },
        });
    }, () => {});
    /** What this host supervises, stopped once — by an update's install (in its order) or by the shutdown, whichever is first. */
    let hostedStop: Promise<void> | null = null;
    const stopHostedOnce = (): Promise<void> => {
        hostedStop ??= shutDownHosted({
            supervisor: processSupervisor,
            hosting: hostingStack,
            endChildren: async () => { await relay?.stop(); },
            schedulers: clocks,
            log: (line) => { say(line); lifecycleLog(line); },
        });
        return hostedStop;
    };
    /*
     * THE UPDATER (the host split, P5b; updates-host.ts): its state, its schedule and the install are this host's, window or
     * no window. electron-updater needs Electron's `app`, which this process has not: Genie's own executable in its
     * `--updater` mode makes the library's calls, started here, detached, when one is needed, with this host's environment
     * (the window's, so an AppImage's `APPIMAGE` reaches it). An install is a person's, from a window; never by itself.
     */
    const runningVersion = build.split('+')[0] ?? build;
    const updatesService = new UpdatesService({
        ...(capabilities.window ? {} : { unavailable: NO_UPDATES_HERE }),
        host: {
            installDir: dirname(process.execPath),
            ownPid: process.pid,
            processes: listProcessesAsync,
            kill: killProcessAsync,
            channel: channelFrom(settings.snapshot().update_channel),
            runningVersion,
            releases: async () => {
                const memory = await proxyMemory;
                const send = hostHttpsFetch({ proxyRoutes: (url) => memory.routesFor(url), log: say });
                const res = await send('https://api.github.com/repos/Renaissance-Analytics/genie/releases?per_page=100', { method: 'GET', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Genie' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000) });
                if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
                return JSON.parse(await res.text()) as ReleaseLike[];
            },
            // §7.4: every session ends with the upgrade, who comes back recorded on disk first; the next launch restores them once.
            agents: hostDrainAgents({
                agents: () => hostRegistry.listAgents(),
                probe: (id) => host.probe(id as AgentId),
                writeRunningAtQuit: (ids) => registryStore.writeRunningAtQuit(ids),
                writeInterruptedAtQuit: (ids) => registryStore.writeInterruptedAtQuit(ids),
                stopAll: async (onLeft) => { await host.stopAll(onLeft); await host.drained(2_000).catch(() => undefined); },
                onRecordError: (error) => { const line = `update: the agents to start again could not be recorded: ${error instanceof Error ? error.message : String(error)}`; say(line); lifecycleLog(line); },
            }),
            // P5a.3's order: the browser told to end, then sites, the front door and kept processes stopped; containers stay up.
            stopHosted: async () => { browserService.quit(); await stopHostedOnce(); },
        },
        startHelper: (launch) => { startOwnDetached('updater', helperLaunch(launch), updaterHelperEnv(process.env, home), 'genie-updater.log', true, () => { spawnUpdaterProcess(helperLaunch(launch), { logsDir: join(home, 'logs'), env: updaterHelperEnv(process.env, home) }); }); },
        defaultLaunch: updaterDefaultLaunch(process.env, process.execPath),
        windowConnected: () => engineRef?.windowConnected() ?? false,
        exit: () => { void shutdown('an update is installing'); },
        log: (line) => { say(line); lifecycleLog(line); },
        // A failed install's reason, for the first window after it, once.
        failed: readUpdateFailed(home),
        clearFailed: () => { clearUpdateFailed(home); },
        // The helper went after the drain: why recorded, and Genie started again from the window's launch.
        handOverFailed: (reason, launch) => {
            writeUpdateFailed(home, { at: Date.now(), reason, log: join(home, 'logs', 'genie-host.log') });
            spawnGenieWindow(relaunchSpec(launch, process.env), process.env);
        },
    });
    settings.onChange((key, value, workspaceId) => { if (key === 'update_channel' && workspaceId === undefined) updatesService.setChannel(channelFrom(value)); });
    updatesService.onEvent(() => { lastBusy = Date.now(); });
    // WHERE A SLOW ANSWER WAITS (genie-test-windows, job Q0): the window's watchdog, on the host's own loop and on every call
    // a window makes. Its lines go to the shared lifecycle log marked as the host's. No stack profiler here: its own start
    // cost seconds on that machine (stall-profile.ts).
    const hostWatchdog = new StallWatchdog({ log: (line) => lifecycleLog(`host ${line}`), routeOf: () => null });
    hostWatchdog.start();
    /*
     * THE HANG WATCHDOG (Tynn #386: hang-watchdog.ts). Window main beats here every second; 30 s of silence from a window
     * still connected is a HANG: a record in runtime/crash (the last lifecycle lines, main's stalls, the RSS samples, the
     * running agents with their current turn's last tool name and size, no content), then the frozen window's process is
     * ended (one pid, never a tree: this host and its agents keep running). RSS for both every 60 s in lifecycle.log, and a
     * window that drops with no goodbye and is gone is recorded as LOST.
     */
    let hostForNotes: SessionHost | null = null;
    const hangWatchdog = new HangWatchdog({
        write: (record) => { writeCrashRecord(join(runtime, 'crash'), record); crashState.recorded(record); },
        kill: (pid) => killProcessAsync(pid),
        // The new window after the ended one has let go of its process and sockets (Tynn #400), bounded at 10 s.
        released: (pid) => windowReleased(pid, { alive: pidAlive, sockets: tcpSocketsOwnedByAsync }),
        alive: pidAlive,
        hostRss: () => process.memoryUsage.rss(),
        cpuMs: () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; },
        agents: () => {
            const running = hostForNotes;
            if (running === null) return [];
            return running.startedIds().map((id) => runningAgentNote(hostRegistry.find(id)?.name ?? id, running.rowsFor(id)));
        },
        lifecycle: () => readLifecycleTail(runtime),
        log: lifecycleLog,
        header: () => crashHeader(build.split('+')[0] ?? build, build),
        // AFTER A HANG, A NEW WINDOW (#1623 review): the installed Genie from the window's published launch, as a failed
        // install's relaunch does — the tray lives in the window's process, so Genie is never silently gone. Capped in the
        // watchdog: a 4th hang within 10 minutes is recorded, not reopened. A host with no window (genie-cloud) starts none.
        ...(capabilities.window ? { relaunch: () => { spawnGenieWindow(relaunchSpec(updatesService.launchSpec(), process.env), process.env); } } : {}),
        onHang: (hang) => { crashState.hung({ at: hang.at, hangs: hang.hangs, agents: (hostForNotes?.startedIds() ?? []).map((id) => ({ id, name: hostRegistry.find(id)?.name ?? id })) }); },
    });
    hangWatchdog.start();
    /*
     * THE PLUGINS (ADF A3, Tynn #447): this host's, beside the rest of Genie's state; signed by default, unsigned only
     * under developer mode (the host's own setting). Its MCP server offers and runs their tools with no window; every
     * window reads them through its replica (plugins.event) and asks this host to change them (engine.plugins).
     */
    let marketplaceTransport: ReturnType<typeof hostHttpsFetch> | undefined;
    const marketplacePlugins = await openMarketplacePlugins({
        pluginsDir: join(home, 'plugins'), cacheFile: join(home, 'marketplace-publisher-keys.json'), origin: TYNN_HOST,
        keys: PUBLISHER_KEYS, publisherChecksOff: () => settings.snapshot().publisher_checks_off === true,
        fetch: async (url, init) => {
            const memory = await proxyMemory;
            marketplaceTransport ??= hostHttpsFetch({ proxyRoutes: target => memory.routesFor(target), log: say, maxResponseBytes: MARKETPLACE_PAGE_BYTES });
            return marketplaceTransport(url, init);
        }, log: say,
    });
    const pluginsService = marketplacePlugins.plugins;
    let marketplaceArchiveTransport: ReturnType<typeof hostHttpsFetch> | undefined;
    const marketplaceHost = await MarketplaceHost.open({
        pluginsDir: join(home, 'plugins'), stagingDir: join(home, 'marketplace-staging'), grantsFile: join(home, 'marketplace-grants.json'),
        registry: marketplacePlugins.registry, plugins: pluginsService, origin: TYNN_HOST, log: say,
        fetch: async (url, init) => {
            const memory = await proxyMemory;
            marketplaceArchiveTransport ??= hostHttpsFetch({ proxyRoutes: target => memory.routesFor(target), log: say, streamResponse: true, maxResponseBytes: MARKETPLACE_ARCHIVE_BYTES });
            return marketplaceArchiveTransport(url, init);
        },
    }).catch((error: unknown) => { say(`Marketplace is unavailable: ${error instanceof Error ? error.message : String(error)}`); return undefined; });
    /*
     * THE CATALOG (ADF A4, Tynn #448): Genie's own elements and every ENABLED installed plugin's, revisioned. Built again
     * whenever the plugins change; every window follows it over the engine connection (catalog.snapshot, catalog.changed).
     */
    /*
     * THE GAPP BOOK (GApps v2, V3, Tynn #568): installed apps, their grants and storage, under <home>/gapps. Its installed,
     * turned-on apps are in the catalog beside the plugins'; a change rebuilds it.
     */
    let gappBook: GAppBook | null = null;
    const catalogService = new CatalogService(() => hostCatalog(pluginsService.plugins(), gappBook ?? undefined));
    pluginsService.onEvent(() => catalogService.rebuild());
    // A package installed, updated, disabled or removed reaches agents now, not at the next restart (ADF A6).
    catalogService.onEvent(() => mcp?.refreshTools());
    // The flow palette's door and the runner here offer what the catalog holds, as it changes (ADF A5).
    setOfferedFlowKinds(catalogFlowKinds(catalogService.snapshot().definitions));
    catalogService.onEvent(() => setOfferedFlowKinds(catalogFlowKinds(catalogService.snapshot().definitions)));
    try {
        gappBook = await GAppBook.open({
            dir: join(home, 'gapps'), keys: PUBLISHER_KEYS, publisherChecksOff: () => settings.snapshot().publisher_checks_off === true,
            catalog: () => hostCatalog(pluginsService.plugins(), gappBook ?? undefined),
        });
        gappBook.onChange(() => catalogService.rebuild());
        catalogService.rebuild();
        // GApps v2 V4: installed apps at their own origins, behind the front door.
        const gappBridge = new GAppBridge({
            book: gappBook,
            catalog: (id) => catalogService.snapshot().definitions.find((d) => d.id === id) ?? null,
            run: createGAppToolRunner({ registrations: () => mcp?.registrations() ?? [], callers: gappCallers }),
            onCatalogChange: (listener) => catalogService.onEvent((change) => listener(change.revision)),
        });
        gappServer = new GAppServer({ book: gappBook, bridge: gappBridge });
        await gappServer.listen(0);
        gappBook.onChange(() => { for (const listener of gappRouteListeners) listener(); });
        for (const listener of gappRouteListeners) listener();
    } catch (error) {
        say(`The GApp book could not open: ${error instanceof Error ? error.message : String(error)}`);
    }
    /*
     * REMOTE ACCESS'S HOST SIDE (Tynn #409, host split P5d.1): the tailnet listener, the remote host, the paired devices,
     * the PIN, the pair prompts, the baton and the lock are HERE, so a paired phone reaches this machine with every window
     * closed. The window's relay host (until P5d.3) bridges each relay connection it admits into this same remote host: one
     * baton, one lock. What this host owns is answered here; the rest by the newest local window, or refused with what to do.
     */
    const remoteWindowEvents = new Set<(channel: string, payload: unknown) => void>();
    const remoteListen = remoteListener({
        tailscale: () => execFileText(resolveProgram('tailscale'), ['status', '--json'], { timeoutMs: 15_000 }),
        port: REMOTE_PORT,
        attach: attachWebSocketServer,
        // The phone's page (§6.8): the built renderer, beside this host's own bundle, as the window serves it.
        serve: staticServer(join(dirname(fileURLToPath(import.meta.url)), '../renderer'), { hostName: () => hostname() }),
        // HTTPS on the MagicDNS name (a Tailscale cert, renewed each start), else http inside WireGuard: as the window did.
        cert: async (dnsName) => {
            const dir = join(runtime, 'mobile-tls');
            const certFile = join(dir, 'cert.pem');
            const keyFile = join(dir, 'key.pem');
            try {
                await mkdir(dir, { recursive: true });
                await execFileText(resolveProgram('tailscale'), ['cert', '--cert-file', certFile, '--key-file', keyFile, dnsName], { timeoutMs: 60_000 });
                await chmod(keyFile, 0o600).catch(() => {});
                return { cert: await readFileText(certFile, 'utf8'), key: await readFileText(keyFile, 'utf8') };
            } catch (error) {
                say(`remote: no Tailscale cert for ${dnsName}, serving http inside the tailnet: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        },
    });
    const remoteHub = transportHub(remoteListen.transport);
    // THIS MACHINE'S KEY IS HERE (P3.4), and the relay that signs with it (Tynn #410).
    const workstationService = new WorkstationService({
        store: workstationKeyStore(join(home, 'workstation.json'), keychain),
        request: async (path, init) => (await tynnOpening).request(path, init),
        host: () => TYNN_HOST,
        hostname,
        machineKey: () => readMachineId({
            platform: process.platform,
            readFile: (path) => readFileText(path, 'utf8'),
            exec: (command, args) => execFileText(command, [...args], { timeoutMs: 10_000 }),
        }).then((id) => (id ? machineKeyOf(id) : null)),
    });
    /*
     * THIS MACHINE ON THE TYNN RELAY, AS A HOST (Tynn #410, host split P5d.3): registered with Tynn, its role read, and the
     * link run here, so a Pilot or a share link reaches this machine with every window closed.
     */
    const relayFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        const memory = await proxyMemory;
        return hostHttpsFetch({ proxyRoutes: (target) => memory.routesFor(target), log: say })(url, init as never) as unknown as Response;
    };
    const relayHostService: RelayHostService = new RelayHostService({
        account: () => tynnAccountNow,
        workstation: workstationService,
        enabled: () => settings.snapshot().remote_access === true,
        readRole: (request) => readWorkstationRole(request),
        start: ({ host, workstationId, fingerprint, onStatus }) => startRelayHost({
            ports: relayHostPorts({ tynnHost: host, workstationId, authHeader: () => workstationService.authHeader(host), fetch: relayFetch }),
            socket: (url) => deviceSocket(url),
            workstationId,
            fingerprint,
            sign: (data) => workstationService.sign(host, data),
            attach: (transport) => remoteHub.add(transport),
            onStatus,
            log: (message) => say(`tynn relay: ${message}`),
            ...(hostingStack ? { site: { dial: (name: string) => dialFrontDoor(hostingStack.frontDoorPort, name), ca: () => hostingStack.browserTrust().caPem } } : {}),
        }),
        onChange: () => engineRef?.relayHostEvent(relayHostService.status()),
    });
    void tynnOpening.then((account) => {
        account.onChange(() => { void relayHostService.register(); });
        void relayHostService.register();
    }, () => {});
    setInterval(() => { void relayHostService.readRole(); }, 5 * 60_000).unref();
    /** genie-host's own answers to a phone (Tynn #551): built once its session host is up, below. */
    let phoneApi: HostApi | null = null;
    const remoteAccessHost = await RemoteAccessHost.open({
        home,
        hostName: hostname(),
        transport: remoteHub,
        build,
        api: hostRemoteApi({
            hostName: hostname(),
            // What this host answers itself, window or not. The phone's set comes here next (Tynn #551).
            own: { 'updates.state': async () => updatesService.dump(), takeOver: async (args) => takeOverService.start(args[0]) },
            takeOverEnded: (terminalId) => takeOverService.ended(terminalId),
            window: {
                connected: () => (engineRef?.newestLocalWindow() ?? null) !== null,
                invoke: (method, args, context) => (engineRef ? engineRef.remoteInvoke(method, args, context) : Promise.reject(new Error('no Genie window is connected'))),
            },
            onEvent: (listener) => { remoteWindowEvents.add(listener); return () => { remoteWindowEvents.delete(listener); }; },
            // The phone's methods and events with every window closed (host-alone-api.ts).
            alone: () => phoneApi,
            workspaceOfAgent: (agentId) => hostRegistry.listAgents().find((a) => a.id === agentId)?.workspaceId ?? null,
        }),
    });
    // OFF BY DEFAULT (Tynn #820): the listener runs only while `remote_access` is on, applied at boot and on every change.
    let remoteAccessService: RemoteAccessService | null = null;
    const remoteSwitch = remoteAccess({ listener: remoteListen, enabled: () => settings.snapshot().remote_access === true, onChange: () => { remoteAccessService?.pushStatus(); void relayHostService.apply(); } });
    remoteAccessService = new RemoteAccessService(remoteAccessHost, {
        switch: { ...remoteSwitch, stop: () => remoteListen.stop() },
        newestWindow: () => engineRef?.newestLocalWindow() ?? null,
        windowEvent: (channel, payload) => { for (const l of [...remoteWindowEvents]) l(channel, payload); },
        send: (owner, event) => engineRef?.remoteAccessEvent(owner, event),
    });
    settings.onChange((key, _value, workspaceId) => { if (key === 'remote_access' && workspaceId === undefined) void remoteSwitch.apply().catch((error: unknown) => say(`remote: ${error instanceof Error ? error.message : String(error)}`)); });
    const engine = new SessionEngineServer({
        token,
        build,
        pid: process.pid,
        timeCall: (method) => hostWatchdog.ipc(method),
        log: say,
        onShutdown: () => void shutdown('a window asked'),
        heartbeat: hangWatchdog,
        crash: crashState,
        // Every window shows the banner, and may leave it (safe-mode-host.ts).
        safeMode,
        onClients: (n) => {
            lastBusy = Date.now();
            say(`windows connected: ${n}`);
            // A window linking is a good moment to ask Tynn again, for an agent still waiting on it.
            if (n > windowsLinked) tynnRecovery?.nudge();
            windowsLinked = n;
        },
        // A window reaches its own profiles only: `supervised` is this host's supervisor's, and no window sends into it.
        // A window reaches the `processes` child only: `supervised` and `terminals` are this host's own (P3.3b, P3.3e).
        spawn: { send: (profile, frame) => { if (profile === 'processes') relay?.send('processes', frame); }, windowGone: () => relay?.windowGone() },
        terminals: terminalsService,
        supervisor: supervisorService,
        ...(hostingService ? { hosting: hostingService } : {}),
        appInbox: appInboxDoor,
        processes: processesService,
        plugins: pluginsService,
        marketplace: marketplaceHost,
        ...(gappBook ? { gapps: gappsApi(gappBook) } : {}),
        catalog: catalogService,
        flows: flowsService,
        browser: browserService,
        updates: updatesService,
        remoteAccess: remoteAccessService,
        stores,
        keychain,
        // THE TYNN ACCOUNT (P3.4 cut c). Opening asks Tynn who it is, so it is not awaited here: the host's boot does not wait on the network.
        tynn: new TynnAccountService(tynnOpening, { host: TYNN_HOST, recovery: async (asked) => { await tynnRecovery?.recover(asked); return []; } }),
        github: new GithubAccountService(githubOpening),
        // THIS MACHINE'S KEY IS HERE (P3.4). The relay is the window's until P5, so it asks this to sign.
        // Nothing of Genie's goes into a folder the person has not trusted (genie#1519), whichever window asked.
        configSync: async (asked) => ((await hostMayWriteInto(asked.workspacePath)) ? withConfig(asked.workspacePath, () => writeWorkspaceConfig(asked)) : []),
        // Other machines: the host dials them, and holds the tokens that open them (P3.4 cut e).
        deviceLink: new DeviceLinkService({
            tokens: deviceTokenStore(join(runtime, 'device-hosts.json'), keychain),
            socket: (url) => deviceSocket(url),
            send: (owner, event) => engine.deviceEvent(owner, event),
            log: say,
            /*
             * A PILOT'S CONNECTION TO ANOTHER TYNN WORKSTATION (Tynn #552, host split P5d.4; audit M-e): the grant is minted
             * here with this host's Tynn account, the proof key made and kept here, the relay member opened and renewed
             * here; the window gets a channel. The browser's door to that workstation's sites is here too.
             */
            relay: {
                signedIn: () => tynnAccountNow?.status().signedIn === true,
                refusal: () => droneRefusal(relayHostService.role()),
                keypair: () => PopKeypair.generate(),
                mint: (workstationId, jwk) => (tynnAccountNow
                    ? mintConnectGrant((path, init) => tynnAccountNow!.request(path, init), workstationId, jwk)
                    : Promise.resolve({ ok: false as const, reason: 'sign in to Tynn to connect to a Tynn workstation' })),
                // Through the one socket this host dials with (device-socket.ts): the machine's roots, no redirects.
                open: (input) => openRelayMember({ socket: (url) => deviceSocket(url), ...input }),
            },
            browsers: new RemoteBrowsers(siteDoor),
        }),
        workstation: workstationService,
        relayHost: relayHostService,
        takeOver: takeOverService,
        // THE KEYRING CARD READS THIS HOST (P3.4 cut c). When the keychain comes to answer, what reads secrets reads again, with nobody restarting anything.
        keyring: ((service: KeyringService) => { keyringNotices.push((text) => service.setNotice(text)); return service; })(new KeyringService(keychainOpening.then((opened) => opened.keyring, () => null), {
            onReady: () => {
                void tynnOpening.then((account) => account.reload()).catch(() => {});
                void githubOpening.then((account) => account.reload()).catch(() => {});
                void tynnRecovery?.recover({ secretsMoved: true });
            },
        })),
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
        issueWatch,
        tynnBoard,
        tynnIssues,
        tynnFeatures,
        tynnPages: {
            read: async (workspaceId, page, query) => {
                // Opening has its own deadline; never mistake a pairing still opening for a signed-out owner.
                const account = await tynnOpening;
                return readTynnPage({
                    signedIn: () => account.status().signedIn === true,
                    projectFor: workspaceTynnProject,
                    request: (path, init) => account.request(path, init),
                }, workspaceId, page, query);
            },
        },
        files: {
            subscribe: (owner, viewId, workspace, want) => files?.subscribe(owner, viewId, workspace, want),
            unsubscribe: (owner, viewId) => files?.unsubscribe(owner, viewId),
            dropOwner: (owner) => files?.dropOwner(owner),
        },
    });
    engineRef = engine;
    // The watch runs on a thread of its own (Tynn #524): a build's thousands of changes never hold this host's loop.
    files = new FilesWatchHub({ source: workerWatchSource({ log: say }), send: (owner, event) => engine.filesEvent(owner, event), workspaceVisible: (id) => { const w = hostRegistry.workspace(id); return !!w && w.asleep !== true; }, gitTree: gitTreeStatus, repoStatus, log: say });
    stores.onEvent((event) => { if (event.store === 'registry') files?.visibilityChanged(); });
    const engineHostOptions = engine.hostOptions();
    // Every provider's rate limits, kept here whether or not a window is open (core/headroom-board.ts).
    const headroomFeed = new HeadroomFeed(() => headroomBufferMs(settings.snapshot()));
    await lockIdentity;
    const host = new SessionHost({
        userData: home,
        ...engineHostOptions,
        // A WORKSPACE NOT TRUSTED (genie#1519): its agent gets Genie's own words, never the folder's — and with no hosting
        // to read a verdict, no workspace is trusted.
        untrustedFilesFor: async (record) => {
            const workspace = hostRegistry.workspace(record.workspaceId);
            if (!workspace) return null;
            const view = hostingStack ? await hostingStack.trust.refresh(workspace.id).catch(() => null) : null;
            if (view !== null && view.trusted) return null;
            const tools = (mcp?.registrations() ?? []).map((r) => ({ name: r.definition.name, description: r.definition.description ?? '' }));
            return writeGenieInstructions(join(runtime, 'untrusted-agent'), tools, hostTynn?.status().signedIn === true ? 'tynn' : 'files');
        },
        untrustedNow: (record) => hostUntrustedNow(record),
        onThreadId: (agentId, threadId) => { threadsHeard.set(agentId, threadId); engineHostOptions.onThreadId(agentId, threadId); },
        onHeadroom: (provider, room) => { headroomFeed.offer(provider, room); engineHostOptions.onHeadroom(provider, room); },
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
            readingFailed: (agentId, run, pids) => { const line = `reading failed kind=agent owner=${agentId} run=${run} pids=${pids.join(',')}: the machine could not be read after the spawn, twice, so these are recorded with no start time`; say(line); lifecycleLog(line); },
        },
    });
    engine.attach(host);
    hostForNotes = host;
    sessionsForInbox = host;
    /*
     * A WORKSPACE'S VERDICT CHANGES WHILE ITS AGENT RUNS (genie#1519, trust-verdict.ts), compared here, on the host's own
     * sessions. A restart is the graceful one: stop, the old run ended, the same conversation started, what it was owed.
     */
    const trustRestart = async (id: AgentId): Promise<{ ok: true } | { ok: false; reason: string | null }> => {
        const record = hostRegistry.find(id);
        if (!record) return { ok: false, reason: null };
        host.stop(id);
        const verdict = await host.ended(id);
        if (verdict && !verdict.verified && verdict.survivors.length > 0) return { ok: false, reason: `${record.name}'s previous run did not end, so it was not started again: ${verdict.reason}` };
        const started = host.start(record, hostRegistry.workspace(record.workspaceId)?.path ?? osaHome);
        if (!started.ok) return started;
        await host.deliverOwed(id);
        return { ok: true };
    };
    hostVerdicts = new TrustVerdicts({
        agentsOf: (workspaceId) => hostRegistry.listAgents().filter((a) => a.workspaceId === workspaceId).map((a) => a.id),
        untrustedNow: (id) => { const record = hostRegistry.find(id); return record ? hostUntrustedNow(record) : false; },
        launchedUntrusted: (id) => host.launchedUntrusted(id),
        quiet: (id) => host.quiet(id),
        inTurn: (id) => host.inTurn(id),
        workWaiting: (id) => host.workWaiting(id),
        releaseWork: (id) => { host.releaseWork(id); },
        runOf: (id) => host.runOf(id),
        hold: (id, text) => host.holdForNextWork(id, text),
        withdraw: (id) => host.withdrawHeld(id),
        notice: (id, text) => { host.notice(id, text); },
        restart: (id) => trustRestart(id),
    });
    host.subscribe((id) => hostVerdicts?.check(id));
    /*
     * THE PHONE, WITH EVERY WINDOW CLOSED (Tynn #551, host split P5d.2): the same host API a window runs (host-alone-api.ts),
     * over a registry on this host's own registry store, this session host, its attention, inbox and approval stores, and
     * the workspaces' files. The remote host uses it for the phone's methods only while no window is connected.
     */
    // Its writes go the way a window's do (AgentStoresService), so genie-host's own model and every window follow them.
    let githubNow: GithubAccount | null = null;
    void githubOpening.then((account) => { githubNow = account; }, () => {});
    const hostScratch = scratchArea(home);
    const phoneRegistry = new Registry(new HostRegistryStore({ call: (store, method, args) => stores.call(store, method, args), registryDropped: () => registryStore.dropped }));
    await phoneRegistry.load({ name: hostname(), healthy: true });
    phoneRegistry.setWorkspaceNamer(workspaceNameFor);
    phoneRegistry.setProbe((id) => host.probe(id));
    phoneRegistry.setHandoffProbe((id) => own.attention.lastHandoff(id));
    phoneRegistry.setSafeMode(() => safeMode.view());
    phoneRegistry.setHangNotice(() => crashState.view().notice);
    phoneRegistry.setObservedProbe((id) => takeOverHost.probe(id));
    const workspaceColors = new WorkspaceColors({ fs: nodeEnvelopeFs(), mayReadFolder: (path) => hostRegistry.workspaceStates().find((w) => w.path === path)?.asleep !== true, onChanged: () => phoneRegistry.touch() });
    phoneRegistry.setWorkspaceColorer((path) => workspaceColors.colorOf(path));
    const phoneAgents = () => Object.fromEntries(hostRegistry.listAgents().map((a) => [a.id as string, { name: a.name, workspaceId: a.workspaceId }]));
    phoneRegistry.setDeckSource(() => assembleDeckItems({
        workspaces: hostRegistry.listWorkspaces(),
        workspaceName: workspaceNameFor,
        approvals: approvals.deckItems(),
        trust: hostingStack?.trustDeckItems() ?? [],
        attention: own.attention,
        inbox: own.inbox,
        agents: phoneAgents(),
    }));
    // What this host can measure itself: mail agents have not collected, the OS agent working. Flows in flight and GitHub's
    // block are the window's to say (Tynn #551 notes it); with no window they read none.
    phoneRegistry.setSignals(() => ({
        flowsRunning: 0,
        uncollectedMail: hostRegistry.listAgents().reduce((n, a) => n + own.inbox.unread(a.id).length, 0),
        githubBlocked: false,
        osAgentWorking: (() => { const os = hostRegistry.listAgents().find(isOsAgent); return os ? host.probe(os.id)?.turnState === 'working' : false; })(),
    }));
    // Its snapshot follows the stores and the sessions, coalesced as the window's is, and only while no window is
    // connected: a snapshot is built on every touch, and with a window open the window answers.
    const phoneEstate = new Coalescer<'estate'>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: () => { if (engine.newestLocalWindow() === null) phoneRegistry.touch(); }, schedule: realSchedule, now: () => Date.now() });
    const phoneTouch = () => { if (engine.newestLocalWindow() === null) phoneEstate.request('estate'); };
    stores.onEvent((event) => { if (event.store === 'registry') void phoneRegistry.refresh(); else phoneTouch(); });
    host.subscribe(() => phoneTouch());
    approvals.onChange(phoneTouch);
    takeOverHost.onChange(phoneTouch);
    const phoneFiles = new FilesHost({
        gitStatus: gitFileStatus,
        gitShowHead,
        gitTree: gitTreeStatus,
        workspace: (id) => hostRegistry.workspace(id),
        agentsOf: (workspaceId) => hostRegistry.listAgents().filter((a) => a.workspaceId === workspaceId).map((a) => ({ id: a.id, name: a.name })),
        eventsOf: (agentId) => {
            const record = hostRegistry.find(agentId);
            return record ? fileEventsOf(host.rowsFor(record.id), { id: record.id, name: record.name }) : [];
        },
    });
    const phoneCwd = (record: AgentRecord): string => hostRegistry.workspace(record.workspaceId)?.path ?? osaHome;
    phoneApi = hostAloneApi({
        hostName: hostname(),
        registry: phoneRegistry,
        engine: () => host,
        cwdFor: phoneCwd,
        startRefusal: (r) => startRefusal({ registry: hostRegistry }, r, {
            running: hostRegistry.listAgents().filter((a) => a.workspaceId === r.workspaceId && host.probe(a.id)?.running === true).length,
            cap: agentCapFrom(settings.snapshotFor(r.workspaceId)),
        }),
        windowConnected: () => engine.newestLocalWindow() !== null,
        workspaceLifecycle: {
            terminals: () => terminalHost,
            supervisor: () => processSupervisor,
            engines: () => hostingStack?.hibernationEngines ?? null,
            reverifyTrust: async (id) => {
                if (!hostingStack) throw new Error('workspace trust is not available yet');
                await hostingStack.trust.refresh(id, 'redock');
            },
            github: () => githubNow,
            tynn: () => tynnAccountNow,
            defaultEnvFile: () => { const v = settings.snapshot().default_env_file; return typeof v === 'string' ? v : ''; },
            stagingDirectory: () => hostScratch.directory(),
        },
        colors: workspaceColors,
        settings,
        terminals: terminalHost,
        takeOver: (id) => takeOverHost.probe(id),
        headroom: headroomFeed,
        models: new ProviderModelCache(realListModels),
        providerInstalled: (provider) => providerBinary(provider as AgentRecord['provider']) !== null,
        attention: own.attention,
        approvals,
        inbox: own.inbox,
        deliverToAgent: (agentId, text) => host.deliver(agentId as AgentId, text, 'you'),
        files: {
            children: async (workspaceId, dir) => (await phoneFiles.children(workspaceId, dir)) ?? null,
            open: (workspaceId, path) => phoneFiles.open(workspaceId, path),
            readBytes: (workspaceId, path) => phoneFiles.readBytes(workspaceId, path),
            upload: (workspaceId, dir, name, bytes) => phoneFiles.upload(workspaceId, dir, name, bytes),
        },
        updates: { state: () => updatesService.dump(), onChange: (listener) => updatesService.onEvent(listener), check: async () => { throw new Error('check for updates from Genie’s window'); }, download: async () => false, install: () => null },
    });
    // The tailnet listener starts only now (remote_access on): a phone that connects finds the host's own answers ready.
    void remoteSwitch.apply().catch((error: unknown) => say(`remote: ${error instanceof Error ? error.message : String(error)}`));
    tynnRecovery = hostTynnRecovery({
        watchWake: wallClockJumps,
        names: (asked) => agentKeys.recovery(asked),
        waiting: () => agentKeys.waiting(),
        recheck: async () => { await hostTynn?.recheck(); },
        host,
        record: (id) => hostRegistry.find(id),
        threadOf: (id) => threadsHeard.get(id) ?? null,
        cwdFor: (record) => hostRegistry.workspace(record.workspaceId)?.path ?? osaHome,
        log: say,
    });
    void tynnOpening.then((account) => {
        account.onChange(() => { void tynnRecovery?.recover(); });
        // Agents may have started while it opened.
        void tynnRecovery?.recover();
        tynnRecovery?.kick();
    }, () => {});
    /** Flows (P3.3d), once — at the first window's v1 import, after the book (the old scheduled tasks move into it). */
    let flowsOpening: Promise<void> | null = null;
    let processBookNow: ProcessBook | null = null;
    /** The host's clocks, once they exist: stopped first at "Shut down everything" (P5a.3, host-shutdown.ts). */
    const clocks: Array<{ stop(): void }> = [marketplacePlugins];
    /** The clocks to plan again when the person leaves safe mode — arming what may fire later, and starting nothing now. */
    const planners: Array<{ plan(): void }> = [];
    safeMode.onChange((view) => { if (!view.active) for (const p of planners) p.plan(); });
    const openFlows = (databasePath: string): Promise<void> => {
        flowsOpening ??= (async () => {
            const store = await FlowStore.open(home);
            store.setHiddenWorkspaces(hiddenWorkspaces);
            // Genie 1's FLOWS (genie#1204), once, DISARMED — before the scheduler plans, which arms nothing they bring.
            await runV1FlowImport(store, { database: databasePath, workspaces: hostRegistry.listWorkspaces() }).catch((error: unknown) => say(`v1 flows import failed: ${error instanceof Error ? error.message : String(error)}`));
            // The scheduled tasks earlier betas imported as FLOWS move to the processes they were in Genie 1 — once, by a marker.
            if (processBookNow) await moveScheduledTasksOutOfFlows(store, processBookNow, (id) => hostRegistry.workspace(id)?.path ?? null).catch((error: unknown) => say(`scheduled tasks could not be moved out of Flows: ${error instanceof Error ? error.message : String(error)}`));
            const cwdOf = (r: AgentRecord): string => hostRegistry.workspace(r.workspaceId)?.path ?? osaHome;
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
                safeMode: safeNow,
                // A Codex agent in a workspace not trusted gets a flow's values with Genie's skill names escaped (genie#1519):
                // the host's own verdict, read where the flows run.
                escapesPromptValues: (address) => {
                    const found = resolveOnRoster(address, hostRegistry.listAgents(), hostRegistry.workspaceSlugs());
                    if (found.kind !== 'one') return false;
                    const agent = hostRegistry.find(found.id);
                    return agent?.provider === 'codex' && hostUntrustedNow(agent);
                },
            });
            // Genie's tools as flow steps: the host's MCP server's own (its native ones in place, the window's forwarded).
            const regs = mcp?.registrations() ?? [];
            if (regs.length > 0) engineFlows.setToolCaller(createFlowToolCaller({ registrations: regs, callers: flowCallers }));
            flowsService.attach({ store, scheduler: engineFlows.scheduler });
            clocks.push(engineFlows);
            planners.push(engineFlows.scheduler);
            // A hibernate or a wake changes what may fire: plan again on every registry write.
            let flowVisibility = JSON.stringify(hiddenWorkspaces().sort());
            stores.onEvent((event) => {
                if (event.store !== 'registry') return;
                engineFlows.scheduler.plan();
                const key = JSON.stringify(hiddenWorkspaces().sort());
                if (key === flowVisibility) return;
                flowVisibility = key; store.visibilityChanged();
            });
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
                // Each kept process's OWN app credential, minted here (P5a.2), window or no window.
                appEnv: (p: { readonly kind: 'process'; readonly id: string; readonly name: string; readonly workspaceId: string }) => appInboxDoor.envFor(p),
                asleep: (workspaceId: string) => hostRegistry.workspace(workspaceId)?.asleep === true,
                // Safe mode: the restore starts no kept process, and no scheduled task is armed.
                safeMode: safeNow,
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
            clocks.push(scheduler);
            planners.push(scheduler);
            // A workspace hibernated or woken changes what may fire: plan again on every registry write.
            let processVisibility = JSON.stringify(hiddenWorkspaces().sort());
            stores.onEvent((event) => {
                if (event.store !== 'registry') return;
                scheduler.plan();
                const key = JSON.stringify(hiddenWorkspaces().sort());
                if (key === processVisibility) return;
                processVisibility = key; processBook.visibilityChanged();
            });
            processesService.attach({ book: processBook, scheduler, supervisor: processSupervisor });
            processBookNow = processBook;
            mailProcessBook = processBook;
            const restored = processBook.restore();
            if (safeMode.active()) for (const p of processBook.kept()) if (restored.heldBack.includes(p.id)) safeMode.hold('process', { id: p.id, name: p.name });
            lifecycleLog(`process book open: ${restored.started.length} restored, ${restored.heldBack.length} held back`);
        })();
        return bookOpening;
    };
    // THE MAIL WAKE (P3.2): mail reaches its agent with no window — told, or started for it under the person's refusals.
    // ISSUEWATCH's queue is the wake's second source (P5c): `push` starts a stopped agent through this same wake, `next-turn` waits.
    wireHostMailWake({ inbox: own.inbox, host, registry: hostRegistry, settings, osaDir: osaHome, log: (line) => { say(line); lifecycleLog(line); }, issueWatch: issueWatch.delivery, safeMode: safeNow });
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
        capabilities,
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
        // THE AGENTS' `mail` (Genie Mail G6): the inbox book and the shared Mailpit, both this host's.
        ...(hostingStack?.mail ? { mail: hostingStack.mail } : {}),
        // THE AGENTS' `sites` AND `services` (Tynn #444): this host's own hosting (P5a) under its own supervisor — what the
        // Hosting and Services tabs show. Only `sites open` and `services exec` still go to a window.
        ...(hostingStack ? {
            hosting: {
                sites: hostingStack.sites,
                envelopeSites: hostingStack.envelopeSites,
                engines: hostingStack.engines,
                supervisor: processSupervisor,
                routes: () => hostingStack.routes(),
                engineStatuses: () => hostingStack.engineStatuses(),
                startEngine: (id: string) => hostingStack.startEngine(id),
                stopEngine: (id: string) => hostingStack.stopEngine(id),
                removeEngine: (id: string, options: { deleteData: boolean; workspaceId?: string }) => hostingStack.removeEngine(id, options),
                engineDependents: (id: string) => hostingStack.engineDependents(id),
                updateEngine: (id: string, options: { consent: boolean; approvedDependents?: readonly string[] }) => hostingStack.updateEngine(id, options),
            },
        } : {}),
        flowCallers: { callerFor: (key) => flowCallers.callerFor(key) ?? gappCallers.callerFor(key) },
        takeOverCaller: (id) => takeOverHost.callerFor(id),
        // The plugins' tools, run here (ADF A3): an official one in process, anyone else's in its sandboxed child. The Genie
        // API a plugin may ask for, by name: knowledge search only, for now; everything else is not offered.
        plugins: hostPluginTools(pluginsService, {
            sandboxDir: join(home, 'plugin-sandbox'),
            api: async (method, params) => {
                if (method === 'knowledge.search') return own.knowledge.search({ ...(typeof params === 'object' && params !== null ? params : {}) } as never);
                throw new Error(`${method} is not offered to plugins`);
            },
        }),
        endpointFile: join(home, 'mcp-endpoint.json'),
        osaDir: osaHome,
        log: (line) => { say(line); lifecycleLog(line); },
    });
    host.subscribe(() => { lastBusy = Date.now(); });
    // THE HOST'S SIGN OF LIFE (safe mode): when, and which agents have a session — what the next start reads if this run
    // dies. Small and atomic; unref'd, so it never holds a host that is otherwise done.
    startBeat({ started: () => host.startedIds(), onChange: (l) => host.subscribe(() => l()), beat: (ids) => { safeMode.beat(ids); } });
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
                void client.linkUp().then(() => {
                    if (profile === 'supervised') {
                        supervisedLink.setUp(true);
                        /*
                         * THIS HOST CREATES NO PROCESS ON ITS OWN THREAD (Tynn #532): Windows creates one synchronously on the
                         * calling thread, and one git read held this host 295 ms. Its git and its commands (execFileRunner)
                         * are created by this child while it is up; between its lives, here, as before.
                         */
                        setGitExecRoute(supervisedClient.gitExec);
                        routeExecThroughSpawnHost(supervisedClient);
                    }
                }).catch((error: unknown) => lifecycleLog(`${profile} spawn host did not come up: ${error instanceof Error ? error.message : String(error)}`));
            }
        },
        // Between their lives, opens are refused in words (a crash the supervisor backs off from), never sent into nothing.
        onChildExit: (profile) => {
            if (profile === 'supervised') { supervisedLink.setUp(false); setGitExecRoute(null); routeExecThroughSpawnHost(null); }
            if (profile !== 'processes') ownChildren[profile].linkDown(`the ${profile} spawn host exited`);
        },
        log: (line) => { say(line); lifecycleLog(line); },
        onPtys: writePtys,
    });

    // This host's OWN endpoint (a local socket or pipe, token-checked): every window here is local — the only kind sent the
    // hosting, whose dump carries each workspace's service variables (P5a.2). P5d: a remote path accepts as not local.
    server.on('connection', (socket) => engine.accept(lineTransport(socket), { local: true }));

    // The token first, then the record that points at it: a window that reads the record can always read the token.
    await writeTextPrivate(tokenFile, token);
    if (process.platform !== 'win32') chmodSync(tokenFile, 0o600);
    const record: HostRecord = { pid: process.pid, endpoint, protocol: ENGINE_PROTOCOL, build, startedAt: Date.now() };
    await writeTextPrivate(recordFile, JSON.stringify(record));
    say(`serving ${endpoint} (protocol ${ENGINE_PROTOCOL}, build ${build})`);

    async function shutdown(why: string): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        hangWatchdog.shuttingDown();
        say(`shutting down: ${why}`);
        if (marketplaceHost) await marketplaceHost.close().catch((error: unknown) => say(`Marketplace shutdown: ${error instanceof Error ? error.message : String(error)}`));
        lifecycleLog(`host shutdown pid=${process.pid} reason=${why}`);
        browserService.quit();
        const bound = new Promise<void>((r) => setTimeout(r, 10_000).unref());
        // Every session stopped and its stop verified, every write drained — bounded, so a stuck stop never keeps a
        // host nobody wants.
        await Promise.race([host.stopAll().then(() => host.drained(2_000)), bound]).catch(() => undefined);
        files?.close();
        issueWatch.stop();
        await mcp?.stop();
        approvals.cancelAll('Genie is shutting down');
        own.knowledge.close();
        // THEN EVERYTHING THIS HOST SUPERVISES (P5a.3): its sites, the front door's Caddy, the kept processes — stopped, then
        // the hosting's own part, then the spawn-host children end. The engines' containers keep running: databases
        // outlive "Shut down everything", and the next host's reconcile finds them (host-shutdown.ts).
        await stopHostedOnce();
        await appInboxDoor.close().catch(() => undefined);
        await gappServer?.close().catch(() => undefined);
        server.close();
        // Only this host's record: a newer host may already have written its own.
        const current = parseHostRecord(readOrNull(recordFile));
        if (current?.pid === process.pid) {
            rmSync(recordFile, { force: true });
            rmSync(tokenFile, { force: true });
        }
        // THE CLEAN-EXIT MARKER, LAST (Tynn #386): everything above ended; its absence at the next boot is safe mode.
        safeMode.writeCleanExit(why);
        process.exit(0);
    }
    // The updater's own clock (AUTO_CHECK): stopped with the host's other clocks, first, at "Shut down everything".
    clocks.push({ stop: updatesService.startAutoCheck((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); }) });
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    // IDLE EXIT: nothing running and no window for IDLE_MS. While an agent runs, the host stays — that is the point.
    // With GENIE_HOST_IDLE_MS=0 there is no idle exit at all (P10.1c), so no clock.
    if (IDLE_MS !== null) {
        setInterval(() => {
            const step = hostIdleStep({ agents: host.count, windows: engine.clients, ptys: relay?.live() ?? 0, ...onTheClock(hostFlows.list(), hostBook.kept()) }, lastBusy, Date.now(), IDLE_MS);
            lastBusy = step.lastBusy;
            if (step.exit) void shutdown(`idle ${Math.round(IDLE_MS / 1000)} s with nothing held and no window`);
        }, Math.min(30_000, Math.max(1_000, Math.floor(IDLE_MS / 4)))).unref?.();
    } else {
        say('idle exit off (GENIE_HOST_IDLE_MS=0)');
    }
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

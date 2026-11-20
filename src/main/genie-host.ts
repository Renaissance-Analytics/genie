import './process-start.js';
import './close-inherited-fds.js';
// ^ FIRST but for process-start, which opens nothing: close inherited handles before a contributor opens its own.
import { featureDownload } from './feature-download.js';
import { HostFeatures } from './features-host.js';
import { FeatureCallers } from './feature-callers.js';
import { nativeFeatureToolchain, adoptFeatureEnvironment } from './feature-native-toolchain.js';
import { featureWorkspaceFiles } from './feature-workspace-files.js';
import { syncWorkspaceFiles } from './host-workspace-files.js';
import { AgentFilesHealth } from '../core/agent-files-health.js';
import { IssueWatchReplica } from './issue-watch-replica.js';
import { whatsNewFor } from '../core/whats-new.js';
import { RELEASE_NOTES } from './release-notes.js';
import { signedOutGithubView } from '../core/github.js';
import type { MachineFeaturePorts } from './feature-machine.js';
import { getTailscaleStatus, installTailscale, tailscaleCommand, tailscaleUp } from './tailscale-cli.js';
import { tailscaleLive } from './tailscale-live.js';
import { ensureFirewallRule, firewallReader, readFirewallRule, removeFirewallRule } from './remote-firewall.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { hostname, uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_PROTOCOL, hostEndpoint, parseHostRecord, type HostRecord } from '../core/engine-protocol.js';
import { lineTransport } from '../core/line-transport.js';
import { describeProcesses, systemProcessTree } from '../core/process-tree.js';
import { makeServiceExec } from './service-exec.js';
import { doctorHoldNow } from './genie-running-file.js';
import { openLifecycleLog } from './lifecycle-log.js';
import { genieRoot, legacyProviderHomes, osaHomeDir, runtimeDir, sessionsDir, userHome } from './paths.js';
import { WorkspaceStorage, type ChatFile } from './workspace-storage-host.js';
import { storageFeaturePort } from './storage-feature-port.js';
import type { InUseFolder } from '../core/workspace-storage.js';
import { threadAttachmentFiles } from '../core/thread-store.js';
import { AccountsHost } from './accounts-host.js';
import { ACP_PROVIDERS, isAcpProvider } from '../core/engine.js';
import { prepareGenieSupervisor, removeStaleSupervisorBuilds, supervisorImagesRunning } from './prism-supervisor.js';
import { SessionEngineServer } from './session-engine-server.js';
import { readTynnPage } from './tynn-page-client.js';
import type { TynnBoardPorts } from './tynn-board-client.js';
import { StallWatchdog } from './stall-watchdog.js';
import { HangWatchdog } from './hang-watchdog.js';
import { CrashStateHost } from './crash-state-host.js';
import { crashHeader, exitRecordOf, previousRunCause, previousRunRecord, readLifecycleTail, writeCrashRecord } from './crash-records.js';
import { runningAgentNote } from '../core/crash-record.js';
import { providerBinary, realListModels, SessionHost } from './session-host.js';
import { HostRegistryStore } from './agent-stores-replica.js';
import { ProviderModelCache } from '../core/provider-models.js';
import { HeadroomFeed, headroomBufferMs } from '../core/headroom-board.js';
import type { Headroom, ReadingStamp } from '../core/headroom.js';
import { ReadingAttribution } from '../core/reading-attribution.js';
import { LIMIT_ALERTS_SETTING, LimitAlertService, LimitNoticeBook, parseLimitAlerts } from '../core/limit-alerts.js';
import { StalledTurnBook } from '../core/hung-call.js';
import { SWITCH_OFFER_WINDOWS_SETTING, SwitchOfferService } from '../core/switch-offer.js';
import { accountsView, type AccountsSnapshot } from '../core/accounts-view.js';
import { DesignAuthBook } from '../core/design-auth.js';
import type { AccountsAction, AccountsActResult } from '../core/account-settings.js';
import { TrustVerdicts } from './trust-verdict.js';
import { setGitReadPolicy, trustAwarePolicy } from './git-read-policy.js';
import { writeGenieInstructions } from './genie-instructions.js';
import { SpawnLedger } from './spawn-ledger.js';
import { startSpawnRelay, type SpawnRelay } from './spawn-relay.js';
import { routeExecThroughSpawnHost, SpawnHostClient } from './spawn-host-client.js';
import { setGitExecRoute } from './git-exec.js';
import { ProcessSupervisor, osPidAlive } from './process-supervisor.js';
import { endChildTrees } from './end-child-trees.js';
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
import { terminalWorkspaceOf, workspaceFolders } from './host-share-scope.js';
import { TakeOverHost } from './take-over-host.js';
import { WorkspaceColors } from './workspace-color-host.js';
import { nodeEnvelopeFs } from './envelope-sites-host.js';
import { CloneOffersService } from './clone-offers-service.js';
import { nodeSaveGit, workspaceSaveOps } from './workspace-save-host.js';
import { elementSourcesFor } from './workspace-save-sources.js';
import { cloneRestorePorts, nodeCloneFiles } from './workspace-clone-ports.js';
import { restoreClone, watchNewWorkspaces, type CloneRestorePorts } from './workspace-clone-restore-host.js';
import { CloneWatch } from './clone-watch-host.js';
import { withElements } from '../core/workspace-elements.js';
import { scratchArea } from './scratch-area.js';
import { TakeOverService } from './take-over-service.js';
import { openCallersTerminalWindow, type TerminalWindowPorts } from './host-terminal-windows.js';
import { hostMcpRecovery, withMcpRecovery } from './host-mcp-recovery.js';
import { crashReportHost } from './crash-report-host.js';
import { hostSignIns } from './host-sign-ins.js';
import { takeOverRouteOf } from '../core/take-over-route.js';
import { ProcessBook } from './process-book.js';
import { KeptProcessLogs } from './kept-process-logs.js';
import { nudgeOnRoster } from './scheduled-nudge.js';
import { BrowserService } from './browser-service.js';
import { spawnBrowserProcess, spawnGenieWindow, spawnUpdaterProcess, windowExitOf } from './engine-launch.js';
import { clearUpdateFailed, helperLaunch, hostDrainAgents, readUpdateFailed, relaunchSpec, remoteUpdatesPort, updaterDefaultLaunch, updaterHelperEnv, UpdatesService, writeUpdateFailed } from './updates-host.js';
import { shareLinksOver } from './tynn-share-links.js';
import { AgentShutdownDrain } from '../core/agent-shutdown-drain.js';
import { killProcessAsync, listProcessesAsync, tcpSocketsOwnedByAsync } from './process-list.js';
import { windowReleased } from './window-release.js';
import { channelFrom } from '../core/update-channel.js';
import type { ReleaseLike } from '../core/update-notes.js';
import { hostIdleMs, hostIdleStep } from '../core/host-idle.js';
import { NO_BROWSER_HERE, NO_UPDATES_HERE, hostCapabilities } from '../core/host-runtime.js';
import { fts5Refusal } from './fts5-check.js';
import { restrictHostPipe } from './host-pipe-acl.js';
import { onTheClock } from '../core/tray-only.js';
import { hostSummaryFeed, hostSummaryOf } from '../core/host-summary.js';
import { accountKeyOf } from '../core/remote-window-policy.js';
import { ProcessScheduler } from './process-scheduler.js';
import { ProcessBookReplica, ProcessesService } from './processes-host.js';
import { FlowStore } from './flow-store.js';
import { FlowsReplica, FlowsService } from './flows-host.js';
import { startFlowsEngine } from './flows-engine.js';
import { FlowCallers, createFlowToolCaller } from './flow-tools.js';
import { GAppBridge, GAppCallers, createGAppToolRunner } from './gapp-bridge.js';
import { askOnDeck, gappSessions, gappsApi } from './gapps-api.js';
import { GAppPreviews } from './gapp-previews.js';
import { runV1FlowImport } from './v1-flows.js';
import { moveScheduledTasksOutOfFlows } from './scheduled-tasks-move.js';
import { startForWork } from './start-on-demand.js';
import { startRefusal } from './workspace-ops-host.js';
import { agentCapFrom, HUMAN } from '../core/inbox.js';
import { limitOf } from '../core/shell-limits.js';
import { resolveAddress as resolveOnRoster } from '../core/inbox.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { pidAlive } from './engine-launch.js';
import { FilesWatchHub } from './files-watch-hub.js';
import { workerWatchSource } from './files-watch-worker.js';
import { openHostKeychain, type HostKeychain } from './host-keychain.js';
import { hostLegacyAdopt } from './host-legacy-adopt.js';
import { fileMigrationBook, hostVault } from './keychain-migration.js';
import { podApproval, startProofOfDone } from './proof-of-done-host.js';
import { GithubAccount } from './github-account.js';
import { GithubAccountService } from './github-account-service.js';
import { hostHttpsFetch } from './host-https-fetch.js';
import { relayFetchOver } from './host-relay-fetch.js';
import { hostAgentKeys } from './host-agent-keys.js';
import { chmod, mkdir, readFile as readFileText, stat as statFile } from 'node:fs/promises';
import { attachWebSocketServer } from '@particle-academy/fancy-ws';
import { LOCAL_EVENTS, transportHub, type CallContext, type RemoteMethod } from '../core/remote-protocol.js';
import { deviceLinkProtocol } from './device-link-protocol.js';
import { wordTynnRefusal } from './drone-refusal.js';
import { REMOTE_PORT } from '../core/tailscale.js';
import { remoteListener } from './remote-listen.js';
import { remoteAccess } from './remote-access.js';
import { staticServer } from './static-page.js';
import { hostRemoteApi, RemoteAccessHost, RemoteAccessService } from './remote-access-host.js';
import { accountsOwnAnswers, type AccountsPort } from './accounts-protocol.js';
import { uploadSender } from './uploads.js';
import { sacredNameOf } from '../core/agent-adoption.js';
import { RelayHostService } from './relay-host-service.js';
import { connectOutRefusal, mayBrowse } from '../core/workstation-role.js';
import { readWorkstationRoleOutcome } from './workstation-role-reader.js';
import { dialFrontDoor } from './relay-site.js';
import type { HostApi } from './remote-host.js';
import { hostAloneApi } from './host-alone-api.js';
import { APP_WINDOW, hostLocalPorts } from './host-local-ports.js';
import { ProtocolTunnels } from './protocol-tunnels.js';
import { hostFilesWatch, hostTynnWatch, ownerRoute } from './host-local-watches.js';
import { hostOwnerOps } from './host-owner-ops.js';
import { LocalStagingArea } from './local-staging-area.js';
import { Registry } from './registry.js';
import { FilesHost } from './files-host.js';
import { fileEventsOf } from '../core/files-panel.js';
import { gitFileStatus, gitShowHead } from './git-ports.js';
import { askerLiveFrom } from './asker-live.js';
import { assembleDeckItems } from './deck-assembly.js';
import { Coalescer, realSchedule } from '../core/coalesce.js';
import { AGENT_PUSH_INTERVAL_MS } from './agent-push.js';
import { isOsAgent } from '../core/os-agent.js';
import { machineKeyOf, readMachineId } from './machine-key.js';
import { execFileRunner, execFileText } from './toolchain-runner.js';
import { PlaywrightHost, osConnections } from './playwright-host.js';
import { PlaywrightInstaller, playwrightToolPort } from './playwright-auto.js';
import { installPlaywrightBrowsers, nodePlaywrightFs, readyOnDisk } from './playwright-browsers.js';
import { PLAYWRIGHT_AUTO_INSTALL_ENV, autoInstallEnabled } from '../core/playwright-managed.js';
import { applyPlaywrightEnv, nodeToolchainFs, processEnv } from './toolchain-ops.js';
import { playwrightServerPort } from './playwright-server.js';
import { nodePhpVersionsFs } from './php-versions.js';
import { checkProviderHealth, ProviderHealthBook, realProviderHealthPorts } from './provider-health.js';
import { AccountIdentityReader } from './account-identity.js';
import { headroomArrival, IdentityWatch, identityReadHooks } from './identity-watch.js';
import { AccountSwitchFlow, type AccountSwitchStart } from './account-switch-host.js';
import { accountSwitchSignal } from '../core/account-switch.js';
import { afterSignedIn, LoginHost, statusCommandFor } from './login-host.js';
import { accountIdentityFrom, SIGNED_IN_AGAIN } from '../core/provider-login.js';
import { tellDesignLoginRan } from '../core/design-login.js';
import { workstationKeyStore } from './workstation-identity.js';
import { WorkstationService } from './workstation-service.js';
import { setWin32ProcessReader } from '../core/process-tree.js';
import { restrictPrivateDirectories, sharedWindowsHelper } from './private-credentials.js';
import { writeTextPrivate } from './store.js';
import { openRelayMember, PopKeypair } from './relay-member.js';
import { mintConnectGrant, relayHostPorts, startRelayHost } from './tynn-network.js';
import { AgentToolCalls } from './mcp-interrupt.js';
import { testReadyDelayMs } from './host-wait-window.js';
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
import { catalogCapabilities, remoteOffer } from '../core/protocol-version.js';
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
import { hostAgentWake, wireHostMailWake } from './host-mail-wake.js';
import { wireHostPlanKeepalive, type HostPlanKeepalive } from './host-plan-keepalive.js';
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
import { providerChoiceFile, setProviderChoiceFile } from './provider-choice.js';
import { hostProviderPrograms } from './host-provider-programs.js';
import { ScratchTerminals, scratchTerminalFor } from './scratch-terminal.js';
import { hostQuestionReads } from './host-question-reads.js';
import { hostShellFor } from './host-shell.js';
import { warmLockIdentity } from '@particle-academy/prism-harness';
import { repoStatus } from './repo-git.js';
import { saveChatUploads, uploadWorkspaceOf } from './chat-uploads.js';

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
const hostAppVersion = build.includes('+') ? build.slice(0, build.lastIndexOf('+')) : build;
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

/** The Genie tool calls running for each agent, ended by its Interrupt (Tynn #702; mcp-interrupt.ts). */
const toolCalls = new AgentToolCalls();

const sleepFor = (ms: number): Promise<void> => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

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
    const safeMode = SafeMode.open(runtime, { asyncBeat: true, machineBootedAt: () => Date.now() - uptime() * 1000, log: (line) => { say(line); lifecycleLog(line); }, cause: () => previousRunCause(join(runtime, 'crash'), parseHostRecord(readOrNull(recordFile))?.startedAt ?? null) });
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
    // Said when it is ready, naming the file (beta.61.1): the packaged CI check reads it.
    if (supervisor !== null) lifecycleLog(`containment ready supervisor=${supervisor}`);
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
    // WHAT A START SPENDS ITS TIME ON (Tynn #700): each step up to serving, in the lifecycle log, with when it ended.
    const bootStarted = Date.now();
    let stepAt = bootStarted;
    const bootStep = (name: string, since: number): void => { const at = Date.now(); lifecycleLog(`boot step=${name} ms=${at - since} at=${at - bootStarted}`); stepAt = at; };
    const settings = await SettingsStore.open(home);
    bootStep('settings', stepAt);
    // The host's account book (S1). Existing provider homes remain references, never read or moved.
    const accounts = await AccountsHost.open({ root: home, legacyHomes: legacyProviderHomes() });
    const own = await openAgentStores(home, () => new Date().toISOString(), (id) => sessionsForInbox?.probe(id) ?? null, () => attentionLimitsFrom(settings.snapshot()));
    const drafts = await ChatDraftStore.open(home);
    bootStep('agent stores', stepAt);
    // THE REGISTRY'S FILES (P3.2): this host writes them (windows through it) and reads them for its own tools and approvals.
    const registryStore = new Store(home);
    // What a quit or an upgrade recorded is KEPT in safe mode (never taken), and listed on the banner with its own Start.
    if (safeMode.active()) void Promise.all([registryStore.readRunningAtQuit(), registryStore.readInterruptedAtQuit()]).then(([running, interrupted]) => safeMode.wasRunning([...running, ...interrupted]), () => {});
    const hostRegistry = new HostRegistry(registryStore);
    await hostRegistry.refresh();
    bootStep('registry', stepAt);
    const hiddenWorkspaces = () => hostRegistry.workspaceStates().filter((w) => w.asleep === true).map((w) => w.id);
    own.knowledge.setHiddenWorkspaces(hiddenWorkspaces);
    own.inbox.setVisibility((message) => hostRegistry.mailParticipantVisible(message.from) && hostRegistry.mailParticipantVisible(message.to), () => hostRegistry.mailVisibilityVersion());
    let engineRef: SessionEngineServer | null = null;
    let hostFeatures: HostFeatures | null = null;
    const featureCallers = new FeatureCallers();
    /*
     * THIS MACHINE'S WINDOWS ARE SERVED HERE (Tynn #898 step 2d-4b): each window's protocol connection, tunnelled over its
     * process's engine link, joins the remote hub below as this machine's own window. A tunnelled connection's feature
     * effects (a page to open, a sign-in, the browser pane) are asked of the window process that owns it.
     */
    /** Set once the phone registry is built, below: a notice said before then has no snapshot to push yet. */
    let phoneRegistryNow: Registry | null = null;
    const protocolTunnels = new ProtocolTunnels({
        onBound: (connectionId, binding, browser) => {
            featureCallers.bindConnection(connectionId, binding.owner, (id, method, args) => (engineRef ? engineRef.featureEffect(binding.owner, id, method, args) : Promise.reject(new Error('Genie’s window link is not ready'))));
            featureCallers.connectionBrowser(connectionId, browser);
        },
        onUnbound: (connectionId) => { featureCallers.unbindConnection(connectionId); },
        onBrowser: (connectionId, browser) => { featureCallers.connectionBrowser(connectionId, browser); hostFeatures?.invalidate(); },
        // The window's "the page came back" notice (gate renderer-crash B3/B4): its snapshot is pushed again, with it.
        onNotice: () => { phoneRegistryNow?.touch(); },
    });
    const featureChanges = new Set<() => void>();
    const featureChanged = () => { for (const listener of featureChanges) listener(); };
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
    /** Genie 1's database, as the window located it (Electron's userData; v1Import below): its record of this machine. */
    let v1DatabasePath: string | null = null;
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
    bootStep('app door', stepAt);
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
    bootStep('hosting', stepAt);
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
        accountFor: record => accounts.activeFor(record.provider),
        terminals: terminalHost,
        openWindow: () => {},
        mcp: () => { const e = mcp?.endpoint() ?? null; return e ? { mcpUrl: e.url, token: e.token } : null; },
    });
    /** The window process that carries a protocol connection, asked to open a terminal's window (host-terminal-windows.ts). */
    const terminalWindowPorts: TerminalWindowPorts = {
        ownerOf: (connectionId) => protocolTunnels.bindingOf(connectionId)?.owner ?? null,
        windowOp: (owner, op, args) => (engineRef ? engineRef.windowOp(owner, op, args) : Promise.reject(new Error('Genie is still starting; try again in a moment'))),
        log: (line) => lifecycleLog(line),
    };
    /**
     * TAKE OVER, for every client (Tynn #896): the TUI starts here; this machine's window that asked is asked to open its
     * window on it, and the TUI ends when that window closes. Another machine's gets a ticket (RemoteHost).
     */
    /*
     * THE THROWAWAY SHELL (Tynn #378, #761; #897 2c-4): disposable, on this host's terminal host; this machine's window that
     * asked opens its window (terminal.window) and its closing ends it. Another machine's opens its own with a ticket, and
     * that window closing (or the ticket going unused) ends it too (takeOverEnded).
     */
    const hostScratchTerminals: ScratchTerminals = new ScratchTerminals({
        terminals: terminalHost,
        openWindow: (route, terminalId, context) => { openCallersTerminalWindow(terminalWindowPorts, context, route, { startedHere: true, ended: () => hostScratchTerminals.windowClosed(terminalId) }); },
    });
    const ownTakeOver: Partial<Record<RemoteMethod, (args: unknown[], context?: CallContext) => Promise<unknown>>> = {
        takeOver: async (args, context) => {
            const started = takeOverService.start(args[0]);
            if (started.ok) {
                openCallersTerminalWindow(terminalWindowPorts, context, takeOverRouteOf(started.terminalId), {
                    startedHere: started.started === true,
                    ended: () => takeOverService.ended(started.terminalId),
                });
            }
            return started;
        },
    };
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
    const cloneOffersService = new CloneOffersService();
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
    /** What tells the host summary (below) to read again: the relay host's role, and the Tynn account (Tynn #954, 2g-3a). */
    const summaryPokes = new Set<() => void>();
    const pokeSummary = (): void => { for (const l of [...summaryPokes]) l(); };
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
    /** This host's GitHub account once open: whether GitHub blocks features, for the summary and the Deck's strip (Tynn #959). */
    let githubAccountNow: GithubAccount | null = null;
    void githubOpening.then((account) => { githubAccountNow = account; }, () => {});
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
        send: ownerRoute((event) => hostTynnWatches.deliver('board', event), (owner, event) => { engineRef?.tynnBoardEvent(owner, event); }),
        log: say,
    });
    const tynnIssues = new TynnBoardHub({
        tynn: () => hostTynn,
        socket: tynnSocket,
        schedule: tynnTimer,
        projectFor: workspaceTynnProject,
        feed: TYNN_ISSUES_FEED,
        send: ownerRoute((event) => hostTynnWatches.deliver('issues', event), (owner, event) => { engineRef?.tynnIssuesEvent(owner, event); }),
        log: say,
    });
    // The Features page (row F1) follows its own channel, as the Issues queue does.
    const tynnFeatures = new TynnBoardHub({
        tynn: () => hostTynn,
        socket: tynnSocket,
        schedule: tynnTimer,
        projectFor: workspaceTynnProject,
        feed: TYNN_FEATURES_FEED,
        send: ownerRoute((event) => hostTynnWatches.deliver('features', event), (owner, event) => { engineRef?.tynnFeaturesEvent(owner, event); }),
        log: say,
    });
    // THE LIVE TYNN TAB, AS GENIE-HOST'S OWN ANSWERS WATCH IT (Tynn #898 step 2d-3b): the three hubs, under its own owner.
    const hostTynnWatches = hostTynnWatch({ hubs: { board: tynnBoard, issues: tynnIssues, features: tynnFeatures } });
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
    const agentShutdown = new AgentShutdownDrain({
        agents: () => hostRegistry.listAgents().map(({ id, name }) => {
            const session = host.probe(id as AgentId);
            return { id, name, running: session?.running === true, inTurn: session?.inTurn === true };
        }),
        // A queued shutdown notice is no longer relevant after restart; it must not become owed work.
        notify: (id, text) => { host.handOff(id as AgentId, text, 'genie', { retold: true }); },
        hold: () => host.holdForShutdown(),
        release: () => host.releaseAfterShutdown(),
    });
    const updatesService = new UpdatesService({
        ...(capabilities.window ? {} : { unavailable: NO_UPDATES_HERE }),
        host: {
            installDir: dirname(process.execPath),
            ownPid: process.pid,
            processes: listProcessesAsync,
            kill: killProcessAsync,
            channel: channelFrom(settings.snapshot().update_channel),
            runningVersion,
            // Which host this is (Tynn #413): an update carrying this very host is client-only, and this host keeps running.
            running: { build, protocol: ENGINE_PROTOCOL },
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
                waitForSafe: (reason, progress) => agentShutdown.begin(reason, progress).then((outcome) => {
                    if (outcome.interrupted.length) {
                        const line = `${reason}: stopping mid-turn: ${outcome.interrupted.map((a) => a.name).join(', ')}${outcome.timedOut ? ' (120-second wait expired)' : outcome.forced ? ' (proceed now chosen)' : ' (early acknowledgement)'}`;
                        say(line); lifecycleLog(line);
                    }
                    return outcome;
                }),
                force: () => agentShutdown.force(),
                release: () => agentShutdown.release(),
                readPending: async () => {
                    const [running, interrupted] = await Promise.all([registryStore.readRunningAtQuit(), registryStore.readInterruptedAtQuit()]);
                    return { running, interrupted };
                },
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
        exit: () => shutdown('an update is installing'),
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
        // HOW A LOST WINDOW ENDED (Tynn issue #711): the exit this host saw for a window it started, else the window's own record.
        exitOf: windowExitOf,
        ownExit: (pid, since) => exitRecordOf(join(runtime, 'crash'), pid, since),
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
    bootStep('accounts and services', stepAt);
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
    let gappPreviews: GAppPreviews | null = null;
    /** A GApp's consent, on the Deck (Tynn #596): an install's, and a preview's first run (V8). */
    const gappAsk = askOnDeck(approvals, (id) => { const path = hostRegistry.workspace(id)?.path; return path ? basename(path) : id; });
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
            // V9: the marketplace's keys verify an app, and one it withdraws is refused at the app's next check.
            registry: marketplacePlugins.registry,
        });
        gappBook.onChange(() => catalogService.rebuild());
        catalogService.rebuild();
        // GApps v2 V4: installed apps at their own origins, behind the front door.
        // GApps v2 V8: each workspace's own app, run as a preview from its folder.
        gappPreviews = await GAppPreviews.open({
            dir: join(home, 'gapps'), keys: PUBLISHER_KEYS, catalog: () => hostCatalog(pluginsService.plugins(), gappBook ?? undefined),
            workspaces: () => hostRegistry.listWorkspaces().map((w) => ({ id: w.id, name: basename(w.path), path: w.path })),
        });
        gappPreviews.onChange(() => { for (const listener of gappRouteListeners) listener(); });
        const gappBridge = new GAppBridge({
            book: gappBook,
            previews: gappPreviews,
            catalog: (id) => catalogService.snapshot().definitions.find((d) => d.id === id) ?? null,
            run: createGAppToolRunner({ registrations: () => mcp?.registrations() ?? [], callers: gappCallers }),
            onCatalogChange: (listener) => catalogService.onEvent((change) => listener(change.revision)),
        });
        gappServer = new GAppServer({ book: gappBook, previews: gappPreviews, bridge: gappBridge });
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
    const remoteListen = remoteListener({
        // Found at each start, never by PATH: a Tailscale installed while Genie runs is not on this process's PATH (Tynn #749).
        tailscale: () => tailscaleCommand(['status', '--json'], 15_000),
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
                await tailscaleCommand(['cert', '--cert-file', certFile, '--key-file', keyFile, dnsName], 60_000);
                await chmod(keyFile, 0o600).catch(() => {});
                return { cert: await readFileText(certFile, 'utf8'), key: await readFileText(keyFile, 'utf8') };
            } catch (error) {
                say(`remote: no Tailscale cert for ${dnsName}, serving http inside the tailnet: ${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        },
    });
    const remoteHub = transportHub(remoteListen.transport);
    remoteHub.add(protocolTunnels);
    // THIS MACHINE'S KEY IS HERE (P3.4), and the relay that signs with it (Tynn #410).
    const workstationService = new WorkstationService({
        store: workstationKeyStore(join(home, 'workstation.json'), keychain),
        log: (line) => say(line),
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
    // Its Tynn calls over this host's HTTPS client, adapted in the open (Tynn issue #707: a cast here sent no signal and
    // read a json() the client does not have, so no 61.x drone reached the relay).
    const relayFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        const memory = await proxyMemory;
        return relayFetchOver(hostHttpsFetch({ proxyRoutes: (target) => memory.routesFor(target), log: say }))(url, init);
    };
    const relayHostService: RelayHostService = new RelayHostService({
        account: () => tynnAccountNow,
        workstation: workstationService,
        enabled: () => settings.snapshot().remote_access === true,
        // Each read says what Tynn answered, in the lifecycle log (beta.61.1).
        readRole: async (request) => {
            const outcome = await readWorkstationRoleOutcome(request);
            say(`tynn role read: ${outcome.words}`);
            return { role: outcome.role, unbound: outcome.unbound === true };
        },
        schedule: (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
        start: ({ host, workstationId, fingerprint, onStatus }) => startRelayHost({
            ports: relayHostPorts({ tynnHost: host, workstationId, authHeader: () => workstationService.authHeader(host), fetch: relayFetch }),
            socket: (url) => deviceSocket(url),
            workstationId,
            fingerprint,
            sign: (data) => workstationService.sign(host, data),
            // Only a grant for the Tynn account signed in HERE is the owner's (Tynn #757); read at each admission.
            signedInHere: () => tynnAccountNow?.userId() ?? tynnAccountNow?.savedUserId() ?? null,
            attach: (transport) => remoteHub.add(transport),
            onStatus,
            log: (message) => say(`tynn relay: ${message}`),
            ...(hostingStack ? { site: { dial: (name: string) => dialFrontDoor(hostingStack.frontDoorPort, name), ca: () => hostingStack.browserTrust().caPem } } : {}),
        }),
        onChange: () => { engineRef?.relayHostEvent(relayHostService.status()); featureChanged(); pokeSummary(); },
    });
    /*
     * WHAT THIS HOST RUNS, AS THIS MACHINE'S TRAY AND QUIT READ IT (Tynn #953, 2g-2): its live terminals, armed flows and
     * scheduled tasks, said to main's own client (summary.watch) when any of them changes; and this machine's Pilot/Drone
     * role and its Tynn account (Tynn #954, 2g-3a), which main's dial refusals and its relay windows read. Read after the
     * replicas above took each change (their listeners come first).
     */
    /** This host's keychain once open: whether it can keep secrets, for the summary (Tynn #959, 2g-3b). */
    let keychainNow: HostKeychain | null = null;
    const hostSummary = hostSummaryFeed({
        read: () => hostSummaryOf(terminalHost.list(), hostFlows.list(), hostBook.kept(), { workstationRole: relayHostService.role(), tynnAccountKey: tynnAccountNow ? accountKeyOf(tynnAccountNow.status()) : null, keychainReady: keychainNow?.state() === 'ready', githubBlocked: (githubAccountNow?.view().signal ?? null) !== null }),
        onChange: (listener) => {
            summaryPokes.add(listener);
            const offs = [terminalHost.onChange(listener), flowsService.onEvent(() => listener()), processesService.onEvent(() => listener()), () => { summaryPokes.delete(listener); }];
            return () => { for (const off of offs) off(); };
        },
    });
    void tynnOpening.then((account) => { account.onChange(pokeSummary); pokeSummary(); }, () => {});
    // WHETHER THE KEYCHAIN CAN KEEP SECRETS, AND GITHUB'S BLOCK (Tynn #959, 2g-3b): main's one-time unsealer runs again when the
    // keychain turns ready (legacy-unsealer.ts), and its Deck strip reads GitHub's block from here.
    void keychainOpening.then((opened) => { keychainNow = opened; opened.keychain.onAnswerChange(pokeSummary); opened.keyring?.onChange(pokeSummary); pokeSummary(); }, () => {});
    void githubOpening.then((account) => { account.onChange(pokeSummary); pokeSummary(); }, () => {});
    void tynnOpening.then((account) => {
        account.onChange(() => { void relayHostService.register(); });
        void relayHostService.register();
    }, () => {});
    setInterval(() => { void relayHostService.readRole(); }, 5 * 60_000).unref();
    /** genie-host's own answers to a phone (Tynn #551): built once its session host is up, below. */
    let phoneApi: HostApi | null = null;
    /** The account book as every client asks it (Tynn #895): set once its parts are composed, below. */
    let accountsPortNow: AccountsPort | null = null;
    const phoneReady = new Set<() => void>();
    bootStep('marketplace and gapps', stepAt);
    const remoteAccessHost = await RemoteAccessHost.open({
        home,
        hostName: hostname(),
        transport: remoteHub,
        build,
        // What a local connection uploads (Tynn #898 step 2d-3b) is staged under this host's runtime, per process.
        createLocalUploads: async () => (await LocalStagingArea.open(home)).createConnection(Date.now),
        // Each window's own snapshot additions, on its connection only (its renderer notice).
        localSnapshot: (connectionId) => protocolTunnels.windowSnapshotOf(connectionId),
        // THE HOST'S OFFER (Tynn #894), read at each hello: its track and build, the wire's schema and the fixed window's
        // floor, and the catalog's elements as capabilities, so a client sees which elements this host has. `host.update`
        // answers with RemoteHost's stub until the launcher step wires it.
        protocol: () => remoteOffer('host', build, catalogCapabilities(catalogService.snapshot().definitions)),
        api: hostRemoteApi({
            hostName: hostname(),
            // What this host answers itself, window or not. The phone's set comes here next (Tynn #551).
            own: { 'updates.state': async () => updatesService.dump(), ...ownTakeOver,
                // The account chips (Tynn #895): this host's book, for every client, window or not.
                ...accountsOwnAnswers(() => accountsPortNow) },
            // Another machine's Take Over window closed: its TUI ends, or its sign-in is cancelled (Tynn #896).
            takeOverEnded: (terminalId) => { takeOverService.ended(terminalId); logins?.cancel(terminalId); hostScratchTerminals.windowClosed(terminalId); },
            // Every remote method and event, window or not (host-alone-api.ts; Tynn #898: none is sent to a window).
            alone: () => phoneApi,
            onAloneReady: listener => { phoneReady.add(listener); return () => { phoneReady.delete(listener); }; },
            workspaceOfAgent: (agentId) => hostRegistry.listAgents().find((a) => a.id === agentId)?.workspaceId ?? null,
            // A workspace share's terminals and folders (Tynn #691): from this host's own terminal host and registry.
            workspaceOfTerminal: terminalWorkspaceOf(terminalHost),
            workspacePaths: workspaceFolders(() => hostRegistry.listWorkspaces()),
        }),
    });
    // OFF BY DEFAULT (Tynn #820): the listener runs only while `remote_access` is on, applied at boot and on every change.
    let remoteAccessService: RemoteAccessService | null = null;
    const remoteSwitch = remoteAccess({ listener: remoteListen, enabled: () => settings.snapshot().remote_access === true, onChange: () => { remoteAccessService?.pushStatus(); void relayHostService.apply(); } });
    remoteAccessService = new RemoteAccessService(remoteAccessHost, {
        switch: { ...remoteSwitch, stop: () => remoteListen.stop() },
        send: (owner, event) => engineRef?.remoteAccessEvent(owner, event),
    });
    settings.onChange((key, _value, workspaceId) => { if (key === 'remote_access' && workspaceId === undefined) void remoteSwitch.apply().catch((error: unknown) => say(`remote: ${error instanceof Error ? error.message : String(error)}`)); });
    // Opening has its own deadline; never mistake a pairing still opening for a signed-out owner.
    const hostTynnBoard = async (): Promise<TynnBoardPorts> => {
        const account = await tynnOpening;
        return { signedIn: () => account.status().signedIn === true, projectFor: workspaceTynnProject, request: (path, init) => account.request(path, init) };
    };
    const readHostTynnPage = async (workspaceId: string, page: unknown, query: unknown) => readTynnPage(await hostTynnBoard(), workspaceId, page, query);
    // ONE cache of each provider's models (core/provider-models.ts): a window's ask and a phone's read the same answer.
    const providerModels = new ProviderModelCache(provider => realListModels(provider, accounts.activeFor(provider)));
    // Tynn #698: each provider CLI MEASURED (the file the agent runs, its version, its own status call), when the host starts:
    // what "installed" and "signed in" read. A CLI that cannot run is said in the log by name.
    // Tynn #477: who each account is, as its provider reports it (never a credential file): at host start, after a login, and
    // whenever a provider's status is measured again.
    // A sign-in per ACCOUNT runs here, in this host; a window only shows its terminal (Tynn #479). Composed once the sessions exist.
    let logins: LoginHost | null = null;
    // Switching accounts = the provider's own login in its one home; no agent is touched (Tynn #753). Composed once the sessions exist.
    let switchAccount: ((provider: string) => AccountSwitchStart) | null = null;
    let switchFlow: AccountSwitchFlow | null = null;
    // SIGN-INS FOR WHOEVER ASKED (Tynn #896): the provider's own login, started here; this machine's window that asked
    // opens it (terminal.window) and its closing cancels the login. Another machine's opens its own with a ticket.
    const signIns = hostSignIns({
        login: (provider, accountId) => logins?.start(provider, accountId) ?? { ok: false, reason: 'Genie’s sign-in is not ready yet; try again in a moment.' },
        switchLogin: (provider) => switchAccount?.(provider) ?? { ok: false, reason: 'Genie’s accounts are not ready yet; try again in a moment.' },
        providerOf: (agentId) => hostRegistry.find(agentId)?.provider ?? null,
        cancel: (terminalId) => logins?.cancel(terminalId),
        openWindow: (context, route, closed) => openCallersTerminalWindow(terminalWindowPorts, context, route, { startedHere: false, ended: closed }),
    });
    // Switch offers (Tynn #481): made from the rate-limit board, composed with it below.
    let switchOffersNow: SwitchOfferService | null = null;
    let headroomFeedNow: HeadroomFeed | null = null;
    let saveBoardNow: (() => void) | null = null;
    let designAuthNow: DesignAuthBook | null = null;
    // Settings → Providers → Accounts (Tynn #484): rename, or forget (the signed-in account refused, saying so); a forgotten
    // account's readings leave the board. Only the book changes; no credential is touched.
    const accountsAct = async (action: AccountsAction): Promise<AccountsActResult> => {
        try {
            if (action.kind === 'rename') await accounts.rename(action.id, action.label);
            else { await accounts.forget(action.id); headroomFeedNow?.forget(action.id); saveBoardNow?.(); }
            return { ok: true };
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    };
    // The header's account chips (Tynn #483): the book, each account's readings from the board, and the standing offers.
    const accountsSnapshot = (): AccountsSnapshot => ({ providers: accountsView(accounts.list(), headroomFeedNow?.accounts() ?? [], Object.fromEntries(ACP_PROVIDERS.map((p) => [p, accounts.activeFor(p).id]))), offers: switchOffersNow?.offers() ?? [], design: designAuthNow?.view() });
    // ...the same book on the one protocol (Tynn #895), answered here for every client.
    accountsPortNow = { list: () => accountsSnapshot(), act: (action) => accountsAct(action), dismissOffer: (id) => switchOffersNow?.dismiss(id) ?? false };
    // WHOSE READING IT IS ACROSS A SIGN-IN (Tynn #753, core/reading-attribution.ts): while who is signed in is read, a provider's
    // readings are held, then shown under the account found; the first after a sign-in or a new active account keeps no earlier
    // window. A new active account tells the window, which re-reads its account chips.
    const readingAttribution = new ReadingAttribution();
    let offerReadingNow: ((provider: string, room: Headroom, stamp: ReadingStamp) => void) | null = null;
    let accountsChangedNow: (() => void) | null = null;
    // A SIGN-IN DONE OUTSIDE GENIE (Tynn #854, identity-watch.ts): who is signed in is asked again, the provider's own way.
    const identityWatch = new IdentityWatch({ refresh: (provider) => accountIdentity.refreshProvider(provider), now: () => Date.now() });
    const accountIdentity = new AccountIdentityReader(accounts, () => realProviderHealthPorts(execFileRunner), say, identityReadHooks({
        attribution: readingAttribution,
        activeId: (provider) => accounts.activeFor(provider).id,
        offer: (provider, room, stamp) => { if (stamp) offerReadingNow?.(provider, room, stamp); },
        changed: () => { accountsChangedNow?.(); },
        read: (provider) => { identityWatch.read(provider); },
    }));
    void accountIdentity.refreshAll();
    // The idle backstop (#854): a provider whose identity was not read for five minutes is read again; checked every minute.
    setInterval(() => { identityWatch.tick(); }, 60_000).unref();
    const providerHealth = new ProviderHealthBook(async provider => {
        if (!isAcpProvider(provider)) throw new Error('Unknown provider account');
        const health = await checkProviderHealth(provider, realProviderHealthPorts(execFileRunner), accounts.activeFor(provider));
        void accountIdentity.refreshProvider(provider);
        return health;
    });
    void providerHealth.refreshAll().then((all) => {
        for (const health of all) if (health?.fault) console.warn(`[provider-health] ${health.provider}: ${health.fault}: ${health.words}`);
    });
    const featureTynn = new TynnAccountService(tynnOpening, { host: TYNN_HOST, recovery: async asked => { await tynnRecovery?.recover(asked); return []; } });
    const featureGithub = new GithubAccountService(githubOpening);
    const featureKeyring = ((service: KeyringService) => { keyringNotices.push((text) => service.setNotice(text)); return service; })(new KeyringService(keychainOpening.then((opened) => opened.keyring, () => null), {
            onReady: () => {
                void tynnOpening.then((account) => account.reload()).catch(() => {});
                void githubOpening.then((account) => account.reload()).catch(() => {});
                void tynnRecovery?.recover({ secretsMoved: true });
            },
        }));
    // OTHER MACHINES: the host dials them, and holds the tokens that open them (P3.4 cut e). One service, the engine
    // link's and genie-host's own owner operations' (Tynn #898 step 2d-3b).
    const deviceLinkService = new DeviceLinkService({
        tokens: deviceTokenStore(join(runtime, 'device-hosts.json'), keychain),
        socket: (url) => deviceSocket(url),
        // To the window connection that owns the channel alone, a frame in pieces (Tynn #941, 2f-2; device-link-protocol.ts).
        send: (owner, event) => { for (const payload of deviceProtocol.events(event)) remoteAccessHost.remote.eventTo(owner, LOCAL_EVENTS.device, payload); },
        log: say,
        /*
         * A PILOT'S CONNECTION TO ANOTHER TYNN WORKSTATION (Tynn #552, host split P5d.4; audit M-e): the grant is minted
         * here with this host's Tynn account, the proof key made and kept here, the relay member opened and renewed
         * here; the window gets a channel. The browser's door to that workstation's sites is here too.
         */
        relay: {
            signedIn: () => tynnAccountNow?.status().signedIn === true,
            // Not known to be a drone: ask Tynn first (beta.61.1); only its own "drone" is refused as one.
            refusal: async () => {
                if (!mayBrowse(relayHostService.role()) && relayHostService.said() === null) await relayHostService.readRole().catch(() => {});
                return connectOutRefusal({ role: relayHostService.role(), said: relayHostService.said(), why: relayHostService.unknownWhy() });
            },
            keypair: () => PopKeypair.generate(),
            mint: (workstationId, jwk) => (tynnAccountNow
                ? mintConnectGrant((path, init) => tynnAccountNow!.request(path, init), workstationId, jwk)
                : Promise.resolve({ ok: false as const, reason: 'sign in to Tynn to connect to a Tynn workstation' })),
            // Through the one socket this host dials with (device-socket.ts): the machine's roots, no redirects.
            open: (input) => openRelayMember({ socket: (url) => deviceSocket(url), ...input }),
        },
        browsers: new RemoteBrowsers(siteDoor),
    });
    /*
     * A REMOTE WINDOW'S TRANSPORT TO ANOTHER MACHINE, ON THE ONE PROTOCOL (Tynn #941, 2f-2): the window asks over its own
     * connection, which owns what it opens. A dial is refused for a drone from the role read here; Tynn's refusal of a grant
     * is worded from a role read again; the relay browser is this machine's, opened here on the caller's own channel.
     */
    const rereadRoleForGrant = async () => { await relayHostService.readRole().catch(() => {}); return relayHostService.role(); };
    const deviceProtocol = deviceLinkProtocol({
        link: deviceLinkService,
        role: { role: () => relayHostService.role(), said: () => relayHostService.said(), why: () => relayHostService.unknownWhy(), reread: async () => { await relayHostService.readRole().catch(() => {}); } },
        wordTynnRefusal: (refusal) => wordTynnRefusal(refusal, rereadRoleForGrant),
        openBrowser: (args) => browserService.call('open', args, 'genie-host'),
        remoteVia: (key, port, ca) => { void browserService.call('remoteVia', [key, port, ca], 'genie-host').catch((error: unknown) => { say(`browser: the door to ${key} could not be updated: ${error instanceof Error ? error.message : String(error)}`); }); },
    });
    const engine = new SessionEngineServer({
        features: featureCallers,
        protocol: protocolTunnels,
        adoptWindowEnv: env => adoptFeatureEnvironment(home, env),
        providerModels: (provider, refresh) => providerModels.get(provider, { refresh }),
        switchOffers: { offers: () => switchOffersNow?.offers() ?? [], dismiss: (id) => switchOffersNow?.dismiss(id) ?? false },
        // The header's account chips (Tynn #483): the book, each account's readings from the board, and the standing offers.
        accountsAct: (action) => accountsAct(action),
        accounts: () => accountsSnapshot(),
        refreshAccountIdentity: provider => isAcpProvider(provider) ? accountIdentity.refreshProvider(provider) : Promise.resolve(),
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
        cloneOffers: cloneOffersService,
        plugins: pluginsService,
        marketplace: marketplaceHost,
        ...(gappBook ? { gapps: gappsApi(gappBook, gappAsk, gappPreviews ?? undefined), gappsChanged: (listener) => gappBook!.onChange(listener) } : {}),
        ...(gappBook && gappServer ? { gappSessions: gappSessions(gappBook, gappServer, gappPreviews ? { previews: gappPreviews, ask: gappAsk } : undefined) } : {}),
        catalog: catalogService,
        flows: flowsService,
        browser: browserService,
        updates: updatesService,
        remoteAccess: remoteAccessService,
        stores,
        keychain,
        // THE TYNN ACCOUNT (P3.4 cut c). Opening asks Tynn who it is, so it is not awaited here: the host's boot does not wait on the network.
        tynn: featureTynn,
        github: featureGithub,
        // THIS MACHINE'S KEY IS HERE (P3.4). The relay is the window's until P5, so it asks this to sign.
        // Nothing of Genie's goes into a folder the person has not trusted (genie#1519), whichever window asked.
        configSync: async (asked) => ((await hostMayWriteInto(asked.workspacePath)) ? withConfig(asked.workspacePath, () => writeWorkspaceConfig(asked)) : []),
        workstation: workstationService,
        relayHost: relayHostService,
        takeOver: takeOverService,
        // THE KEYRING CARD READS THIS HOST (P3.4 cut c). When the keychain comes to answer, what reads secrets reads again, with nobody restarting anything.
        keyring: featureKeyring,
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
            v1DatabasePath = databasePath;
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
        tynnPages: { read: readHostTynnPage },
        files: {
            subscribe: (owner, viewId, workspace, want) => files?.subscribe(owner, viewId, workspace, want),
            unsubscribe: (owner, viewId) => files?.unsubscribe(owner, viewId),
            dropOwner: (owner) => files?.dropOwner(owner),
        },
    });
    engineRef = engine;
    // The watch runs on a thread of its own (Tynn #524): a build's thousands of changes never hold this host's loop.
    // THE FILE PANEL, AS GENIE-HOST'S OWN ANSWERS WATCH IT (Tynn #898 step 2d-3b): the same hub, under its own owner; a
    // batch feeds its files host's record of disk changes, as a window's main fed its own.
    const hostFilesWatches = hostFilesWatch({ hub: () => files, workspace: (id) => hostRegistry.workspace(id) ?? null, recordDiskChanges: (id, changes) => phoneFiles.recordDiskChanges(id, changes), log: say });
    files = new FilesWatchHub({ source: workerWatchSource({ log: say }), send: ownerRoute(hostFilesWatches.deliver, (owner, event) => engine.filesEvent(owner, event)), workspaceVisible: (id) => { const w = hostRegistry.workspace(id); return !!w && w.asleep !== true; }, gitTree: gitTreeStatus, repoStatus, log: say });
    stores.onEvent((event) => { if (event.store === 'registry') files?.visibilityChanged(); });
    const engineHostOptions = engine.hostOptions();
    // GENIE INSTALLS ITS PLAYWRIGHT BROWSERS ITSELF (Tynn #846): the stable set at launch when it has none, a version a
    // project pins when its agents start, a version an agent asks for. One at a time; quiet in the log; a failure is a Deck item.
    const playwrightToolchain = join(home, 'genie2-toolchain');
    const playwrightInstaller = new PlaywrightInstaller({
        install: (version, browsers) => installPlaywrightBrowsers(version, browsers, true, {
            platform: process.platform as 'win32' | 'linux' | 'darwin', toolchainDir: playwrightToolchain, fs: nodePlaywrightFs(),
            run: (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 30 * 60_000, ...(options?.env ? { env: options.env } : {}) }),
            progress: (step) => { if (step !== null) say(`playwright: ${step}`); },
        }),
        ready: () => readyOnDisk({ toolchainDir: playwrightToolchain, fs: nodePlaywrightFs() }),
        enabled: () => autoInstallEnabled(process.env[PLAYWRIGHT_AUTO_INSTALL_ENV]),
        // What Genie starts from now on uses the set just installed, without a restart (Tynn #845).
        onInstalled: () => { applyPlaywrightEnv({ env: processEnv, fs: nodeToolchainFs(), dataDir: playwrightToolchain }); },
        now: () => Date.now(),
        log: say,
    });
    // After the host is up, not during it: a download competes with nothing the person is waiting for.
    const playwrightAtLaunch = setTimeout(() => { void playwrightInstaller.ensureAtLaunch(); }, 20_000);
    playwrightAtLaunch.unref();
    // GENIE'S PLAYWRIGHT (Tynn #604): the browsers path is Genie's own environment; the server and a workspace's endpoint are made here, on demand.
    const playwrightHost = new PlaywrightHost({
        toolchainDir: join(home, 'genie2-toolchain'),
        server: {
            supervisor: processSupervisor, workspaceId: 'genie', cwd: home,
            cliDir: (version) => join(home, 'genie2-toolchain', 'playwright', 'cli', version),
            allocatePort: playwrightServerPort,
            mintToken: () => randomBytes(32).toString('base64url'),
            now: () => Date.now(),
            connections: (port) => osConnections(port, process.platform, async (binary, args) => { const r = await execFileRunner(binary, args, { timeoutMs: 10_000 }); return { exitCode: r.exitCode, stdout: r.streams.stdout }; }),
            idleMs: 10 * 60_000, pidAlive: osPidAlive, /* a server that will not exit is ended with all it started, by the process tree rules (never taskkill /T) */ forceEnd: (pid) => endChildTrees([{ pid, exitCode: null, signalCode: null, kill: () => { try { process.kill(pid); return true; } catch { return false; } }, once: () => undefined }], systemProcessTree),
        },
        workspacePath: (id) => hostRegistry.workspace(id)?.path ?? null,
        optIn: (id) => settings.snapshotFor(id).playwright_server !== false,
        fs: nodePhpVersionsFs(),
        platform: process.platform as 'win32' | 'linux' | 'darwin',
        link: (target, path, kind) => { symlinkSync(target, path, kind); },
        installer: { ensure: (version) => (playwrightInstaller.byItself() ? playwrightInstaller.ensure(version) : null), installing: () => playwrightInstaller.installing() },
        // A workspace not yet trusted triggers no install (Tynn #846 review): the verdict as last read, as `sites`/`services` read it.
        trusted: (workspaceId) => !hostUntrustedNow({ workspaceId }),
    });
    const playwrightSweep = setInterval(() => { void playwrightHost.server.sweep().catch(() => {}); }, 60_000);
    playwrightSweep.unref();
    // Every provider's rate limits, kept here whether or not a window is open (core/headroom-board.ts).
    const headroomFeed = new HeadroomFeed(() => headroomBufferMs(settings.snapshot()));
    headroomFeedNow = headroomFeed;
    // A reading as shown: to this board and to the window's (main's), stamped with whose it is (readingAttribution above).
    const offerReading = (provider: string, room: Headroom, stamp?: ReadingStamp): void => { headroomFeed.offer(provider, room, stamp); engineHostOptions.onHeadroom(provider, room, stamp); };
    offerReadingNow = offerReading;
    // CLAUDE DESIGN'S AUTHORIZATION, ONE FOR THE MACHINE (Tynn #480, core/design-auth.ts): Authorized only after the call
    // that needed it succeeds. Kept on disk; a change tells the windows to read the accounts again.
    const designAuthFile = join(home, 'claude-design-state.json');
    const designAuth = new DesignAuthBook(
        () => { try { return JSON.parse(readFileSync(designAuthFile, 'utf8')); } catch { return undefined; } },
        (state) => { try { writeFileSync(designAuthFile, JSON.stringify(state)); } catch (error) { say(`Claude Design: could not save its state: ${error instanceof Error ? error.message : String(error)}`); } },
    );
    designAuthNow = designAuth;
    designAuth.onChange(() => { engine.callback({ name: 'toolSignal', signal: { kind: 'accounts-changed' } }); });
    accountsChangedNow = () => { engine.callback({ name: 'toolSignal', signal: { kind: 'accounts-changed' } }); };
    // EACH ACCOUNT'S LAST READINGS SURVIVE A RESTART (Tynn #485): how an idle account's room is known. Read here, written as they change.
    const headroomBoardFile = join(home, 'headroom-board.json');
    headroomFeed.restore(((): unknown => { try { return JSON.parse(readFileSync(headroomBoardFile, 'utf8')); } catch { return []; } })());
    const saveHeadroomBoard = (): void => { try { writeFileSync(headroomBoardFile, JSON.stringify(headroomFeed.snapshot())); } catch (error) { say(`rate limits: could not save the board: ${error instanceof Error ? error.message : String(error)}`); } };
    headroomFeed.subscribe(saveHeadroomBoard);
    saveBoardNow = saveHeadroomBoard;
    // RATE-LIMIT ALERTS (Tynn #748, core/limit-alerts.ts): the person's thresholds are read at each reading; what fired is kept
    // on disk so a restart does not tell a crossing twice. The window plays the sound the alert names and shows the notice.
    const limitAlertsFile = join(home, 'limit-alerts-armed.json');
    // What a fired alert leaves for a window that is not open (Tynn #748): a Deck item, kept on disk until dismissed or its
    // window resets. The sound is only ever the live signal; opening a window later replays nothing.
    const limitNoticesFile = join(home, 'limit-alert-notices.json');
    // A TURN ENDED AS STALLED (Tynn #855): its Deck item, with Stop and Restart; the plan keepalive's watchdog records it.
    const stalledTurns = new StalledTurnBook();
    const limitNotices = new LimitNoticeBook(
        () => { try { return JSON.parse(readFileSync(limitNoticesFile, 'utf8')); } catch { return []; } },
        (notices) => { try { writeFileSync(limitNoticesFile, JSON.stringify(notices)); } catch (error) { say(`rate-limit alerts: could not save the notices: ${error instanceof Error ? error.message : String(error)}`); } },
    );
    const limitAlerts = new LimitAlertService({
        load: () => { try { return JSON.parse(readFileSync(limitAlertsFile, 'utf8')); } catch { return {}; } },
        accounts: () => headroomFeed.accounts(),
        alerts: () => parseLimitAlerts(settings.snapshot()[LIMIT_ALERTS_SETTING]),
        nameOf: (accountId, provider) => accounts.get(accountId)?.label ?? provider,
        save: (state) => { try { writeFileSync(limitAlertsFile, JSON.stringify(state)); } catch (error) { say(`rate-limit alerts: could not save what is armed: ${error instanceof Error ? error.message : String(error)}`); } },
        emit: (signal) => { limitNotices.record(signal); engine.callback({ name: 'toolSignal', signal }); },
    });
    // Checked whenever the feed shows a reading (one inside its buffer reaches nothing), so onHeadroom below stays S5's wiring.
    // SWITCH OFFERS (Tynn #481, core/switch-offer.ts): the ACTIVE account's chosen window near its limit makes one offer per
    // window per reset, suggesting another known account with room. Only offered: a switch is the person's own sign-in.
    // What has been offered and what still stands survive a restart (Tynn #485).
    const switchOffersFile = join(home, 'switch-offers.json');
    const switchOffers = new SwitchOfferService({
        load: () => { try { return JSON.parse(readFileSync(switchOffersFile, 'utf8')); } catch { return undefined; } },
        save: (state) => { try { writeFileSync(switchOffersFile, JSON.stringify(state)); } catch (error) { say(`switch offers: could not save them: ${error instanceof Error ? error.message : String(error)}`); } },
        readings: () => headroomFeed.accounts(),
        known: () => accounts.list().map((a) => ({ id: a.id, provider: a.provider, label: a.label })),
        active: () => Object.fromEntries(ACP_PROVIDERS.map((p) => [p, accounts.activeFor(p).id])),
        choice: () => settings.snapshot()[SWITCH_OFFER_WINDOWS_SETTING],
    });
    switchOffersNow = switchOffers;
    headroomFeed.subscribe(() => { limitAlerts.check(); switchOffers.check(); });
    bootStep('remote and genie 1 imports', stepAt);
    await lockIdentity;
    bootStep('lock identity', stepAt);
    // THE PLAN KEEPALIVE (Tynn #754): built below, once the host exists; a turn that ends before then has nothing to nudge.
    let planKeepalive: HostPlanKeepalive | null = null;
    // A SESSION WITHOUT ITS GENIE OR TYNN SERVER (genie#1202) is recovered HERE (Tynn #896, 2b-3), window or no window: a
    // line in its chat, the graceful restart on the same conversation, spaced, given up on in words. The servers it saw are
    // kept on its record (Tynn #628).
    const mcpRecovery = hostMcpRecovery({
        notice: (id, text) => { host.notice(id as AgentId, text); },
        restart: (id) => trustRestart(id as AgentId),
        noteSeen: (id, names) => { void phoneRegistryNow?.noteMcpSeen(id as AgentId, names).catch(() => undefined); },
        now: () => Date.now(),
        later: (run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer); },
    });
    const host = new SessionHost({
        activeAccount: provider => isAcpProvider(provider) ? accounts.activeFor(provider) : null,
        userData: home,
        ...engineHostOptions,
        // An agent's record, read per call (genie#1188), from this host's own registry: no window pushes records (Tynn #954).
        currentRecord: (id) => hostRegistry.find(id as AgentId) ?? null,
        // The window still plays the sound; the host decides whether the agent is nudged (it no longer asks a window to).
        onAction: (agentId, kind) => { engineHostOptions.onAction(agentId, kind); if (kind === 'replied') planKeepalive?.turnEnded(agentId, 'replied'); },
        onTurnEnd: (agentId, cause) => { planKeepalive?.turnEnded(agentId, cause); },
        onDesignAuth: (_agentId, event) => designAuth.apply(event),
        onPersonTurn: (agentId) => { planKeepalive?.personTurn(agentId); },
        serviceEnvFor: (workspaceId) => ({ ...engineHostOptions.serviceEnvFor(workspaceId), ...playwrightHost.envFor(workspaceId) }),
        // Interrupt or Stop this turn ends the agent's own Genie tool calls at once (Tynn #702).
        endToolCalls: (agentId, intent) => toolCalls.end(agentId, intent),
        // What the agent's workspace has off by default (Tynn #628), read from the registry at each launch.
        workspaceMcpOffFor: (record) => hostRegistry.workspaceMcpOff(record.workspaceId),
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
        // WHICH ACCOUNT A HELD LOGIN IS ON (Tynn #699): the provider's own status command, read while a login is held; a
        // different account releases the agents held on it. Nothing to tell it by = no change.
        rateLimit: {
            accountOf: async (provider) => {
                if (!isAcpProvider(provider)) return null;
                const command = statusCommandFor(provider, providerBinary(provider as AgentRecord['provider']) ?? null);
                if (command === null) return null;
                const r = await execFileRunner(command, [], { shell: true, cwd: home, timeoutMs: 30_000 });
                return r.exitCode === 0 ? accountIdentityFrom(r.streams.stdout) : null;
            },
        },
        onThreadId: (agentId, threadId) => { threadsHeard.set(agentId, threadId); engineHostOptions.onThreadId(agentId, threadId); },
        // A linked window still hears the report; the recovery is the host's own (above).
        onMcpServers: withMcpRecovery(engineHostOptions.onMcpServers, mcpRecovery),
        // A reading is stamped with whose it is; one after a while with no read of who is signed in asks again first (#854).
        onHeadroom: headroomArrival({ watch: identityWatch, attribution: readingAttribution, offer: offerReading }),
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
            phase: (agentId, run, phase) => { lifecycleLog(`agent start owner=${agentId} run=${run} phase=${phase}`); },
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
    // SWITCH ACCOUNT (Tynn #753): the provider's own login, in its one home, in a terminal with the steps on screen. No agent is
    // stopped or started again; when the login ends the identity read (onSignedIn below) records which account is signed in.
    // S9 (Tynn #482): the switch runs through the flow, which reads who is signed in once its login is over and tells every
    // window which account is active, or that nothing changed (with Retry).
    switchAccount = (provider) => switchFlow?.start(provider) ?? { ok: false, reason: 'Genie’s sign-in is not ready yet; try again in a moment.' };
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
    // `Log in` for one ACCOUNT (Tynn #479): its own terminal and folder, its own status in that account's home. Signed in, THAT
    // account's signed-out agents restart and that account's hold opens; another account's agents are never touched.
    logins = new LoginHost({
        accountFor: (provider, accountId) => {
            if (!isAcpProvider(provider)) return null;
            return accountId === undefined ? accounts.activeFor(provider) : accounts.get(accountId);
        },
        scratch: () => hostScratch.directory(),
        terminals: terminalHost,
        // Where the window shows it is the window's: a person's click opens the route this returns the terminal for.
        openWindow: () => {},
        binaryFor: (provider) => providerBinary(provider as AgentRecord['provider']) ?? null,
        runStatus: (command, cwd) => execFileRunner(command, [], { shell: true, cwd, timeoutMs: 30_000 }).then((r) => r.exitCode, () => 1),
        onSignedIn: (provider) => {
            // ONE HOME PER PROVIDER (Tynn #753): who is signed in is READ (S4) and recorded first: the book's active account is the
            // one now signed in, usage counts against it, and a hold lifts if that account has headroom. No agent is stopped or
            // started again; only the agents the provider had signed out are brought back.
            readingAttribution.signedIn(provider);
            void providerHealth.refresh(provider);
            void (isAcpProvider(provider) ? accountIdentity.refreshProvider(provider) : Promise.resolve()).then(() => {
                afterSignedIn(provider, {
                    signedOutAgents: (p, id) => host.signedOutAgents(p, id),
                    restart: (id) => { void trustRestart(id as AgentId).then((r) => { if (r.ok) host.prompt(id as AgentId, SIGNED_IN_AGAIN, 'genie'); }); },
                    resumeLimit: (p, id) => host.resumeLimit(p, id),
                });
            });
        },
        // CLAUDE DESIGN (#1081): no status to ask, so the agents that waited are told it was RUN and to retry.
        onDesignLoginEnded: () => { designAuth.apply({ kind: 'login-ended' }); tellDesignLoginRan(host); },
        // A switch's login is over (Tynn #482): the flow reads who is signed in and says so.
        onSwitchEnded: (provider, signedIn) => { void switchFlow?.settle(provider, signedIn); },
    });
    const switchLogin = logins;
    switchFlow = new AccountSwitchFlow({
        login: switchLogin,
        active: (provider) => { const a = isAcpProvider(provider) ? accounts.activeFor(provider) : null; return a ? { id: a.id, label: a.label } : { id: '', label: provider }; },
        readIdentity: (provider) => { if (!isAcpProvider(provider)) return Promise.resolve(); readingAttribution.signedIn(provider); return accountIdentity.refreshProvider(provider); },
        emit: (outcome) => { engine.callback({ name: 'toolSignal', signal: accountSwitchSignal(outcome) }); },
    });
    const phoneRegistry = phoneRegistryNow = new Registry(new HostRegistryStore({ call: (store, method, args) => stores.call(store, method, args), registryDropped: () => registryStore.dropped }));
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
    const featureDeckItems = () => assembleDeckItems({
        workspaces: hostRegistry.listWorkspaces(),
        workspaceName: workspaceNameFor,
        approvals: approvals.deckItems(),
        trust: hostingStack?.trustDeckItems() ?? [],
        notices: [...limitNotices.items(Date.now()), ...playwrightInstaller.items(), ...stalledTurns.items()],
        attention: own.attention,
        inbox: own.inbox,
        agents: phoneAgents(), workspaceColor: path => workspaceColors.colorOf(path),
        asker: askerLiveFrom({ known: () => true, engine: () => host, takeOvers: () => takeOverHost }),
    });
    phoneRegistry.setDeckSource(featureDeckItems);
    // What this host can measure itself: mail agents have not collected, the OS agent working, and GitHub blocking (its own
    // GitHub account, Tynn #959). Flows in flight are the window's to say (Tynn #551 notes it); with no window they read none.
    phoneRegistry.setSignals(() => ({
        flowsRunning: 0,
        uncollectedMail: hostRegistry.listAgents().reduce((n, a) => n + own.inbox.unread(a.id).length, 0),
        githubBlocked: (githubAccountNow?.view().signal ?? null) !== null,
        osAgentWorking: (() => { const os = hostRegistry.listAgents().find(isOsAgent); return os ? host.probe(os.id)?.turnState === 'working' : false; })(),
    }));
    // Its snapshot follows the stores and the sessions, coalesced as the window's is, and only while no window is
    // connected: a snapshot is built on every touch, and with a window open the window answers.
    // The estate every remote client hears, pushed whether or not a window is connected (Tynn #898).
    const phoneEstate = new Coalescer<'estate'>({ intervalMs: AGENT_PUSH_INTERVAL_MS, flush: () => { phoneRegistry.touch(); }, schedule: realSchedule, now: () => Date.now() });
    const phoneTouch = () => { phoneEstate.request('estate'); };
    stores.onEvent((event) => { if (event.store === 'registry') void phoneRegistry.refresh(); else phoneTouch(); });
    host.subscribe(() => phoneTouch());
    approvals.onChange(phoneTouch);
    takeOverHost.onChange(phoneTouch);
    const phoneFiles = new FilesHost({
        // DELETE GOES TO THE OS TRASH (Tynn #844), never an erase: Electron's, so a window on this machine does it (step
        // 2d-4b, a window-local client operation). This host has confined the path; the window checks it again.
        trash: async (absolutePath) => { if (!engineRef) throw new Error('Genie is still starting; try again in a moment'); await engineRef.windowOp(null, 'trash', [absolutePath]); },
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
    const featureFilesHealth = new AgentFilesHealth();
    const featureFiles = featureWorkspaceFiles({ mayWriteInto: hostMayWriteInto, settings, health: featureFilesHealth,
        tools: () => mcp?.status().tools ?? [], tracking: () => tynnAccountNow?.status().signedIn ? 'tynn' : 'files' });
    const featureConfig = async (workspacePath: string, source: import('../core/agent-files-health.js').SyncSource = 'start') => {
        if (!await hostMayWriteInto(workspacePath)) return [];
        const endpoint = mcp?.endpoint();
        if (!endpoint) {
            const reason = 'Genie has no MCP endpoint yet (the server is not listening); nothing to write into the workspace';
            featureFilesHealth.config(workspacePath, [{ label: 'Genie MCP', ok: false, error: reason }], Date.now(), source);
            throw new Error(reason);
        }
        const values = settings.snapshot();
        const results = await withConfig(workspacePath, () => writeWorkspaceConfig({ workspacePath, endpoint, flags: {
            mcp_sync_claude: values.mcp_sync_claude !== false, mcp_sync_cursor: values.mcp_sync_cursor !== false,
            mcp_sync_codex: values.mcp_sync_codex !== false, mcp_sync_hooks: values.mcp_sync_hooks !== false,
        } }));
        featureFilesHealth.config(workspacePath, [...results], Date.now(), source);
        return results;
    };
    const featureIssueWatch = new IssueWatchReplica((method, args) => issueWatch.call(method, args));
    featureIssueWatch.apply({ kind: 'dump', dump: issueWatch.dump() });
    issueWatch.onEvent(event => { featureIssueWatch.apply(event); featureChanged(); });
    const featureFirewallReader = firewallReader(() => readFirewallRule(REMOTE_PORT), { minIntervalMs: 5000 });
    const proxyMemoryNow = await proxyMemory;
    const downloadFeature = featureDownload({ proxyRoutes: url => (proxyMemoryNow?.routesFor(url) ?? [{ kind: 'direct' }]) });
    // TAILSCALE, LIVE (Tynn #748, #749): one installer per Install, read again on its own while Genie waits for it to be
    // installed or signed in, and remote access applied the moment it is connected: never a relaunch to notice it.
    const tailscaleNow = tailscaleLive({ probe: () => getTailscaleStatus(), install: () => installTailscale({ download: url => downloadFeature(url) }),
        up: () => tailscaleUp(), online: () => remoteSwitch.apply(), changed: () => featureChanged(), say });
    void tailscaleNow.refresh();
    const featureNative = nativeFeatureToolchain({ home, providerHealth, download: downloadFeature, busy: step => hostFeatures?.busy(step),
        activity: async () => ({
            sessions: hostRegistry.listAgents().filter(a => host.probe(a.id)?.running === true).map(a => ({ label: a.name, provider: a.provider })),
            processes: processSupervisor.list().filter(p => p.state === 'running' || p.state === 'restarting').map(p => ({ id: p.id, label: p.name, command: processSupervisor.command(p.id) ?? '' })),
            engines: (await hostingStack?.engineStatuses() ?? []).filter(e => e.status === 'running').map(e => e.instance.containerName ?? `${e.instance.engine} ${e.instance.version}`),
        }),
    });
    // A WORKSPACE'S STORAGE (Tynn #697): measured off this thread (main/dir-size.ts), pushed when done; every Move, Restore
    // and Empty re-validated by the host module and followed by a fresh measure, so the tab shows what is on disk now.
    // A Move or Empty runs on its own with its progress in the view, ends with a result naming each failure, and every
    // step is a line in this log (Tynn #947: main/storage-feature-port.ts).
    const storageRoot = (id: string): string => {
        const w = hostRegistry.workspace(id);
        if (!w || w.asleep === true) throw new Error('That workspace is not open on this machine.');
        return w.path;
    };
    const chatFilesOf = async (id: string): Promise<ChatFile[]> => {
        const out: ChatFile[] = [];
        for (const a of hostRegistry.listAgents().filter(agent => agent.workspaceId === id)) {
            for (const f of await threadAttachmentFiles(sessionsDir(home), a.id)) out.push({ agentId: a.id, agentName: a.name, attachmentId: f.id, path: f.path, bytes: f.bytes });
        }
        return out;
    };
    // WHAT IS WORKING WHERE (Tynn #946): a worktree a terminal, a running process or a running agent is in is never offered.
    const storageInUse = (): InUseFolder[] => [
        ...terminalHost.list().flatMap(t => (t.cwd ? [{ path: t.cwd, by: `a terminal (${basename(t.shell)})` }] : [])),
        ...processSupervisor.list().filter(p => p.state === 'running' || p.state === 'restarting')
            .flatMap(p => { const cwd = processSupervisor.cwd(p.id); return cwd ? [{ path: cwd, by: `the process ${p.name}` }] : []; }),
        ...hostRegistry.listAgents().filter(a => host.probe(a.id)?.running === true)
            .flatMap(a => { const w = hostRegistry.workspace(a.workspaceId); return w ? [{ path: w.path, by: `the agent ${a.name}` }] : []; }),
    ];
    const storagePort: NonNullable<MachineFeaturePorts['storage']> = storageFeaturePort({
        storage: new WorkspaceStorage(), root: storageRoot, chatFiles: chatFilesOf, inUse: storageInUse, changed: () => featureChanged(), log: say,
    });
    const featureEffects: MachineFeaturePorts = {
        storage: storagePort,
        tynnAccount: {
            status: () => featureTynn.dump().status, host: () => featureTynn.dump().host,
            unreachableThrough: () => featureTynn.dump().unreachableThrough, onChange: listener => featureTynn.onEvent(listener),
            startSignIn: async () => (await tynnOpening).startSignIn(),
            signIn: async code => (await tynnOpening).signIn(code), signOut: async () => (await tynnOpening).signOut(),
        },
        githubAccount: {
            view: () => featureGithub.dump().view ?? signedOutGithubView(null),
            startSignIn: async () => (await githubOpening).startSignIn(null),
            cancelSignIn: () => { void githubOpening.then(account => account.cancelSignIn()).catch(say); },
            signOut: async () => (await githubOpening).signOut(), refresh: async () => (await githubOpening).refresh(),
            openPage: async () => { throw new Error('this action needs its caller’s own admitted local window'); },
            onChange: listener => featureGithub.onEvent(listener),
        },
        keyring: { view: () => featureKeyring.dump().view, notice: () => featureKeyring.dump().notice ?? null,
            fix: async () => { await featureKeyring.call('fix', []); }, cancel: async () => { await featureKeyring.call('cancel', []); } },
        issueWatch: () => featureIssueWatch.panels(hostRegistry.listWorkspaces(), workspaceTynnProject, Date.now()),
        issueWatchRefresh: id => issueWatch.call('refresh', [id]), issueWatchSetRepo: (id, owner, repo, change) => issueWatch.call('setRepo', [id, owner, repo, change]),
        toolchain: featureNative,
        tailscale: { status: () => tailscaleNow.status(), up: () => tailscaleNow.up(), install: () => tailscaleNow.install(), refresh: () => tailscaleNow.look() },
        ...(process.platform === 'win32' ? { firewall: { rule: () => featureFirewallReader.rule(), refresh: () => featureFirewallReader.refresh(),
            reread: () => featureFirewallReader.reread(), allow: () => ensureFirewallRule(REMOTE_PORT), remove: () => removeFirewallRule() } } : {}),
        remoteAccess: { apply: () => remoteSwitch.apply(), restart: () => remoteSwitch.restart() },
        tynnWorkstation: () => { const view = relayHostService.status(); return view.workstation?.registered ? { ...view.workstation, relay: view.relay } : view.workstation; },
        appVersion: () => hostAppVersion,
        whatsNew: shown => whatsNewFor(hostAppVersion, String(settings.get('whats_new_seen_version') ?? ''), RELEASE_NOTES, shown),
    };
    const machineEvents = (listener: () => void) => {
        featureChanges.add(listener);
        const offs = [featureTynn.onEvent(listener), featureGithub.onEvent(listener), featureKeyring.onEvent(listener),
            pluginsService.onEvent(listener), catalogService.onEvent(listener), remoteAccessHost.onChange(listener),
            own.attention.onChange(listener), limitNotices.onChange(listener), playwrightInstaller.onChange(listener), stalledTurns.onChange(listener), approvals.onChange(listener), stores.onEvent(listener)];
        return () => { featureChanges.delete(listener); for (const off of offs) off(); };
    };
    hostFeatures = new HostFeatures({ lifecycleLog, signIn: (provider, context) => signIns.loginFor(provider, context), slowPart: { ms: 1_000, log: (part, ms) => lifecycleLog(`features slow part=${part} ms=${ms}`) }, settings, knowledge: own.knowledge, inbox: own.inbox, attention: own.attention, flows: hostFlows,
        roster: () => hostRegistry.listAgents(), workspaceSlugs: () => hostRegistry.workspaceSlugs(), resolveAddress: address => resolveOnRoster(address, hostRegistry.listAgents(), hostRegistry.workspaceSlugs()),
        mailRefusal: address => hostRegistry.mailRefusal(address), workspaceIds: () => hostRegistry.listWorkspaces().map(w => w.id),
        runFlow: id => hostFlows.runNow(id), stopFlow: id => hostFlows.stopRun(id), resumeAgentLimit: id => { const record = hostRegistry.find(id); if (record) host.resumeLimit(record.provider); }, refreshPlugins: async () => { await pluginsService.call('refresh', []); }, applyRemote: () => remoteSwitch.apply(),
        ...(hostingStack ? { hosting: { api: hostingStack, supervisor: processSupervisor, processes: hostBook,
            processScheduler: { runNow: id => hostBook.runNow(id) }, workspaceVisible: id => !hiddenWorkspaces().includes(id) } } : {}),
        machine: {
            services: { remote: remoteAccessHost.remote, pairing: remoteAccessHost.pairing, pluginsDir: join(home, 'plugins'),
                catalogDefinitions: () => catalogService.snapshot().definitions,
                plugins: { list: () => pluginsService.dump().entries, setEnabled: async (id, enabled) => await pluginsService.call('setEnabled', [id, enabled]) as boolean,
                    setNetworkAllowed: async (id, enabled) => await pluginsService.call('setNetworkAllowed', [id, enabled]) as boolean },
                workspaceTrust: { trust: async id => { if (!hostingStack) throw new Error('workspace trust is not ready'); return hostingStack.trust.trust(id); },
                    untrust: async id => { if (!hostingStack) throw new Error('workspace trust is not ready'); return hostingStack.trust.untrust(id); } },
                integrations: () => { const status = mcp?.status(); return { mcp: { url: status?.endpoint?.url ?? null, verified: status?.verified ?? null, tools: status?.tools ?? [] }, agentFiles: featureFilesHealth.list() }; },
                syncAgentDocs: featureFiles.syncAgentDocs, syncConfig: featureConfig,
            }, effects: featureEffects, onChange: machineEvents,
            effectsFor: context => { const ui = featureCallers.presentation(context); return { ...featureEffects,
                tynnAccount: { ...featureEffects.tynnAccount!, startSignIn: async () => { const answer = await (await tynnOpening).startSignIn(); if (ui?.openExternal) await ui.openExternal(answer.url); return answer; } },
                githubAccount: { ...featureEffects.githubAccount!, startSignIn: async () => (await githubOpening).startSignIn(ui?.openExternal ?? null) },
                tailscale: { ...featureEffects.tailscale!, up: async () => { const answer = await featureEffects.tailscale!.up(); if (answer.authUrl) { if (!ui?.openExternal) throw new Error('Tailscale needs a sign-in; open Genie on this machine and Connect there'); await ui.openExternal(answer.authUrl); } return answer; } },
            }; },
        },
        presentation: context => { const ui = featureCallers.presentation(context); return ui ? { ...ui,
            githubOpen: async target => (await githubOpening).openPage(target, async url => { if (!ui.openExternal) throw new Error('this window cannot open GitHub'); await ui.openExternal(url); }),
            tailscaleInstall: async () => { const answer = await featureEffects.tailscale!.install(); if (answer.url) { if (!ui.openExternal) throw new Error('this window cannot open the installer page'); await ui.openExternal(answer.url); } return answer; },
        } : null; },
        system: { safeMode: { leave: async () => { safeMode.leave(); return { ok: true }; } }, hangNotice: {
            dismiss: async () => { crashState.dismiss(); return { ok: true }; }, stopAll: async () => { await host.stopAll(); return { ok: true }; } } },
        deck: { attention: own.attention, approvals, inbox: own.inbox, deckItems: featureDeckItems,
            limitNotices,
            playwrightNotices: { retry: (id) => playwrightInstaller.retry(id), dismiss: (id) => playwrightInstaller.dismiss(id) },
            // A stalled turn's Stop / Restart / Dismiss (Tynn #855): on this host's session host; Restart is the one Restart.
            stalledTurns: { act: async (agentId, action) => {
                if (!stalledTurns.has(agentId)) return false;
                if (action === 'stop') await host.stop(agentId as AgentId);
                if (action === 'restart') {
                    if (!phoneApi) throw new Error('Genie’s agents are still starting; try again in a moment');
                    const restarted = await phoneApi.invoke('agents.restart', [agentId, 'graceful']) as { ok: boolean; reason?: string } | null;
                    if (restarted && restarted.ok === false) throw new Error(restarted.reason ?? 'the restart was refused');
                }
                stalledTurns.clear(agentId);
                return true;
            } },
            deliverToAgent: (id, text) => host.deliver(id as AgentId, text, 'you'),
            ...(hostingStack ? { trustCertificate: () => hostingStack.trustCertificate(), deferTrustCertificate: () => hostingStack.deferTrustCertificate(), syncHosts: () => hostingStack.syncHosts(), deferHosts: () => hostingStack.deferHosts() } : {}),
        },
    });
    // A shell sees the workspace's service variables and Genie's MCP endpoint: an agent's, and the person's (Tynn #898).
    const shellEnv = (workspaceId: string): Record<string, string> => {
        const endpoint = mcp?.endpoint() ?? null;
        return { ...engine.serviceEnvFor(workspaceId), ...playwrightHost.envFor(workspaceId), ...(endpoint ? { GENIE_MCP_URL: endpoint.url, GENIE_MCP_TOKEN: endpoint.token } : {}) };
    };
    /*
     * THE ONE-TIME MOVE, ON THIS HOST'S SIDE (Tynn #959, 2g-3b; host-legacy-adopt.ts): the same book an older Genie's window
     * wrote, this host's keychain. Something moved, or Genie 1's record came: this host reads its accounts again, registers
     * the workstation with that record, and brings its agents back to Tynn, by itself.
     */
    const legacyAdopt = hostLegacyAdopt({
        vault: hostVault(keychain),
        book: fileMigrationBook(join(home, 'keychain-migration.json'), { log: (line) => { say(line); lifecycleLog(line); } }),
        log: (line) => { say(line); lifecycleLog(line); },
        moved: ({ secretsMoved, genie1Identity }) => {
            if (secretsMoved) void githubOpening.then((account) => account.reload()).catch(() => {});
            void tynnOpening.then((account) => (secretsMoved ? account.reload() : undefined)).catch(() => {}).finally(() => {
                void relayHostService.register(genie1Identity).catch(() => {});
                if (secretsMoved) void tynnRecovery?.recover({ secretsMoved: true });
            });
        },
    });
    phoneApi = hostAloneApi({
        hostName: hostname(),
        features: hostFeatures,
        registry: phoneRegistry,
        engine: () => host,
        cwdFor: phoneCwd,
        // The sign-ins (Tynn #896): the provider's own login, started here for the caller, whose window shows it.
        signIns,
        // A PROVIDER'S PROGRAM (Tynn #577; #897 2c-3): the .exe the owner picked on this host's disk, from any of their
        // windows, written to this host's own choice file (the one its agents start from); the provider is read again.
        // The throwaway shell (Tynn #897, 2c-4): a workspace's with its shell environment, or Genie's own in the home folder.
        scratchTerminals: { open: (workspaceId, context) => scratchTerminalFor({ scratch: hostScratchTerminals, home: userHome(), workspace: (id) => hostRegistry.workspace(id) ?? null, envFor: shellEnv }, workspaceId, context) },
        // THE QUESTION WINDOW'S DRAWER AND GALLERY (Tynn #912, 2f-1): a question's named files and ArtBoard visuals, looked up
        // in this host's own Deck and read from the question's workspace, for every client.
        questions: hostQuestionReads({ deck: featureDeckItems, workspacePath: (id) => hostRegistry.workspace(id)?.path ?? null }),
        // OPEN WITH / SHOW IN FILE MANAGER for a client on another machine (Tynn #912, 2f-1): confined here, then done on this
        // machine's screen by a Genie window here (the window op, like the trash). This machine's own window does it itself.
        hostShell: hostShellFor({ absolute: (ws, path) => phoneFiles.absolute(ws, path), windowOp: (op, args) => (engineRef ? engineRef.windowOp(null, op, args) : Promise.reject(new Error('Genie is still starting; try again in a moment'))), hostName: () => hostname() }),
        // A remote window's transport to another machine, owned by its connection (Tynn #941, 2f-2).
        deviceLinkProtocol: deviceProtocol,
        // What this host runs, for this machine's tray and quit (Tynn #953, 2g-2).
        hostSummary,
        // WHAT AN OLDER GENIE SEALED (Tynn #959, 2g-3b): the window unseals it, this host keeps it in its own keychain and book.
        legacySecrets: legacyAdopt,
        // Ask Tynn again whether this host is signed in: the machine woke, or an agent found IssueWatch signed out (Tynn #959).
        tynnRecheck: async () => { const account = await tynnOpening.catch(() => null); if (account && !account.status().signedIn) await account.recheck(); },
        providerPrograms: hostProviderPrograms({
            file: () => providerChoiceFile(),
            refresh: (provider) => { void providerHealth.refresh(provider); },
        }),
        // THE CRASH REPORT (Tynn #386 part 4; #897 2c-2), for every client of the owner's: built from this host's own safe
        // mode, crash state, registry and workstation identity. Nothing is sent until the person presses Send.
        crashReports: crashReportHost({
            view: () => safeMode.view(),
            record: () => crashState.view().record ?? null,
            notice: () => crashState.view().notice ?? null,
            agents: () => hostRegistry.listAgents().map((a) => ({ id: a.id, name: a.name, provider: a.provider })),
            workspaceNames: () => [...hostRegistry.listWorkspaces().flatMap((w) => [w.id, basename(w.path)]), ...hostRegistry.workspaceSlugs().values()],
            genieVersion: build,
            os: process.platform,
            arch: process.arch,
            tynnHost: TYNN_HOST,
            identity: async () => workstationService.identity(TYNN_HOST),
            authHeader: () => workstationService.authHeader(TYNN_HOST),
            // This machine's network (its roots and proxies), as the relay's calls to Tynn go.
            fetch: (url, init) => relayFetch(url, init),
        }),
        // ANY FILE IN A MESSAGE (Tynn #829), with no window connected: saved into the agent's workspace on this host.
        saveUploads: (record, files) => saveChatUploads({ workspace: uploadWorkspaceOf(hostRegistry.workspace(record.workspaceId), hostUntrustedNow(record)), files, now: new Date() }),
        startRefusal: (r) => startRefusal({ registry: hostRegistry }, r, {
            running: hostRegistry.listAgents().filter((a) => a.workspaceId === r.workspaceId && host.probe(a.id)?.running === true).length,
            cap: agentCapFrom(settings.snapshotFor(r.workspaceId)),
        }),
        settings,
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
        cloneOffers: { cloneOffers: (id) => cloneOffersService.call('list', [id]), applyOffer: (id, offerId) => cloneOffersService.call('apply', [id, offerId]) },
        workspaceSave: workspaceSaveOps({ fs: nodeEnvelopeFs(), git: nodeSaveGit(), pathOf: (id) => hostRegistry.workspace(id)?.path ?? null, mayReadFolder: (path) => hostRegistry.workspaceStates().find((w) => w.path === path)?.asleep !== true,
            // What a save declares: this workspace's engines, its own settings and its agents' IssueWatch, read when the dialog asks.
            elements: (id) => elementSourcesFor({ services: { list: () => hostingStack?.engines.list() ?? [] }, settings: { workspaceValues: (w) => settings.workspaceValues(w) }, registry: hostRegistry, flows: { list: (w) => flowStoreNow?.list(w) ?? [] }, processes: { kept: () => processBookNow?.kept() ?? [] } }, id) }),
        tynnTab: { board: hostTynnBoard, readPage: readHostTynnPage },
        terminals: terminalHost,
        // Opening a terminal, adding an agent and sending one a file are genie-host's too (Tynn #898 step 2d-2).
        serviceEnvFor: (workspaceId) => engine.serviceEnvFor(workspaceId),
        uploads: uploadSender({ resolve: (to) => resolveOnRoster(to, hostRegistry.listAgents(), hostRegistry.workspaceSlugs()), send: (input) => own.inbox.send(input) }),
        agentCreate: { sacredName: async (workspaceId) => { const projectId = workspaceTynnProject(workspaceId); return projectId === null || !tynnAccountNow ? null : sacredNameOf(await tynnAccountNow.projects(), projectId); } },
        takeOver: (id) => takeOverHost.probe(id),
        headroom: headroomFeed,
        models: providerModels,
        providerInstalled: (provider) => providerHealth.installed(provider),
        signedIn: (provider) => providerHealth.signedIn(provider),
        attention: own.attention,
        approvals,
        deckItems: featureDeckItems,
        inbox: own.inbox,
        deliverToAgent: (agentId, text) => host.deliver(agentId as AgentId, text, 'you'),
        files: {
            children: async (workspaceId, dir) => (await phoneFiles.children(workspaceId, dir)) ?? null,
            open: (workspaceId, path) => phoneFiles.open(workspaceId, path),
            readBytes: (workspaceId, path) => phoneFiles.readBytes(workspaceId, path),
            upload: (workspaceId, dir, name, bytes) => phoneFiles.upload(workspaceId, dir, name, bytes),
        },
        // THE LOCAL FAMILIES (Tynn #898 step 2d-3a): the file and Repository panels, drafts, the ArtBoard, the window's own
        // terminals, the Marketplace and the GApp book, from what this host owns.
        local: { ...hostLocalPorts({
            workspaces: () => hostRegistry.listWorkspaces(),
            workspacePath: (id) => hostRegistry.workspace(id)?.path ?? null,
            files: () => phoneFiles,
            plugins: pluginsService,
            sendFromPerson: async (agentId, text) => { await own.inbox.send({ from: HUMAN, to: agentId as AgentId, text }); },
            drafts,
            terminals: () => terminalHost,
            trackCwd: () => settings.snapshot().track_cwd,
            terminalEnv: shellEnv,
            marketplace: () => marketplaceHost ?? null,
            gapps: () => (gappBook ? gappsApi(gappBook, gappAsk, gappPreviews ?? undefined) : null),
            onGappsChanged: (listener) => gappBook?.onChange(listener) ?? (() => {}),
            // AN APP'S WINDOW (step 2d-4b): opened by the window that asked, in its own process. Anyone else is told where.
            appWindow: async (context, packageId, preview) => {
                const binding = context ? protocolTunnels.bindingOf(context.connectionId) : null;
                if (!binding || !engineRef) throw new Error(APP_WINDOW);
                await engineRef.windowOp(binding.owner, preview ? 'gapps.preview' : 'gapps.open', [packageId]);
            },
            say,
        }),
            // ITS WATCHES (step 2d-3b): the file panel and the live Tynn tab, under genie-host's own owner on its hubs.
            filesWatch: hostFilesWatches.port,
            tynnWatch: hostTynnWatches.port },
        // The update actions and the share links are this host's too (Tynn #898 step 2d-2b): its updater, its Tynn account.
        updates: remoteUpdatesPort(updatesService),
        shares: shareLinksOver({
            request: (path, init) => (tynnAccountNow ? tynnAccountNow.request(path, init) : Promise.reject(new Error('this Genie has no Tynn account'))),
            workstation: () => { const w = relayHostService.status().workstation; return w?.registered ? w.workstationId : null; },
            // A revoked link's live guest session is dropped now, not at the next re-check (audit M-c).
            endSessions: async () => { await relayHostService.call('revalidate', []); },
        }),
        // THE OWNER'S OPERATIONS (Tynn #898 step 2d-3b): its app door's keys, its device link's remembered hosts, its Tynn
        // account and relay role. Genie 1's record of this machine is read once a window has said where its database is.
        owner: hostOwnerOps({
            appInbox: {
                door: appInboxDoor,
                enabled: (workspaceId) => settings.snapshotFor(workspaceId).app_inbox !== false,
                workspaceExists: (workspaceId) => !!hostRegistry.workspace(workspaceId),
                restart: {
                    serviceEnvChanged: (workspaceId) => hostingStack?.sites.serviceEnvChanged(workspaceId) ?? [],
                    processes: () => (processBookNow ? { status: (id: string) => processSupervisor.status(id), restart: (id: string) => processBookNow!.restart(id) } : null),
                },
            },
            deviceLink: deviceLinkService,
            tynn: {
                account: () => tynnAccountNow,
                role: () => relayHostService.role(),
                readRole: () => relayHostService.readRole(),
                registered: () => { const w = relayHostService.status().workstation; return w?.registered ? w.workstationId : null; },
                stored: async (host) => (await workstationService.identity(host))?.workstationId ?? null,
                v1Settings: () => (v1DatabasePath ? readV1Settings(v1DatabasePath) : null),
            },
        }),
    });
    for (const listener of phoneReady) listener();
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
    /** The flow store once open (Tynn #756): Save to repo reads it, and a fresh clone's flows are created in it. */
    let flowStoreNow: FlowStore | null = null;
    let processBookNow: ProcessBook | null = null;
    /** The host's clocks, once they exist: stopped first at "Shut down everything" (P5a.3, host-shutdown.ts). */
    const clocks: Array<{ stop(): void }> = [marketplacePlugins];
    // PROOF-OF-DONE (Tynn #742): this host's key signs for the signed-in Tynn user; a HITL claim waits on the Deck as an approval.
    const podCaller: import('./mcp-tools.js').Caller = { agentId: 'genie-proof-of-done' as AgentId, agentName: 'Genie', workspaceId: '', workspacePath: '' };
    void tynnOpening.then((account) => {
        clocks.push(startProofOfDone({
            file: join(home, 'proof-of-done-notes.json'),
            keychain,
            tynn: { signedIn: () => account.status().signedIn === true, userId: () => account.userId(), credentialId: () => account.credentialId(), request: (path, init) => account.request(path, init) },
            // Its signal withdraws the card when Tynn stops listing the claim as waiting (Tynn #858).
            approve: podApproval(approvals, podCaller),
            workspaces: () => hostRegistry.listWorkspaces().map((w) => ({ id: w.id, path: w.path })),
            label: () => hostname(),
            log: say,
            onAccountChange: (listener) => account.onChange(listener),
        }));
    }, () => {});
    /** The clocks to plan again when the person leaves safe mode — arming what may fire later, and starting nothing now. */
    const planners: Array<{ plan(): void }> = [];
    safeMode.onChange((view) => { if (!view.active) for (const p of planners) p.plan(); });
    const openFlows = (databasePath: string): Promise<void> => {
        flowsOpening ??= (async () => {
            const store = await FlowStore.open(home);
            flowStoreNow = store;
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
                    // Tynn #826: handed over now (mid-turn where the provider reads it), kept for the next run when nothing can take it.
                    deliver: (id, text, by, replacing) => host.deliverFlowPrompt(id as AgentId, text, by, replacing),
                    isQueued: (id, promptId) => host.isPromptQueued(id as AgentId, promptId),
                    keep: (id, text, by) => host.keepFlowPrompt(id as AgentId, text, by),
                    deliverKept: (id, only) => host.deliverOwed(id as AgentId, undefined, only),
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
            // Each kept process's output, kept past this Genie (Tynn #860): a row "stopped by restart" still has its log.
            let opened: ProcessBook | null = null;
            const keptLogs = await KeptProcessLogs.open(join(runtime, 'process-logs'), {
                supervisor: processSupervisor,
                owns: (id) => opened?.owns(id) ?? false,
                // Owner-only on Windows too: the credential ACL on the folder, once (process output can hold a secret).
                ...(process.platform === 'win32' ? { restrictDir: (dir: string) => restrictPrivateDirectories([dir]) } : {}),
            });
            const processBook = await ProcessBook.open(home, {
                ...deps,
                logs: keptLogs,
                limit: (workspaceId) => limitOf(settings.snapshotFor(workspaceId), 'processes'),
                v1: { database: databasePath, workspaces: () => hostRegistry.listWorkspaces(), roster: () => hostRegistry.listAgents() },
            });
            opened = processBook;
            // Written before the host goes ("Shut down everything" stops the clocks): the last output is not left pending.
            clocks.push({ stop: () => { void keptLogs.flush(); } });
            // A nudge wakes its agent through the host's one wake, as mail does (the owner's decision, Tynn #860).
            const nudgeWake = hostAgentWake({ host, registry: hostRegistry, settings, osaDir: osaHome, safeMode: safeNow });
            const scheduler = new ProcessScheduler({
                ...deps,
                book: processBook,
                // A nudge reaches its agent by its address, on the host's roster, at its turn's end; a miss says which (Tynn #860).
                nudge: (address, text, from) => nudgeOnRoster({
                    resolve: (a) => resolveOnRoster(a, hostRegistry.listAgents(), hostRegistry.workspaceSlugs()),
                    // An agent whose workspace is hibernated is not on the roster: said as mail says it.
                    unreachable: (a) => hostRegistry.mailRefusal(a),
                    deliver: (id, t, by) => host.deliver(id as AgentId, t, by),
                    wake: nudgeWake,
                }, address, text, from),
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
    // OPENING A FRESH CLONE (Tynn #756, PR9a): a workspace that appears here is restored in order (its settings, its tabs, the trust
    // verdict, its flows DISARMED, its processes STOPPED), in the host that owns the stores. What it did, and what it left waiting
    // for the person's trust, is logged.
    const cloneRestorePortsNow = (): CloneRestorePorts => cloneRestorePorts({
            files: nodeCloneFiles(),
            registry: {
                agentsOf: (id) => hostRegistry.listAgents().filter((a) => a.workspaceId === id),
                defaultAgentOf: (id) => hostRegistry.defaultAgentOf(id),
                setDefaultAgent: (id, agentId) => phoneRegistry.setDefaultAgent(id, agentId),
                listWorkspaces: () => hostRegistry.listWorkspaces(),
                setWorkspaceEnvFile: (id, file) => phoneRegistry.setWorkspaceEnvFile(id, file),
                workspaceMcpOff: (id) => hostRegistry.workspaceMcpOff(id),
                setWorkspaceMcpServer: (id, name, on) => phoneRegistry.setWorkspaceMcpServer(id, name, on),
                listAgents: () => hostRegistry.listAgents(),
                workspaceSlugs: () => hostRegistry.workspaceSlugs(),
            },
            settings: { workspaceValues: (id) => settings.workspaceValues(id), setFor: (id, key, value) => settings.setFor(id, key, value), get: (key) => settings.snapshot()[key] },
            flows: async () => { await flowsOpening; return flowStoreNow; },
            processes: async () => { await bookOpening; return processBookNow; },
            trusted: (id) => hostingStack?.trust.view(id)?.trusted === true,
            siteHosts: (id) => (hostingStack?.sites.list() ?? []).filter((s) => s.workspaceId === id).map((s) => `${s.name}.gen`),
    });
    const restoreWorkspaceClone = (workspaceId: string): void => {
        const workspace = hostRegistry.workspace(workspaceId);
        if (!workspace) return;
        const ports = cloneRestorePortsNow();
        void restoreClone({ id: workspace.id, path: workspace.path }, ports)
            .then((report) => lifecycleLog(`clone ${workspace.id} restored: ${report.order.join(' > ')}${report.skipped.length > 0 ? `; skipped ${report.skipped.map((s) => `${s.step} (${s.reason})`).join(', ')}` : ''}${(report.flows?.waiting.length ?? 0) + (report.processes?.waiting.length ?? 0) > 0 ? '; waiting for the workspace to be trusted' : ''}`))
            .catch((error: unknown) => say(`clone ${workspace.id} could not be restored: ${error instanceof Error ? error.message : String(error)}`));
    };
    watchNewWorkspaces({ workspaceStates: () => hostRegistry.workspaceStates(), subscribe: (listener) => phoneRegistry.subscribe(() => listener()) }, restoreWorkspaceClone);
    // The person's yes (Tynn #756, PR9b): what waited for it is restored now, by the same restore (it leaves what is already here alone).
    hostingStack?.trust.onTrusted?.((id) => restoreWorkspaceClone(id));
    // THE WATCHER (Tynn #756, PR9c): what a teammate pushes to `.flows/`, `.processes/` or `.genie/tabs.json` is noticed and OFFERED,
    // with what the repo says beside what this machine has. The host only looks and says what it found: nothing is applied here;
    // applying one is the person's, asked of the watcher.
    const cloneWatch = new CloneWatch({
        workspaces: () => hostRegistry.workspaceStates().map((w) => ({ id: w.id, path: w.path, ...(w.asleep === true ? { asleep: true } : {}) })),
        restore: cloneRestorePortsNow(),
        stamp: async (path) => { try { const info = await statFile(path); return `${info.mtimeMs}:${info.size}`; } catch { return null; } },
        live: async (workspace) => withElements(
            { manifest: {}, manifestText: '{}\n', files: [] },
            elementSourcesFor({ services: { list: () => hostingStack?.engines.list() ?? [] }, settings: { workspaceValues: (w) => settings.workspaceValues(w) }, registry: hostRegistry, flows: { list: (w) => flowStoreNow?.list(w) ?? [] }, processes: { kept: () => processBookNow?.kept() ?? [] } }, workspace.id),
            workspace.id,
            workspace.path,
        ).model.files.map((f) => ({ path: f.path, value: f.value })),
    });
    cloneOffersService.attach({ watch: cloneWatch, trusted: (id) => hostingStack?.trust.view(id)?.trusted === true });
    cloneWatch.onChange((workspaceId, offers) => { if (offers.length > 0) lifecycleLog(`${workspaceId}: the repo has ${offers.length} change${offers.length === 1 ? '' : 's'} to offer: ${offers.map((o) => o.summary).join(', ')}`); });
    const cloneWatchTimer = setInterval(() => { cloneWatch.pass().catch((error: unknown) => say(`clone watch: ${error instanceof Error ? error.message : String(error)}`)); }, 30_000);
    cloneWatchTimer.unref();
    // THE MAIL WAKE (P3.2): mail reaches its agent with no window — told, or started for it under the person's refusals.
    // ISSUEWATCH's queue is the wake's second source (P5c): `push` starts a stopped agent through this same wake, `next-turn` waits.
    planKeepalive = wireHostPlanKeepalive({ host, registry: hostRegistry, asked: (id) => own.attention.pending().some((q) => q.agentId === id), settings, log: (line) => { say(line); lifecycleLog(line); },
        stalledTurns, restart: (id) => (phoneApi ? phoneApi.invoke('agents.restart', [id, 'graceful']) : Promise.reject(new Error('Genie’s agents are still starting'))) });
    clocks.push(planKeepalive);
    wireHostMailWake({ inbox: own.inbox, host, registry: hostRegistry, settings, osaDir: osaHome, log: (line) => { say(line); lifecycleLog(line); }, issueWatch: issueWatch.delivery, safeMode: safeNow });
    bootStep('sessions', stepAt);
    mcp = startHostMcp({
        toolCalls,
        stores: stores.stores,
        settings,
        records: () => hostRegistry.listAgents(),
        registry: hostRegistry,
        probe: (id) => host.probe(id),
        lastRowAt: (id) => host.rowsFor(id).at(-1)?.at ?? null,
        reportPlan: (id, steps) => host.reportPlan(id, steps),
        serviceExec: makeServiceExec(systemProcessTree, processSupervisor, (id, run) => { host.commandStarted(id as AgentId, run); }),
        // The agents' `sites` / `services` act only in a trusted workspace (Tynn #753): the verdict as last read, as a shell call reads it.
        workspaceTrusted: (workspaceId) => !hostUntrustedNow({ workspaceId }),
        window: { connected: () => engine.windowConnected(), call: (call: ForwardedToolCall) => engine.forwardTool(call) as Promise<McpToolResult> },
        openFileLater: (call) => engine.callback({ name: 'openFileForUser', call }),
        capabilities,
        signal: (signal) => {
            if (signal.kind === 'action' && signal.action === 'thumbsup' && signal.reason?.trim().toLowerCase() === 'shutdown') agentShutdown.acknowledge(signal.agentId);
            engine.callback({ name: 'toolSignal', signal });
        },
        forwardedCalls,
        // THE AGENTS' `playwright` (Tynn #846): what Genie has, and asking it for a version.
        playwright: playwrightToolPort({ toolchainDir: playwrightToolchain, fs: nodePhpVersionsFs(), installer: playwrightInstaller, workspacePath: (id) => hostRegistry.workspace(id)?.path ?? null }),
        // `logs` reads a kept process's output from before a restart too (Tynn #860); a site's server, the supervisor's tail.
        processes: { book: hostBook, logs: (id, lines) => processBookNow?.log(id, lines) ?? processSupervisor.readLog(id, lines), runNow: (id) => hostBook.runNow(id) },
        terminals: { list: () => terminalHost.list(), open: (options) => terminalHost.open(options), write: (id, data) => terminalHost.write(id, data), scrollback: (id) => terminalHost.scrollback(id), finished: (id) => terminalHost.finished(id), refusal: (ws) => terminalHost.refusal(ws), onData: (listener) => terminalHost.onData((id, data) => listener(id, data)), scrollbackCap: 1_000_000 },
        // A shell an agent opens sees the workspace's service variables and Genie's MCP endpoint, as the person's do.
        terminalEnv: shellEnv,
        // Tynn #833: an agent's Stop is its own (`by`); a person's flow only through the person's approval on the Deck. Tynn #839: Run now names who pressed it.
        flows: { store: hostFlows, runNow: (id, by) => hostFlows.runNow(id, by), stopRun: (id, by) => flowsService.stopRun(id, by), approve: (caller, action, detail, call) => approvals.gate(caller, action, detail, call) },
        // THE AGENTS' `mail` (Genie Mail G6): the inbox book and the shared Mailpit, both this host's.
        ...(hostingStack?.mail ? { mail: hostingStack.mail } : {}),
        // THE AGENTS' `sites` AND `services` (Tynn #444): this host's own hosting (P5a) under its own supervisor — what the
        // Hosting and Services tabs show. Only `sites open` still goes to a window.
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
    // THE WORKSPACE AGENT FILES, kept here with or without a window (Tynn #898 step 2e-2, host-workspace-files.ts): every
    // workspace once the MCP server is up, each one added after, and again on a Tynn sign-in or out.
    {
        let stopWorkspaceFiles: (() => void) | null = null;
        let stopped = false;
        clocks.push({ stop: () => { stopped = true; stopWorkspaceFiles?.(); } });
        void mcp.ready().then(() => {
            if (stopped) return;
            stopWorkspaceFiles = syncWorkspaceFiles({
                workspaces: () => phoneRegistry.listWorkspaces(),
                onWorkspacesChanged: (listener) => phoneRegistry.subscribe(() => listener()),
                tynnSignedIn: () => tynnAccountNow?.status().signedIn === true,
                onTynnChanged: (listener) => {
                    let off: (() => void) | null = null, done = false;
                    void tynnOpening.then((account) => { if (!done) off = account.onChange(listener); }, () => {});
                    return () => { done = true; off?.(); };
                },
                // The same registry the loop lists and follows (phoneRegistry), so a workspace it was told of is found here.
                tynnProject: (workspaceId) => { const w = phoneRegistry.workspace(workspaceId); return w ? tynnProjectOf(w.path) : null; },
                syncAgentDocs: (path) => featureFiles.syncAgentDocs(path),
                syncConfig: (path) => featureConfig(path),
                log: (line) => { say(line); lifecycleLog(line); },
            });
        });
    }
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
    bootStep('mcp', stepAt);
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

    bootStep('spawn hosts', stepAt);
    // A host started late on purpose, for the real-window test only (host-wait-window.ts testReadyDelayMs).
    await sleepFor(testReadyDelayMs(process.env));
    // The token first, then the record that points at it: a window that reads the record can always read the token.
    await writeTextPrivate(tokenFile, token);
    if (process.platform !== 'win32') chmodSync(tokenFile, 0o600);
    const record: HostRecord = { pid: process.pid, endpoint, protocol: ENGINE_PROTOCOL, build, startedAt: Date.now() };
    await writeTextPrivate(recordFile, JSON.stringify(record));
    say(`serving ${endpoint} (protocol ${ENGINE_PROTOCOL}, build ${build})`);

    async function shutdown(why: string): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            hangWatchdog.shuttingDown();
            say(`shutting down: ${why}`);
            if (marketplaceHost) await marketplaceHost.close().catch((error: unknown) => say(`Marketplace shutdown: ${error instanceof Error ? error.message : String(error)}`));
            lifecycleLog(`host shutdown pid=${process.pid} reason=${why}`);
            browserService.quit();
            logins?.dispose();
            const bound = new Promise<void>((r) => setTimeout(r, 10_000).unref());
            // Every session stopped and its stop verified, every write drained — bounded, so a stuck stop never keeps a
            // host nobody wants.
            await Promise.race([host.stopAll().then(() => host.drained(2_000)), bound]).catch(() => undefined);
            // ITS TERMINALS (§7.1: nothing Genie spawned outlives it; Tynn #953): this host holds them, so it ends them, never
            // a window asking for it first. An upgrade once jammed on 31 orphaned OpenConsole.exe processes.
            terminalHost.closeAll();
            files?.close();
            issueWatch.stop();
            await mcp?.stop();
            approvals.cancelAll('Genie is shutting down');
            hostFeatures?.close();
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
        } finally {
            // Normal exit never returns. If teardown throws or an exit hook returns, this host
            // must not retain a permanent work hold or an updater stuck in installing.
            try { updatesService.updates.cancelDrain(); }
            finally { shuttingDown = false; }
        }
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

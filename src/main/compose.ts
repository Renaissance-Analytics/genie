import { phpWorkerEnvWithTrust } from './php-trust-host.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir as readdirP, readFile as readFileP, rmdir, unlink as unlinkP, writeFile as writeFileP } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { deckItemsFrom, type AskerState } from '../core/deck-sources.js';
import { folderName } from '../core/workspace-name.js';
import { asleepOnlyEngine, enginesToRelease, enginesToResume } from '../core/hibernate-engines.js';
import { DEFAULT_READINESS, engineStatuses as engineStatusesOf, readinessHandshake, reconcileEngines, type EngineStatusView, type ReadinessBound, type ReconcileReport } from '../core/engine-reconcile.js';
import { PortAllocator } from '../core/port-allocator.js';
import type { ServiceInstance } from '../core/services.js';
import { websocketRoutes } from './websocket-front-door.js';
import { mailpitRoutes } from '../core/mailpit-name.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { GenRoute } from '../core/gen-router.js';
import { frontDoorCaddyfile, hostsFilePath, type FrontDoorTls } from '../core/front-door-caddy.js';
import { trustDeckItem, trustInstallStep } from '../core/gen-ca.js';
import { GenCa, osTrustStore, type CaSource, type CertIssuer, type TrustStorePort } from './gen-ca.js';
import { planV1KnowledgeImport, type V1Knowledge } from '../core/v1-import.js';
import type { V1Inbox } from '../core/v1-inbox.js';
import { runV1InboxImport } from './v1-inbox.js';
import { runV1ServicesAdoption } from './v1-services.js';
import { runV1FlowImport } from './v1-flows.js';
import { ensureFlowToolKinds, type FlowToolCall } from './flow-tools.js';
import { HUMAN, agentAddress, resolveAddress as resolveOnRoster, type Resolution } from '../core/inbox.js';
import type { AgentRecord } from '../core/identity.js';
import type { McpServer } from '@particle-academy/prism-acp';
import { OS_WORKSPACE } from '../core/os-agent.js';
import { tynnProjectIdOf } from '../core/issue-watch.js';
import { ReminderBook } from '../core/inbox-reminders.js';
import { inboxNotices } from './inbox-notices.js';
import type { NoticeMail } from '../core/stream-event.js';
import { isAppSender } from '../core/app-inbox.js';
import type { AppEnvSource } from './app-inbox-service.js';
import { configSync, type SyncResult } from '../core/integrations.js';
import { AgentFilesHealth, type AgentFilesReport, type AgentFilesStep, type SyncSource } from '../core/agent-files-health.js';
import { writeAgentGitignore } from './agent-gitignore.js';
import { writeAgentRouters } from './agent-routers.js';
import { writeAgentSkills } from './agent-skills.js';
import { configSyncTargets, writeAgentProtocol } from './config-sync-targets.js';
import { tynnAgentTokens, type TynnSessionPort } from './tynn-agent-token.js';
import { agentTynnPrep } from './agent-tynn-prep.js';
import type { AgentSecrets } from './tynn-agent-identities.js';
import { fileMigrationBook, gatherSources, migrateSecrets, stuckLines, type HostVault, type MigrationSource } from './keychain-migration.js';
import { McpPreparationError } from './mcp-preparation-error.js';
import { configWriter, writeWorkspaceConfig, type WorkspaceConfigRequest } from './workspace-config-sync.js';
import { PluginHost } from './plugin-host.js';
import type { Verification } from './mcp-server.js';
import { PUBLISHER_KEYS } from '../core/plugin-keys.js';
import { OFFICIAL_PLUGINS } from '../core/official-plugins.js';
import { Baton, PairingPins } from '../core/remote.js';
import { PairApprovals } from '../core/pair-confirm.js';
import type { ServerTransport } from '../core/remote-protocol.js';
import { ApprovalQueue, SWITCH_ANSWERS } from './approval-queue.js';
import { Elevator, realHostsIo, runElevatedBatch, stepOutcome, type ElevationOutcome, type PrivilegedStep } from './elevate.js';
import type { AgentSessionsPort } from './flow-runner.js';
import type { FlowScheduler } from './flow-scheduler.js';
import { startFlowsEngine } from './flows-engine.js';
import type { FlowSchedulerApi, FlowsApi } from './flows-host.js';
import { FlowStore } from './flow-store.js';
import { GenRouterServer } from './gen-router-server.js';
import { GenLeafContexts } from './browser-trust.js';
import { FRONT_DOOR_PORTS, bindFailure, heldReason, realFrontDoorPorts, type FrontDoorBlocked, type FrontDoorPort, type FrontDoorPorts } from './front-door-port.js';
import { HostsSync, type HostsIo, type HostsSyncResult } from './hosts-file.js';
import type { OwnAgentStores, WindowAgentStores } from './agent-stores-api.js';
import { importV1Inbox, importV1Knowledge, openAgentStores } from './agent-stores-open.js';
import { runtimeDir } from './paths.js';
import { ProcessSupervisor, type SupervisorApi } from './process-supervisor.js';
import type { ListedPty } from './spawn-host-protocol.js';
import { DeviceStore } from './remote-devices.js';
import { RemoteHost, type HostApi } from './remote-host.js';
import { loopbackAnswers, loopbackPortFree } from './port-probe.js';
import { ServiceDriver, dockerRunnerOver, type DockerEventsPort, type DockerRunner } from './service-driver.js';
import { ServiceRegistry } from './service-registry.js';
import { DotEnvSync, gitIgnoredOver, type DotEnvSyncPorts } from './dotenv-sync.js';
import { SettingsStore } from './settings-store.js';
import { SiteManager, type PhpCgiResolution } from './site-manager.js';
import { EnvelopeSites, nodeEnvelopeFs, type WorkspaceRef } from './envelope-sites-host.js';
import { readJson, writeJsonAtomic } from './store.js';
import type { PtyPort } from './terminal-host.js';
import { execFileRunner, lineStreamRunner } from './toolchain-runner.js';

/**
 * THE COMPOSITION ROOT. Every store, the scheduler, the supervisor, the site manager and the front
 * door, wired once at boot and torn down once at quit. `main.ts` calls this and hands the result to
 * the IPC layer; nothing else constructs these.
 *
 * Boot order matters in two places: the settings carry-over runs before anything reads a setting,
 * and the front door starts after the site manager exists so its route function is live. Shutdown
 * is the reverse and idempotent: stop every supervised process (a pty we own is a pty we close),
 * close the front door's connections, wait for an in-flight flow run, close the knowledge database.
 */

export interface ComposeInput {
    readonly userData: string;
    readonly pty: PtyPort;
    /**
     * The supervisor's pty engine (sites, queue workers, the front door), when it is not `pty`: in Electron, the spawn
     * host's (main/spawn-host-client.ts, genie#1397), so no supervised process is created on main's thread. Absent = `pty`.
     */
    readonly processPty?: PtyPort;
    /**
     * Live supervised ptys a previous window started, still running under genie-host (the host split, P2.1): adopted
     * as the supervisor is built — BEFORE any site or kept process starts — so each one's first start claims its
     * running process instead of starting it a second time on the same port.
     */
    readonly adoptPtys?: readonly ListedPty[];
    /**
     * `docker events` as a stream of lines, so engine states are read on change instead of on every look (genie#1397).
     * Absent with no `docker` given = the real one, created where `execFileRunner`'s commands are; absent with a `docker`
     * given (a test's fake) = no watch, every look asks.
     */
    readonly dockerEvents?: DockerEventsPort;
    /** Reads v1's settings table, or `null` when there is no v1 database. Called once, on first run only. */
    readonly v1Settings: () => Readonly<Record<string, string>> | null;
    /**
     * Reads Genie 1's knowledge graph (`readV1Knowledge`), or `null` when it cannot see one. Called at boot until the
     * knowledge store records an import that saw v1 — then never again. Absent = no Genie 1 to import from.
     */
    readonly v1Knowledge?: () => V1Knowledge | null;
    /** Reads Genie 1's AgentInbox history (`readV1Inbox`), or `null`; called at boot until the inbox records an import that saw v1. */
    readonly v1Inbox?: () => V1Inbox | null;
    /**
     * The stores agents write to, when genie-host owns them (the host split, P3.1): the window's replicas. Absent = this
     * window opens them itself — only on the emergency path, when no host could start.
     */
    readonly agentStores?: WindowAgentStores;
    /** genie-host's process supervisor, through this window's replica (P3.3b). Absent = this window runs its own. */
    readonly supervisor?: SupervisorApi;
    /** genie-host's flows and their scheduler, through this window's replica (P3.3d). Absent = this window runs its own. */
    readonly flowsEngine?: { readonly flows: FlowsApi; readonly scheduler: FlowSchedulerApi };
    /**
     * Genie 1's database, for TAKING OVER its service engines in place and stopping its sandbox/site containers
     * (main/v1-services.ts) — at boot until services.json records a take-over that saw Genie 1 and Docker. Before the
     * sites and the process book start, because both read the engines' env. Absent = no Genie 1 to take over from.
     */
    readonly v1Services?: { readonly database: string };
    /**
     * Genie 1's database, for bringing its FLOWS over as disarmed canvas flows (main/v1-flows.ts, genie#1204). Absent = none.
     */
    readonly v1Flows?: { readonly database: string };
    /**
     * The live agent sessions a flow's `genie/agent_prompt` prompts (main.ts wires the session host), late-bound like the
     * roster. Absent = no agent is running, so a scheduled prompt fails with that reason.
     */
    readonly agentSessions?: AgentSessionsPort;
    readonly caddyBin: string | null;
    /** What every site's php-cgi worker is given on top of the pty host's env: Genie's CA ini directory (toolchain-ops.ts). */
    readonly phpWorkerEnv?: () => Readonly<Record<string, string>>;
    /** This machine's system CA roots for PHP's trust bundle (main/php-trust-host.ts systemRootsPem). Absent = none. */
    readonly phpSystemRoots?: () => string | null;
    /** Which php-cgi a site's PHP pin runs (main/php-versions.ts `resolvePhpCgi`); absent = PATH php-cgi, pins refused. */
    readonly resolvePhpCgi?: (pin: string | undefined) => PhpCgiResolution;
    /** Right before a pinned site's php-cgi starts (main/php-versions.ts `refreshManagedIni`). */
    readonly preparePhpCgi?: (pin: string | undefined) => void;
    /** php-cgi workers per PHP site (site-manager PHP_WORKERS when absent). */
    readonly phpWorkers?: number;
    /** 0 picks a free loopback port. */
    readonly frontDoorPort?: number;
    readonly allocatePort?: () => number;
    /** Whether 127.0.0.1:<port> is free to bind (the shared allocator's probe); a real bind probe by default. */
    readonly portFree?: (port: number) => Promise<boolean>;
    readonly now?: () => number;
    /**
     * Whether a supervised process's pid is still a live OS process (`osPidAlive` in production, main.ts) — one of the two
     * questions the supervisor's liveness check asks (P2). Absent = only the pty engine is asked, so a test's fake pids
     * are never put to the real OS.
     */
    readonly pidAlive?: (pid: number) => boolean;
    /** Runs `docker <args>`; execFile in production. A missing Docker answers a non-zero exit, never a throw. */
    readonly docker?: DockerRunner;
    /** ONE readiness probe of an engine on its loopback port; the engine's own handshake over a real socket by default. */
    readonly engineAnswers?: (instance: ServiceInstance) => Promise<boolean>;
    /**
     * A started site's readiness wait (parity audit #9): true once its port answers. main.ts passes the real one
     * (port-probe.ts `siteAnswers`); absent = no wait, a site is running when its process is (most composition tests).
     */
    readonly siteProbe?: (port: number, options: { behindCaddy: boolean }) => Promise<boolean>;
    /** How long an engine started at Genie start is waited for, and how often it is asked. */
    readonly engineReadiness?: ReadinessBound;
    /** Does git ignore a `.env` in a folder (`git check-ignore` by default)? Asked before a service password is written into one. */
    readonly gitIgnored?: DotEnvSyncPorts['gitIgnored'];
    /** The OS hosts file; the real one by default. */
    readonly hostsIo?: HostsIo;
    /**
     * Runs a BATCH of steps through ONE OS elevation prompt and says which step, if any, stopped it (elevate.ts). The real
     * prompt by default. Genie calls it one batch at a time, and a hosts write due when the person trusts rides along.
     */
    readonly elevate?: (steps: readonly PrivilegedStep[]) => Promise<ElevationOutcome>;
    /** How long a burst of site changes is waited out before the one hosts write; 250 ms by default. */
    readonly hostsDebounceMs?: number;
    /** The front door's :443/:80 — free, or held and by whom; real bind probes and the OS's listener table by default. */
    readonly frontDoorPorts?: FrontDoorPorts;
    /**
     * Genie 1's `host-gen` folders (`<Genie 1 userData>/host-gen`), where its `.gen` CA may be — ADOPTED by copying when
     * Genie 2 has no CA of its own. None by default: only main.ts names Genie 1's real folders.
     */
    readonly v1CaDirs?: readonly string[];
    /** The OS trust store, asked by thumbprint; the real one (read-only) by default. */
    readonly trustStore?: TrustStorePort;
    /** Issues the CA and the leaf; the node:crypto X.509 builder by default. */
    readonly certIssuer?: CertIssuer;
    /** This machine's name as remote devices see it; the OS hostname by default. */
    readonly hostName?: string;
    /** Where remote connections come from (fancy-ws on a socket); none by default — nothing listens. */
    readonly remoteTransport?: ServerTransport;
    /** What a remote connection may perform here; main.ts wires the real one. Refuses everything by default. */
    readonly remoteApi?: HostApi;
    /**
     * A site's or a kept process's OWN app credential (genie#1345, main/app-inbox-service.ts): `GENIE_INBOX_URL` and
     * `GENIE_INBOX_TOKEN`, or nothing. Compose lays it over THAT site's env only — never the service env — and gives none
     * while the workspace's "Apps and scripts may message agents here" (`app_inbox`) is off. Absent = no app door.
     */
    readonly appInboxEnv?: (source: AppEnvSource) => Readonly<Record<string, string>>;
    /** Genie's own MCP endpoint for agents, once the server listens; `null` until then (config sync refuses). */
    readonly mcpEndpoint?: () => { url: string; token: string } | null;
    /** With a host, a workspace's agent config is the host's to write. */
    readonly hostConfigSync?: () => { configSync(request: WorkspaceConfigRequest): Promise<readonly SyncResult[]> } | null;
    /**
     * The scoped Tynn account, late-bound because it opens after composition. Used only during private agent preparation.
     */
    readonly tynn?: () => TynnSessionPort | null;
    /** OS encryption from Electron; the vault's path is fixed under Genie's own userData, never an envelope path. */
    /** Where agents' keys are held: the host's keychain, over the link (agent-secrets.ts). */
    readonly tynnSecrets?: AgentSecrets;
    /** The one-time move of keys an older Genie sealed: the window opens them, the host keeps and reads back. */
    readonly tynnCipher?: { decrypt(bytes: Buffer): string };
    readonly tynnVault?: HostVault;
    /** What else an older Genie sealed, moved the same way: each joins this with its reader (the Tynn pairing, cut c). */
    readonly legacySecrets?: () => Promise<readonly MigrationSource[]>;
    /** Where a secret that did not move is said, as well as the console: the lifecycle log, which someone can read afterwards. Names and states, never a value. */
    readonly secretsLog?: (line: string) => void;
    /** Something moved: whoever reads it reads again. */
    readonly onSecretsMoved?: () => void;
    /** Whether a real server/discover through the server's own door answered at boot (§6.4 "native transport verified at boot"). */
    readonly mcpVerification?: () => Verification | null;
    /** Every tool Genie's MCP serves, with what it does — what every agent gets (Settings lists it). */
    readonly mcpTools?: () => readonly { name: string; description: string }[];
    /**
     * The live agent roster — the same one the agents' own inbox tool resolves against. Late-bound: the registry
     * exists after composition. Addresses, names, uncollected mail and reminders all derive from it; absent = none.
     */
    readonly roster?: () => readonly AgentRecord[];
    /** Each workspace's address slug (registry.workspaceSlugs): an agent is `name@slug`. */
    readonly workspaceSlugs?: () => ReadonlyMap<string, string>;
    /**
     * The registered workspaces (id, folder, asleep), late-bound like the roster. Their envelopes' `sites`
     * are what Hosting lists and serves (§6.6); absent = no workspaces, no declared sites.
     */
    readonly workspaces?: () => readonly WorkspaceRef[];
    /** Fires when the registered workspaces change — one added, removed, hibernated or woken. */
    readonly onWorkspacesChange?: (listener: () => void) => () => void;
    /**
     * A workspace's NAME from its folder — the rail's namer (main.ts reads project.json's `name`, else the folder), so the
     * Deck and the question window say the same name the rail does, never the id. The folder's name by default.
     */
    readonly workspaceName?: (path: string) => string;
    /** A workspace's COLOUR (genie#1300, main/workspace-color-host.ts), carried on its Deck items beside the name. Absent = none. */
    readonly workspaceColor?: (path: string) => string | null;
    /**
     * Is an agent still WAITING for what it asked — its session as Genie runs it (or its Take Over terminal), `null` when
     * it has none (main.ts asks the session host and the take-over host), `undefined` while LIVENESS IS NOT KNOWN yet
     * (before the roster and the session host have reported once). The Deck marks a question whose agent no longer
     * waits as STALE (core/deck-sources.ts `questionStale`); absent, or `undefined`, no question is judged.
     */
    readonly askerLive?: (agentId: string) => AskerState | null | undefined;
}

/**
 * The external front door, beyond "Caddy runs": the hosts block; Genie's CA (whose it is, its thumbprint) and whether
 * the OS trust store holds it — READ from the store, `null` until the first read answers; the last Trust's failure, with
 * its reason; and a leaf that could not be issued.
 */
export type FrontDoorStatus =
    | {
          running: true;
          caddyfile: string;
          hostsPath: string;
          hosts: HostsSyncResult | null;
          authority: { source: CaSource; thumbprint: string };
          trusted: boolean | null;
          trustError: string | null;
          certificateError: string | null;
      }
    /**
     * Off: no bundled Caddy or no CA (`reason` alone), or — `blocked` — a port the front door needs is held by another
     * process (or refused by the OS): Caddy is not started and not restarted until the person tries again.
     */
    | { running: false; reason: string; blocked?: { port: FrontDoorPort; holder: string | null } };

/**
 * What compose built. `S` is the stores agents write to as this window holds them: genie-host's replicas (engine mode,
 * `WindowServices`) or the stores themselves (`OwnAgentStores`, the default: the emergency path, and every test that composes alone).
 */
/** The settings as compose and its consumers use them: the store itself, or genie-host's through a replica (P3.2). */
type S_Settings = NonNullable<WindowAgentStores['settings']>;

export interface ComposedServices<S extends WindowAgentStores = OwnAgentStores> {
    /** Main-process only: prepares a session's Tynn server before its provider is constructed. */
    prepareAgentMcp(agent: AgentRecord, signal: AbortSignal): Promise<readonly McpServer[]>;
    /** Why this agent's last start went without its Tynn server, for a note in its chat; `null` when it has it (genie#1234). */
    tynnNote(agentId: string): string | null;
    /**
     * Signed in to Tynn: the agents to restart so they get their Tynn server — those that started without it because of
     * the account (signed out, unreachable), and those whose unverified stored key Tynn now refuses (genie#1234).
     */
    tynnRecovery(asked?: { readonly secretsMoved?: boolean }): Promise<string[]>;
    /** The keychain answers now: the one-time move tries what it could not do before. */
    moveSecretsAgain(): Promise<void>;
    readonly inbox: S['inbox'];
    readonly attention: S['attention'];
    readonly knowledge: S['knowledge'];
    /** The stores themselves when THIS window opened them (the emergency path); null when genie-host owns them. */
    readonly own: OwnAgentStores | null;
    readonly flows: S extends OwnAgentStores ? FlowStore : FlowsApi;
    readonly flowScheduler: S extends OwnAgentStores ? FlowScheduler : FlowSchedulerApi;
    /** The flows file itself when THIS window opened it (the emergency path); null when genie-host owns it (P3.3d). */
    readonly ownFlows: FlowStore | null;
    readonly settings: S extends OwnAgentStores ? SettingsStore : S_Settings;
    readonly supervisor: SupervisorApi;
    readonly sites: SiteManager;
    /** The workspaces' declared sites over the manager: loaded at boot, started by v1's rule, created/removed into project.json. */
    readonly envelopeSites: EnvelopeSites;
    /** Service engines per workspace (and the shared ones), on the Docker driver. */
    readonly engines: ServiceRegistry;
    /**
     * Genie start's pass over the registered engines (core/engine-reconcile.ts): the ones not running and not stopped by
     * the person are started and waited for; with Docker down, each says so. Boot does not wait for it. Never rejects.
     */
    readonly engineReconcile: Promise<ReconcileReport>;
    /** Every engine with its status for the Services tab — `docker-not-running`, with Docker's reason, when Docker is not there to ask. */
    engineStatuses(): Promise<EngineStatusView[]>;
    /** The PERSON's start / stop / remove of an engine: recorded (machine-local), so a restart keeps a stopped engine stopped. */
    startEngine(id: string): Promise<void>;
    stopEngine(id: string): Promise<void>;
    /**
     * A hibernating or waking workspace's engines (parity audit #12, core/hibernate-engines.ts): which to release and
     * which to resume, and the registry's own stop and start — NOT the person's Stop, which a wake must respect.
     */
    hibernationEngines: { toRelease(workspaceId: string): string[]; toResume(workspaceId: string): string[]; stop(id: string): Promise<void>; start(id: string): Promise<void> };
    /** Workspaces currently receiving this engine's env, plus their running sites and processes. */
    engineDependents(id: string): readonly string[];
    /** `workspaceId` = who a delete-data acts for: refused while any OTHER workspace keeps data in it (core/service-tenancy.ts). */
    removeEngine(id: string, options: { deleteData: boolean; workspaceId?: string }): Promise<void>;
    /** The workspace's service connection kept current in each site repo's `.env` — refused where git would commit it. */
    readonly envFiles: DotEnvSync;
    readonly frontDoor: GenRouterServer;
    /** The gate behind approval-gated tools; its pending requests are Deck items. */
    readonly approvals: S['approvals'];
    /** Remote access (§6.8): paired devices, share links, the baton, the lock, the connections. */
    readonly remote: RemoteHost;
    /** "Pair this device?" — what waits for Allow on this screen (q_8c07b142). */
    readonly pairing: PairApprovals;
    /**
     * The Deck's signal strip, MEASURED (§4.5): flows and uncollected mail from the stores; the OS agent's turn and whether
     * GitHub blocks features (the GitHub account's reading of GitHub, main/github-account.ts) handed in by main.
     */
    signals(context: { osAgentWorking: boolean; githubBlocked: boolean }): SignalState;
    /**
     * §6.4 THE INBOX PUSH: the notices due now — registered agents with mail they have not been told about whose session
     * can take a turn (`run` answers its run, or `null` while it cannot). Once per arrival batch. Decides; never sends.
     */
    inboxReminders(input: { run: (agentId: string) => number | null }): Array<{ agentId: string; text: string; mail: readonly NoticeMail[] }>;
    /** A notice `inboxReminders` handed out has settled: `delivered` = its turn ended cleanly; otherwise its batch is untold. */
    inboxNoticeSettled(agentId: string, delivered: boolean): void;
    /** A source's app credential (genie#1345) under the workspace's switch — what sites get, for the process book too. */
    appEnv(source: AppEnvSource): Readonly<Record<string, string>>;
    /** §6.9: Genie's MCP server and the agent files. Tynn and GitHub are their accounts' (main/tynn-account.ts, main/github-account.ts), added by feature-ipc. */
    integrations(): { mcp: { url: string | null; verified: Verification | null; tools: readonly { name: string; description: string }[] }; agentFiles: readonly AgentFilesReport[] };
    /** Config sync (§6.9): Genie's MCP endpoint into a workspace's four targets, each reported on its own. `source`: Genie's start (default) or you. */
    syncConfig(workspacePath: string, source?: SyncSource): Promise<SyncResult[]>;
    /** The Genie 2 protocol files under `.agents/_genie/`, then the AGENTS.md / CLAUDE.md routers and RULES.md, then the skills (separate from the four config-sync targets). */
    syncAgentDocs(workspacePath: string, source?: SyncSource): Promise<void>;
    /** §6.7: the plugin host over `<userData>/plugins`; re-read when developer mode changes. */
    readonly plugins: PluginHost;
    readonly pluginsDir: string;
    /** Re-read the plugins folder (after developer mode flips, or a plugin was dropped in). */
    pluginsRefresh(): Promise<void>;
    readonly frontDoorPort: number;
    /**
     * S7: the root the Genie Browser's session trusts for `.gen` hosts (and nothing else) — Genie's CA, PEM — or why
     * there is none, in which case `.gen` sites do not open in the in-app browser and the reason is logged.
     */
    browserTrust(): { readonly caPem: string; readonly thumbprint: string } | { readonly caPem: null; readonly reason: string };
    /** Genie's own Caddy on 443 for EXTERNAL browsers (https://<name>.gen), or why it is off. */
    readonly externalFrontDoor: FrontDoorStatus;
    /** Fires when the front door state changes (a hosts sync landed, the root got trusted). */
    onFrontDoorChange(listener: () => void): () => void;
    /** Observe current controller and hosts work without requesting changes; does not acknowledge Caddy's --watch reload. */
    frontDoorSettled(): Promise<void>;
    /** Sync the hosts block now — the person's "try again" after a declined prompt. */
    syncHosts(): Promise<HostsSyncResult>;
    /** The person's Try again on a front door whose port was held: asked again, and Caddy started when it is free. */
    retryFrontDoor(): Promise<FrontDoorStatus>;
    /**
     * Install Genie's CA into the OS trust store through ONE elevation. Trusted only when the store, read again
     * afterwards, holds the CA's thumbprint; a declined prompt or a failed install answers its reason and marks nothing.
     */
    trustCertificate(): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The person's Not now on the Deck's Trust item: not asked again for this CA (Hosting's line stays). */
    deferTrustCertificate(): void;
    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up — what the front door reads. */
    routes(): GenRoute[];
    /**
     * The `.gen` names the hosts file carries: every site that is CONFIGURED (servable, not declared `enabled: false`),
     * running or not — plus any site up right now, so a name Caddy serves always resolves (genie#624's union).
     */
    configuredHosts(): string[];
    /** The Deck's items from the stores, now. */
    deckItems(): DeckItem[];
    /** Every roster agent's full address with its name — the human's peer list. */
    agentAddresses(): Array<{ address: string; agentId: string; name: string }>;
    /** Resolve an address the way the inbox does: one / ambiguous (both forms named) / none / human. */
    resolveAddress(text: string): Resolution;
    /** Genie's tools as flow steps (genie#1204): main hands the call once it has built the tools (main/flow-tools.ts). */
    setFlowToolCaller(call: FlowToolCall): void;
    /** The registered workspaces' ids, now — what a flow's save checks a step's workspace against (genie#1204). */
    workspaceIds(): string[];
    shutdown(): Promise<void>;
}

/**
 * The EXTERNAL front door: Genie's bundled Caddy serving https://<name>.gen on 443 with GENIE'S OWN CA's leaf
 * (core/gen-ca.ts — Genie 1's CA adopted on upgrade, so a root the browser already trusts), as ONE supervised process
 * started with --watch, so the routes change by rewriting the Caddyfile and never by spawning a second Caddy. Without
 * a bundled binary nothing starts, and the reason is recorded for the Hosting surface — the in-app browser does not
 * need this path.
 */
interface FrontDoorController {
    status(): FrontDoorStatus;
    onChange(listener: () => void): () => void;
    settled(): Promise<void>;
    syncHosts(): Promise<HostsSyncResult>;
    /** Boot has loaded the workspaces' sites: the hosts file follows them from here, starting with one sync. */
    beginHosts(): void;
    retry(): Promise<FrontDoorStatus>;
    trust(): Promise<{ ok: true } | { ok: false; reason: string }>;
    deferTrust(): void;
    /** Genie's own Deck items about the front door: the one Trust ask. */
    deckItems(): DeckItem[];
    /** Shutdown: nothing more is started or synced. */
    close(): void;
}

const FRONT_DOOR_ID = 'genie-front-door';
const TRUST_STEP_ID = 'trust';

const NO_CADDY = 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Genie's `.gen` CA, opened ONCE for both doors: the external Caddy serves its leaf, and the in-app browser's tunnel
 * (S7) serves the same leaf and trusts the same root. A CA that cannot be set up is a reason, never a throw.
 */
function openGenCa(input: { caDir: string; v1CaDirs: readonly string[]; issuer: CertIssuer | undefined; now: () => number }): { ca: GenCa; error: null } | { ca: null; error: string } {
    try {
        return { ca: GenCa.open({ dir: input.caDir, v1Dirs: input.v1CaDirs, now: input.now, ...(input.issuer ? { issuer: input.issuer } : {}), log: (line) => console.log(line) }), error: null };
    } catch (error) {
        console.error(`[gen-ca] ${message(error)}`);
        return { ca: null, error: message(error) };
    }
}

function startExternalFrontDoor(input: {
    caddyBin: string | null;
    caddyDir: string;
    /** Opens the shared CA on first call (main: once, for both doors). */
    genCa: () => { ca: GenCa; error: null } | { ca: null; error: string };
    trustStore: TrustStorePort;
    platform: NodeJS.Platform;
    now: () => number;
    sites: SiteManager;
    /** Every route the door serves: the sites' and the shared engines' browser-facing ones (websocketRoutes). */
    routes: () => GenRoute[];
    /** Called when routes other than the sites' change (an engine attached or detached). */
    onRoutesChange: (listener: () => void) => void;
    /** The names the hosts file carries — configured, not running (ComposedServices.configuredHosts). */
    configuredHosts: () => readonly string[];
    supervisor: SupervisorApi;
    hostsIo: HostsIo;
    hostsPath: string;
    hostsDebounceMs: number;
    elevator: Elevator;
    ports: FrontDoorPorts;
}): FrontDoorController {
    const listeners = new Set<() => void>();
    const onChange = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
    const notify = () => { for (const l of listeners) l(); };
    const { caddyBin, caddyDir, sites, supervisor } = input;
    const off = (reason: string): FrontDoorController => ({
        status: () => ({ running: false, reason }),
        onChange,
        settled: async () => {},
        syncHosts: async () => { throw new Error(reason); },
        beginHosts: () => {},
        retry: async () => ({ running: false, reason }),
        trust: async () => ({ ok: false, reason }),
        deferTrust: () => {},
        deckItems: () => [],
        close: () => {},
    });
    if (caddyBin === null) return off(NO_CADDY);
    // Without a CA there is no certificate to serve: say so, and start nothing that would serve a broken one.
    const opened = input.genCa();
    if (opened.ca === null) return off(`Genie’s certificate authority could not be set up (${opened.error}); https://<name>.gen is off in external browsers and in the in-app browser`);
    const ca = opened.ca;
    const caddyfile = join(caddyDir, 'Caddyfile');
    // Caddy's storage: where XDG_DATA_HOME (below) has put it since the first beta, now named in the Caddyfile too.
    const caddyStorage = join(caddyDir, 'data', 'caddy');
    /** What this process last wrote to the Caddyfile; null = not yet, so the first render always writes. */
    let written: string | null = null;
    // Earlier betas remembered `caddy trust` (Caddy's own root) with this marker. Trust is read from the OS store now,
    // and that root is no longer served; the marker would only mislead whoever reads the folder.
    rmSync(join(caddyDir, 'trusted'), { force: true });
    let trusted: boolean | null = null;
    let trustError: string | null = null;
    let certificateError: string | null = null;
    let askedAt: number | null = null;
    let deferredFor = ca.trustDeferred();
    let trusting: Promise<{ ok: true } | { ok: false; reason: string }> | null = null;
    /** A front-door port another process holds (or the OS refused): Caddy is down on purpose, with the reason. */
    let blocked: FrontDoorBlocked | null = null;
    let failure: string | null = null;
    let closed = false;
    const reportFailure = (error: unknown) => {
        if (closed) return;
        failure = `Genie could not complete its external front door check: ${message(error)}`;
        notify();
    };
    // Include state updates and notifications in each completion, not just the underlying OS request.
    const pending = new Set<Promise<unknown>>();
    let generation = 0;
    const track = <T>(work: Promise<T>): Promise<T> => {
        generation += 1;
        const tracked: Promise<T> = work.finally(() => { pending.delete(tracked); });
        pending.add(tracked);
        return tracked;
    };
    const render = () => {
        const routes = input.routes();
        let tls: FrontDoorTls | null = null;
        if (routes.length > 0) {
            try {
                tls = ca.leafFor(routes.map((r) => r.host));
                certificateError = null;
            } catch (error) {
                // The previous Caddyfile (and leaf) stay as they were; the failure is a fact on the Hosting surface.
                certificateError = `Genie could not issue the certificate for ${routes.map((r) => r.host).join(', ')}: ${message(error)}`;
                console.error(`[gen-ca] ${certificateError}`);
                return;
            }
        }
        // Written only when the config CHANGED. render() runs on every process status change anywhere in Genie, and
        // each one rewrote the same bytes: a file write Defender scans and a reload decision Caddy's --watch makes.
        const next = frontDoorCaddyfile(routes, tls, caddyStorage);
        if (next === written) return;
        mkdirSync(caddyDir, { recursive: true });
        writeFileSync(caddyfile, next, 'utf8');
        written = next;
    };
    // READ from the OS store by the CA's thumbprint — never a marker. A store that cannot be read is untrusted with
    // the reason, so the person still has the Trust door.
    const readTrust = async (): Promise<boolean> => {
        let holds: boolean;
        try {
            holds = await input.trustStore.has(ca.thumbprint);
            if (holds) trustError = null;
        } catch (error) {
            holds = false;
            trustError = `Genie could not read the trust store: ${message(error)}`;
        }
        trusted = holds;
        return holds;
    };
    // The hosts block follows the CONFIGURED names, so a start or a stop never writes it (and never prompts); a burst of
    // changes is one write, one sync at a time, and a declined prompt is a recorded fact with the block to paste.
    const hosts = new HostsSync({
        names: input.configuredHosts,
        io: input.hostsIo,
        elevator: input.elevator,
        debounceMs: input.hostsDebounceMs,
        schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        onResult: notify,
    });
    render();
    sites.onChange(() => { render(); hosts.changed(); });
    input.onRoutesChange(() => { render(); hosts.changed(); });
    supervisor.onChange((status) => {
        render();
        // Started again (by the person's Restart in Processes, or by Try again): whatever held the port is asked anew —
        // Caddy's own words below set it again if it still cannot bind.
        if (status.id === FRONT_DOOR_ID && status.state === 'running' && (blocked !== null || failure !== null)) { blocked = null; failure = null; notify(); }
    });
    const spec = {
        id: FRONT_DOOR_ID,
        workspaceId: '_genie',
        name: 'Genie front door (Caddy)',
        command: `${caddyBin} run --config ${caddyfile} --adapter caddyfile --watch`,
        cwd: caddyDir,
        env: { XDG_DATA_HOME: join(caddyDir, 'data'), XDG_CONFIG_HOME: join(caddyDir, 'config') },
        restart: 'always' as const,
    };
    const block = (port: FrontDoorPort, holder: string | null, reason: string) => {
        blocked = { port, holder, reason };
        notify();
    };
    /** Caddy's recent output, across chunks (a line can arrive in two). */
    let output = '';
    // ASKED before Caddy starts: a port another process holds is reported, and Caddy is not started into a restart loop.
    const startCaddy = async (): Promise<void> => {
        for (const port of FRONT_DOOR_PORTS) {
            if ((await input.ports.probe(port)) !== 'held') continue;
            const holder = await input.ports.holder(port);
            if (closed) return;
            failure = null;
            block(port, holder, heldReason(port, holder));
            return;
        }
        if (closed) return;
        blocked = null;
        failure = null;
        output = '';
        supervisor.start(spec);
        notify();
    };
    // And READ from Caddy's own words while it runs: a bind that fails at start, or on a --watch reload that brings the
    // first route (with no routes Caddy binds nothing), stops the front door instead of letting `always` restart it.
    supervisor.onOutput((id, data) => {
        if (id !== FRONT_DOOR_ID || closed) return;
        output = (output + data).slice(-4_000);
        const failed = bindFailure(output);
        if (!failed) return;
        output = '';
        supervisor.stop(FRONT_DOOR_ID);
        block(failed.port, null, failed.kind === 'held' ? heldReason(failed.port, null) : `the front door could not listen on :${failed.port} (${failed.words}); https://<name>.gen in external browsers is off — the in-app browser still works`);
        // Who: when the OS lists a listener on the port, that process holds it — whatever words the bind failed with
        // (Windows answers "forbidden", not "in use", for a port http.sys holds).
        void track(input.ports.holder(failed.port).then((holder) => {
            if (holder !== null && blocked?.port === failed.port && blocked.holder === null) block(failed.port, holder, heldReason(failed.port, holder));
        }).catch((error: unknown) => {
            if (blocked?.port === failed.port && blocked.holder === null) reportFailure(error);
        }));
    });
    const status = (): FrontDoorStatus =>
        failure !== null
            ? { running: false, reason: failure, ...(blocked !== null ? { blocked: { port: blocked.port, holder: blocked.holder } } : {}) }
            : blocked !== null
            ? { running: false, reason: blocked.reason, blocked: { port: blocked.port, holder: blocked.holder } }
            : { running: true, caddyfile, hostsPath: input.hostsPath, hosts: hosts.result, authority: { source: ca.source, thumbprint: ca.thumbprint }, trusted, trustError, certificateError };
    void track(startCaddy().catch(reportFailure));
    void track(readTrust().then(notify));
    return {
        status,
        onChange,
        settled: async () => {
            for (;;) {
                const started = generation;
                await Promise.allSettled([...pending]);
                await hosts.settled();
                if (pending.size === 0 && started === generation) return;
            }
        },
        syncHosts: () => hosts.flush(),
        beginHosts: () => hosts.begin(),
        retry: async () => {
            if (supervisor.status(FRONT_DOOR_ID)?.state !== 'running') {
                await track(startCaddy().catch((error: unknown) => { reportFailure(error); throw error; }));
            }
            return status();
        },
        trust: () => {
            // One Trust at a time: the Deck's and Hosting's buttons pressed together raise ONE prompt. A hosts write that
            // is due rides in that same prompt (genie#604): trusting never costs two approvals.
            trusting ??= track((async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
                if (await readTrust()) { notify(); return { ok: true }; }
                const trustStep: PrivilegedStep = { id: TRUST_STEP_ID, label: 'install Genie’s certificate into the trust store', step: trustInstallStep(input.platform, ca.certPath) };
                let ran: readonly PrivilegedStep[] = [trustStep];
                const outcome = await hosts.joinElevation(async (hostsSteps) => {
                    ran = [trustStep, ...hostsSteps];
                    return { outcome: await input.elevator.run(ran), steps: ran };
                });
                const mine = stepOutcome(outcome, ran, TRUST_STEP_ID);
                if (!mine.ok) {
                    trustError = `Genie could not install its certificate into the trust store: ${mine.error}`;
                    notify();
                    return { ok: false, reason: trustError };
                }
                // The install said it worked; the store is the judge.
                trustError = null;
                if (!(await readTrust())) {
                    trustError ??= `the install finished, but the trust store does not hold Genie’s certificate (thumbprint ${ca.thumbprint})`;
                    notify();
                    return { ok: false, reason: trustError };
                }
                notify();
                return { ok: true };
            })().finally(() => { trusting = null; }));
            return trusting;
        },
        deferTrust: () => {
            ca.deferTrust();
            deferredFor = ca.thumbprint;
            notify();
        },
        deckItems: () => {
            const all = sites.list();
            if (trusted !== false || all.length === 0) return [];
            askedAt ??= input.now();
            const item = trustDeckItem({ trusted, sites: all.length, host: sites.routes()[0]?.host ?? all[0]?.host ?? null, deferredFor, thumbprint: ca.thumbprint, at: askedAt });
            return item ? [item] : [];
        },
        close: () => {
            closed = true;
            hosts.close();
        },
    };
}

/** How long a quit waits for in-flight flow runs before it goes on. */
const FLOW_SETTLE_ON_QUIT_MS = 5_000;

/** What a window that composed against genie-host's stores holds (the host split, P3.1). */
export type WindowServices = ComposedServices<WindowAgentStores>;

/** Compose with the stores agents write to opened HERE: the emergency path (no host), and every test that composes alone. */
export async function composeServices(input: Omit<ComposeInput, 'agentStores'>): Promise<ComposedServices<OwnAgentStores>> {
    return (await composeWith(input)) as ComposedServices<OwnAgentStores>;
}

/** Compose with genie-host's stores, through this window's replicas (the host split, P3.1). */
export async function composeWindowServices(input: ComposeInput & { readonly agentStores: WindowAgentStores }): Promise<WindowServices> {
    return composeWith(input);
}

async function composeWith(input: ComposeInput): Promise<WindowServices> {
    const now = input.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    await mkdir(runtimeDir(input.userData), { recursive: true });

    // THE SETTINGS (the host split, P3.2): genie-host's, through this window's replica — hot-swap kept: every change, by
    // whoever, fires the listeners below with the new value readable. Opened here only on the emergency path.
    let ownSettings: SettingsStore | null = null;
    if (!input.agentStores?.settings) {
        ownSettings = await SettingsStore.open(input.userData, iso);
        await ownSettings.carryOverFromV1(input.v1Settings());
    }
    const settings: S_Settings = input.agentStores?.settings ?? ownSettings!;

    // THE STORES AGENTS WRITE TO (the host split, P3.1): genie-host's, through this window's replicas — or, only when no
    // host could start, this window's own, opened here with Genie 1's history taken once.
    let ownStores: Awaited<ReturnType<typeof openAgentStores>> | null = null;
    if (!input.agentStores) {
        ownStores = await openAgentStores(input.userData, iso);
        importV1Knowledge(ownStores.knowledge, input.v1Knowledge);
        await importV1Inbox(ownStores.inbox, input.v1Inbox, input.roster?.() ?? [], now());
    }
    const inbox: WindowAgentStores['inbox'] = input.agentStores?.inbox ?? ownStores!.inbox;
    const attention: WindowAgentStores['attention'] = input.agentStores?.attention ?? ownStores!.attention;
    const knowledge: WindowAgentStores['knowledge'] = input.agentStores?.knowledge ?? ownStores!.knowledge;
    // FLOWS (P3.3d): genie-host's when it runs — its scheduler fires armed flows with no window, and this window reads and
    // drives them through a replica. This window's own (its store, scheduler and file trigger) only on the emergency path.
    // Genie's tools as flow steps (genie#1204): their kinds before the store reads any document that holds one.
    ensureFlowToolKinds();
    let ownFlows: FlowStore | null = null;
    if (!input.flowsEngine) {
        ownFlows = await FlowStore.open(input.userData, now);
        // Genie 1's FLOWS (genie#1204), once, DISARMED — before the scheduler plans, which arms nothing they bring.
        if (input.v1Flows) await runV1FlowImport(ownFlows, { database: input.v1Flows.database, workspaces: input.workspaces?.() ?? [] }).catch((error: unknown) => console.error(`[genie] v1 flows import failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    const flows: FlowsApi = input.flowsEngine?.flows ?? ownFlows!;

    // THE PROCESS SUPERVISOR (P3.3b): genie-host's when it runs — its restart policy keeps sites and workers alive with the
    // UI closed, and this window drives it through a replica. This window's own only on the emergency path.
    let supervisor: SupervisorApi;
    if (input.supervisor) supervisor = input.supervisor;
    else {
        const own = new ProcessSupervisor(input.processPty ?? input.pty, { now, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, input.pidAlive ? { pidAlive: input.pidAlive } : {});
        for (const pty of input.adoptPtys ?? []) own.adopt(pty);
        supervisor = own;
    }
    // ONE loopback allocator for sites and engines: two things never share a port — not a port an engine has
    // RECORDED (services.json, read through the registry every time), not one something else on this machine holds
    // (a bind probe), and the same ports for the same records after a restart (core/port-allocator.ts).
    let registry: ServiceRegistry | null = null;
    const portAllocator = input.allocatePort
        ? null
        // Reserved: every live engine's ports AND the ones a removed engine is remembered by (handed back on re-add).
        : new PortAllocator({ first: 4101, reserved: () => registry?.reservedPorts() ?? [], isFree: input.portFree ?? loopbackPortFree, log: (line) => console.error(line) });
    const allocatePort = input.allocatePort ?? (() => portAllocator!.next());
    // Only a pull gets the long bound (service-driver.ts); every other docker call keeps the short one.
    const docker: DockerRunner = input.docker ?? dockerRunnerOver(execFileRunner);
    const driver = new ServiceDriver(docker);
    const dockerEvents: DockerEventsPort | undefined = input.dockerEvents ?? (input.docker ? undefined : (args, onLine, onEnd) => lineStreamRunner('docker', args, onLine, onEnd));
    if (dockerEvents) driver.watch(dockerEvents);
    const engines = await ServiceRegistry.open(input.userData, driver, { allocatePort, randomPassword: () => randomBytes(18).toString('base64url'), portFree: input.portFree ?? loopbackPortFree });
    registry = engines;
    // Genie 1's engines, taken over in place (and its sandboxes stopped) BEFORE anything reads a workspace's env, primes
    // a port or reconciles: the adopted engines' ports are then reserved, and the reconcile sees them as registered.
    if (input.v1Services) {
        try {
            await runV1ServicesAdoption(engines, {
                database: input.v1Services.database,
                docker,
                reportFile: join(input.userData, 'v1-services.json'),
                now,
                workspaces: () => input.workspaces?.() ?? [],
            });
        } catch (error) {
            // Not recorded as done, so the next boot tries again; the engines Genie 2 already had are untouched.
            console.error(`[genie] taking over Genie 1's service engines failed: ${(error as Error).message}`);
        }
    }
    await portAllocator?.prime();
    // The person's engine Stops are machine-local like the sites' (site-run-state.json below): a restart keeps them stopped.
    const engineRunState = join(runtimeDir(input.userData), 'engine-run-state.json');
    const engineStopped = new Set<string>(
        await readJson<{ stopped?: unknown }>(engineRunState, { stopped: [] }).then((data) => (Array.isArray(data.stopped) ? data.stopped.filter((s): s is string => typeof s === 'string') : [])),
    );
    const saveEngineStopped = () => writeJsonAtomic(engineRunState, { stopped: [...engineStopped] });
    // WHO USES WHICH ENGINE, and who is asleep (core/hibernate-engines.ts; parity audit #12): the registry's chosen engine
    // per kind, and the registered workspaces as they are now.
    const engineUse = {
        chosen: (ws: string) => new Set(engines.choices(ws).flatMap((c) => (c.chosen ? [c.chosen.id] : []))),
        workspaces: () => (input.workspaces?.() ?? []).map((w) => ({ id: w.id, asleep: w.asleep === true })),
    };
    const enginePorts = {
        available: () => driver.available(),
        instances: () => engines.list(),
        state: async (id: string) => (await engines.status(id)).state,
    };
    // Not awaited: readiness is bounded in tens of seconds and nothing else at boot needs it. The readiness clock is
    // the real one, never `input.now` — a fixed test clock would never reach the deadline.
    const engineReconcile: Promise<ReconcileReport> = reconcileEngines(
        {
            ...enginePorts,
            personStopped: () => engineStopped,
            // A hibernated workspace stays asleep through a restart: an engine only sleeping workspaces use is not started.
            asleepOnly: (i) => asleepOnlyEngine(i, { chosen: engineUse.chosen, workspaces: engineUse.workspaces() }),
            start: (id) => engines.start(id),
            // Found running: a shared Redis's workspace users are put back (`start` above does it for one it starts).
            restore: (i) => engines.restoreSlices(i.id),
            answers: input.engineAnswers ?? ((i) => loopbackAnswers(i.publishedPort, readinessHandshake(i.engine))),
            now: Date.now,
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        input.engineReadiness ?? DEFAULT_READINESS,
    ).then(
        (report) => {
            for (const e of report.engines) if ('reason' in e) console.error(`[engines] ${e.outcome}: ${e.reason}`);
            return report;
        },
        (error: unknown): ReconcileReport => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[engines] the registered engines could not be checked at start: ${message}`);
            return { docker: null, engines: [], error: message };
        },
    );
    /** A source's app credential, while its workspace allows apps (the setting's default is on). */
    const appEnvOf = (source: AppEnvSource): Readonly<Record<string, string>> =>
        input.appInboxEnv && settings.snapshotFor(source.workspaceId).app_inbox !== false ? input.appInboxEnv(source) : {};
    const sites = new SiteManager({
        supervisor,
        allocatePort,
        caddyBin: input.caddyBin,
        configDir: join(runtimeDir(input.userData), 'sites'),
        writeConfig: (path, content) => {
            // Synchronous on purpose: the Caddy process is started right after and must find its file.
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, content, 'utf8');
        },
        // Every PHP worker trusts Genie's own CA too (core/php-trust.ts): a site's server side reaches https .gen addresses.
        phpWorkerEnv: () => phpWorkerEnvWithTrust({
            base: input.phpWorkerEnv?.() ?? {},
            genCaPem: () => { const opened = genCa(); if (opened.ca === null) return null; try { return readFileSync(opened.ca.certPath, 'utf8'); } catch { return null; } },
            systemRoots: () => input.phpSystemRoots?.() ?? null,
            dir: join(runtimeDir(input.userData), 'php-trust'),
            platform: process.platform,
            fs: {
                readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
                writeText: (p, t) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t, 'utf8'); },
            },
        }),
        ...(input.resolvePhpCgi ? { resolvePhpCgi: input.resolvePhpCgi } : {}),
        ...(input.preparePhpCgi ? { preparePhpCgi: input.preparePhpCgi } : {}),
        ...(input.phpWorkers !== undefined ? { phpWorkers: input.phpWorkers } : {}),
        serviceEnv: (workspaceId) => engines.envFor(workspaceId),
        ...(input.siteProbe ? { probeReady: input.siteProbe } : {}),
        appEnv: (site) => appEnvOf(site),
    });
    // An engine change reaches the running sites it changed the env of, with no restart asked of anyone.
    engines.onChange(() => { sites.serviceEnvChanged(); });
    // The app switch moved (genie#1345): that workspace's running sites gain or lose their app credential now.
    settings.onChange((key, _value, workspaceId) => { if (key === 'app_inbox') sites.serviceEnvChanged(workspaceId); });
    // The sites' routes and the shared WebSockets server's browser-facing ones (core/services.ts websocketRoutes).
    // Mailpit's web inbox at its .gen name (core/mailpit-name.ts): the Genie browser opens .gen sites only.
    const routes = () => [...sites.routes(), ...websocketRoutes(engines.list()), ...mailpitRoutes(engines.list())];
    // The person's site Stops are machine-local (never in the git-tracked envelope): one small file here.
    const siteRunState = join(runtimeDir(input.userData), 'site-run-state.json');
    const envelopeSites = new EnvelopeSites(sites, {
        fs: nodeEnvelopeFs(),
        runState: {
            load: async () => {
                const data = await readJson<{ stopped?: unknown }>(siteRunState, { stopped: [] });
                return Array.isArray(data.stopped) ? data.stopped.filter((s): s is string => typeof s === 'string') : [];
            },
            save: (stopped) => writeJsonAtomic(siteRunState, { stopped }),
        },
        envFor: (workspaceId) => engines.envFor(workspaceId),
        log: (line) => console.error(line),
    });
    // CONFIGURED, not running (genie#624): a site that exists resolves whether or not it is up, so a start or a stop never
    // moves the hosts file. Unioned with what is up only so a name Caddy serves always resolves (a site started by
    // hand that its envelope declares disabled).
    const configuredHosts = (): string[] => [
        ...new Set([
            ...sites.list().filter((s) => s.state !== 'unservable' && !envelopeSites.disabled(s.id)).map((s) => s.host),
            ...routes().map((r) => r.host),
        ]),
    ];
    // S7: the in-app browser opens https://<name>.gen through this door's CONNECT tunnel, terminated with Genie's leaf.
    // The CA is opened on first need — the external front door's start, or the browser's first .gen page — and once.
    let genCaOpened: ReturnType<typeof openGenCa> | null = null;
    const genCa = () => (genCaOpened ??= openGenCa({ caDir: join(runtimeDir(input.userData), 'gen-ca'), v1CaDirs: input.v1CaDirs ?? [], issuer: input.certIssuer, now }));
    let leafContexts: GenLeafContexts | null = null;
    const frontDoor = new GenRouterServer(routes, {
        tls: (host) => {
            const opened = genCa();
            if (opened.ca === null) throw new Error(`Genie’s certificate authority could not be set up (${opened.error})`);
            leafContexts ??= new GenLeafContexts(opened.ca, routes);
            return leafContexts.forHost(host);
        },
    });
    const frontDoorPort = await frontDoor.listen(input.frontDoorPort ?? 0);

    // An autonomous agent's gated actions run without asking, recorded (Tynn #801): read from its record at each ask.
    // A permission switch the person turned on answers its own actions the same way (genie#1294, SWITCH_ANSWERS).
    const ownApprovals = input.agentStores ? null : new ApprovalQueue({
        now,
        autoApproved: (caller) => (input.roster?.() ?? []).some((a) => a.id === caller.agentId && a.autoApprove === true),
        granted: (caller, action) => {
            const flag = SWITCH_ANSWERS[action];
            return flag !== undefined && (input.roster?.() ?? []).some((a) => a.id === caller.agentId && a[flag] === true);
        },
    });
    const approvals: WindowAgentStores['approvals'] = input.agentStores?.approvals ?? ownApprovals!;

    const hostName = input.hostName ?? hostname();
    // §6.7: plugins live beside the rest of Genie's state; signed by default, unsigned only under developer mode.
    const pluginsDir = join(input.userData, 'plugins');
    const openPlugins = () => PluginHost.open({ dir: pluginsDir, keys: PUBLISHER_KEYS, developerMode: settings.snapshot().developer_mode === true, official: OFFICIAL_PLUGINS });
    let plugins = await openPlugins();
    const remoteDevices = await DeviceStore.open(input.userData, { now, random: () => randomBytes(24).toString('base64url') });
    // A correct PIN raises "Pair this device?" here; only Allow pairs (q_8c07b142; Genie 1's confirmPair).
    const pairing = new PairApprovals({ host: hostName, now });
    const remote = new RemoteHost({
        api: input.remoteApi ?? { invoke: async () => { throw new Error(`${hostName} has no remote host API wired in this build`); }, onEvent: () => () => {}, workspaceOfAgent: () => null },
        hostName,
        baton: new Baton(),
        // The PIN from the CSPRNG (PairingPins' default), as Genie 1's crypto.randomInt — not Math.random (genie#1346).
        pins: new PairingPins({ now }),
        devices: remoteDevices,
        confirm: pairing,
        transport: input.remoteTransport ?? { onConnection: () => () => {} },
        now,
    });
    const elevationRun = (plan: { command: string; args: readonly string[] }) => execFileRunner(plan.command, plan.args, { timeoutMs: 300_000 });
    const frontDoorCtl = startExternalFrontDoor({
        caddyBin: input.caddyBin,
        caddyDir: join(runtimeDir(input.userData), 'caddy'),
        genCa,
        // Read-only: one PowerShell Test-Path per Root store on Windows, the System keychain on macOS, the bundles on Linux.
        trustStore: input.trustStore ?? osTrustStore(process.platform, (command, args) => execFileRunner(command, args, { timeoutMs: 20_000 })),
        platform: process.platform,
        now,
        sites,
        supervisor,
        routes,
        onRoutesChange: (listener) => { engines.onChange(listener); },
        configuredHosts,
        hostsIo: input.hostsIo ?? realHostsIo({ platform: process.platform, tmpDir: runtimeDir(input.userData) }),
        hostsPath: hostsFilePath(process.platform),
        hostsDebounceMs: input.hostsDebounceMs ?? 250,
        // Every elevation Genie raises goes through this one Elevator: one prompt at a time, batches carried whole.
        elevator: new Elevator(input.elevate ?? ((steps) => runElevatedBatch(process.platform, steps, elevationRun))),
        ports: input.frontDoorPorts ?? realFrontDoorPorts(process.platform, (command, args) => execFileRunner(command, args, { timeoutMs: 10_000 })),
    });
    // The workspaces' declared sites, after the front door so it re-renders as they start. Awaited: Hosting's
    // first snapshot lists them. A workspace added, hibernated or woken later is synced as it happens.
    const workspacesNow = (): readonly WorkspaceRef[] => input.workspaces?.() ?? [];
    await envelopeSites.sync(workspacesNow()).catch((error: unknown) => console.error(`[sites] the workspaces' sites could not be loaded: ${error instanceof Error ? error.message : String(error)}`));
    // Only now does the hosts file follow the sites: the boot's declare-and-start burst is ONE sync of the whole
    // configured set, never a write of a half-loaded list (which would drop names, then prompt again to add them).
    frontDoorCtl.beginHosts();
    // Each site repo's `.env` follows the workspace's engines: after the sites are known, and on every engine or site change.
    const envFiles = new DotEnvSync({
        envFor: (workspaceId) => engines.envFor(workspaceId),
        sites: () => sites.list(),
        fs: nodeEnvelopeFs(),
        gitIgnored: input.gitIgnored ?? gitIgnoredOver(execFileRunner),
        // The name each workspace was registered with (Settings → General "Env file name"); none recorded is `.env`.
        envFileOf: (workspaceId) => workspacesNow().find((w) => w.id === workspaceId)?.envFile,
        log: (line) => console.error(line),
    });
    const syncEnvFiles = () => { envFiles.syncAll().catch((error: unknown) => console.error(`[env] ${error instanceof Error ? error.message : String(error)}`)); };
    syncEnvFiles();
    engines.onChange(syncEnvFiles);
    sites.onChange(syncEnvFiles);
    const stopWatchingWorkspaces = input.onWorkspacesChange?.(() => {
        envelopeSites.sync(workspacesNow()).catch((error: unknown) => console.error(`[sites] ${error instanceof Error ? error.message : String(error)}`));
    }) ?? (() => {});
    const roster = (): readonly AgentRecord[] => input.roster?.() ?? [];
    // Who each agent is, for the Deck's names and the reminder/uncollected-mail counts: from the roster, now.
    const agents = (): Map<string, { name: string; workspaceId: string }> => new Map(roster().map((r) => [r.id as string, { name: r.name, workspaceId: r.workspaceId }]));
    const reminders = new ReminderBook();
    // What the sync did to each workspace's agent files, for Settings (nothing about them is silent).
    const agentFiles = new AgentFilesHealth();
    const tynnVaultFile = join(input.userData, 'agent-credentials', 'agents.json');
    const tynnSecretsPort: AgentSecrets = input.tynnSecrets ?? {
        probe: async () => ({ ok: false, reason: 'no keychain' }),
        get: async () => ({ kind: 'unavailable', reason: 'no keychain' }),
        set: async () => ({ ok: false, reason: 'no keychain' }),
    };
    const tynnTokens = tynnAgentTokens({ file: tynnVaultFile, secrets: tynnSecretsPort });
    /**
     * THE KEYS AN OLDER GENIE SEALED MOVE TO THE KEYCHAIN (P3.4 cut b's engine, switched on with this reader). At boot, so a host
     * that loses this window still has them; and awaited before a key is read. What could not move is tried again next time.
     */
    let keysMoved: Promise<void> | null = null;
    const stuckSaid = new Set<string>();
    const moveAgentKeys = (): Promise<void> => keysMoved ??= (async () => {
        const { tynnCipher, tynnVault } = input;
        if (!tynnCipher || !tynnVault) return;
        const sources = await gatherSources([
            { file: 'agents.json', covers: 'tynn/agent/', sources: () => tynnTokens.legacyKeys(tynnCipher) },
            { file: 'legacy secrets', covers: '', sources: async () => (await input.legacySecrets?.()) ?? [] },
        ]);
        const outcomes = await migrateSecrets(sources, tynnVault, migrationBook);
        if (outcomes.some((o) => o.status === 'moved')) input.onSecretsMoved?.();
        const stuck = outcomes.some((o) => !['moved', 'nothing', 'already'].includes(o.status));
        for (const line of stuckLines(outcomes, stuckSaid)) { console.error(line); input.secretsLog?.(line); }
        if (stuck) keysMoved = null;
    })().catch((error: unknown) => {
        keysMoved = null;
        const line = `[keychain] secrets could not be moved: ${error instanceof Error ? error.message : String(error)}`;
        console.error(line);
        input.secretsLog?.(line);
    });
    const migrationBook = fileMigrationBook(join(input.userData, 'keychain-migration.json'), { log: (line) => { console.error(line); input.secretsLog?.(line); } });
    void moveAgentKeys();
    // Cleanup and normal config sync share one writer; a concurrent sync cannot resurrect a removed legacy entry.
    const withConfig = configWriter();
    // A window running its own engine prepares its agents here (agent-tynn-prep.ts). With a host, the host does, and this goes unused.
    const tynnPrep = agentTynnPrep({
        vaultFile: tynnVaultFile,
        secrets: tynnSecretsPort,
        tynn: () => input.tynn?.() ?? null,
        workspaces: () => input.workspaces?.() ?? [],
        withConfig,
        ready: () => moveAgentKeys(),
    });
    const prepareAgentMcp = tynnPrep.prepare;
    const tynnNote = tynnPrep.note;
    const tynnRecovery = tynnPrep.recovery;
    // FLOWS RUN (P4): the scheduler fires an armed flow through the runner (flow-runner.ts) — a command as a supervised
    // process whose log is kept like any background process's, a prompt to a live agent (held back while it is mid-turn),
    // a knowledge write — and every run's outcome is recorded on the flow. Planned here, after every await that could
    // fail, so a composition that throws leaves no timer behind.
    const workspaceRef = (id: string): WorkspaceRef | undefined => workspacesNow().find((w) => w.id === id);
    const asleep = (id: string): boolean => workspaceRef(id)?.asleep === true;
    const sessions: AgentSessionsPort = input.agentSessions ?? { session: () => null, rows: () => [], prompt: () => false, subscribe: () => () => {} };
    const ownEngine = ownFlows ? startFlowsEngine({
        store: ownFlows,
        now,
        asleep,
        workspacePath: (id) => workspaceRef(id)?.path ?? null,
        sessions,
        resolve: (text) => resolveOnRoster(text, roster(), input.workspaceSlugs?.()),
        agent: (id) => agents().get(id) ?? null,
        supervisor,
        envFor: (id) => engines.envFor(id),
        addKnowledge: async (entry) => ({ id: (await knowledge.add(entry as never)).id }),
        attention,
    }) : null;
    const flowScheduler: FlowSchedulerApi = input.flowsEngine?.scheduler ?? ownEngine!.scheduler;
    // A running process is ASKED after on a heartbeat (P2): one whose pty vanished without an exit is a crash, not
    // "running". Started last, after every await that could fail, so a composition that throws leaves no timer behind.
    const stopLiveness = supervisor.watchLiveness();
    let down: Promise<void> | null = null;

    return {
        own: ownStores ? { ...ownStores, approvals: ownApprovals! } : null,
        ownFlows,
        inbox,
        prepareAgentMcp,
        tynnNote,
        tynnRecovery,
        moveSecretsAgain: moveAgentKeys,
        attention,
        knowledge,
        flows,
        flowScheduler,
        settings,
        supervisor,
        sites,
        envelopeSites,
        engines,
        engineReconcile,
        envFiles,
        engineStatuses: () => engineStatusesOf(enginePorts),
        engineDependents: (id) => {
            const i = engines.list().find((x) => x.id === id);
            if (!i) throw new Error(`no service ${id}`);
            const workspaceIds = new Set([
                ...(input.workspaces?.() ?? []).map((w) => w.id),
                ...(i.scope.kind === 'dedicated' ? [i.scope.workspaceId] : []),
                ...Object.keys(i.slices ?? {}),
                ...sites.list().map((x) => x.workspaceId),
                ...supervisor.list().map((x) => x.workspaceId),
            ]);
            const using = new Set([...workspaceIds].filter((ws) => (i.engine === 'custom' && i.scope.kind === 'dedicated' && i.scope.workspaceId === ws) || engines.choices(ws).some((c) => c.chosen?.id === id)));
            return [
                ...[...using].map((ws) => `workspace ${ws}`),
                ...sites.list().filter((x) => using.has(x.workspaceId) && ['running', 'starting', 'external'].includes(x.state)).map((x) => `site ${x.host} (workspace ${x.workspaceId})`),
                ...supervisor.list().filter((x) => using.has(x.workspaceId) && ['running', 'restarting'].includes(x.state)).map((x) => `process ${x.name} (workspace ${x.workspaceId})`),
            ];
        },
        startEngine: async (id) => {
            // The person wants it running: no longer stopped by them, even if Docker refuses (the refusal is the answer).
            if (engineStopped.delete(id)) await saveEngineStopped();
            await engines.start(id);
        },
        stopEngine: async (id) => {
            await engines.stop(id);
            engineStopped.add(id);
            await saveEngineStopped();
        },
        hibernationEngines: {
            toRelease: (workspaceId) => enginesToRelease({ workspaceId, instances: engines.list(), chosen: engineUse.chosen, workspaces: engineUse.workspaces() }),
            toResume: (workspaceId) => enginesToResume({ workspaceId, instances: engines.list(), chosen: engineUse.chosen, personStopped: engineStopped }),
            stop: (id) => engines.stop(id),
            start: (id) => engines.start(id),
        },
        removeEngine: async (id, options) => {
            await engines.remove(id, options);
            if (engineStopped.delete(id)) await saveEngineStopped();
        },
        frontDoor,
        approvals,
        remote,
        pairing,
        frontDoorPort,
        browserTrust: () => {
            const opened = genCa();
            return opened.ca ? { caPem: readFileSync(opened.ca.certPath, 'utf8'), thumbprint: opened.ca.thumbprint } : { caPem: null, reason: opened.error };
        },
        get externalFrontDoor() { return frontDoorCtl.status(); },
        onFrontDoorChange: frontDoorCtl.onChange,
        frontDoorSettled: frontDoorCtl.settled,
        syncHosts: frontDoorCtl.syncHosts,
        retryFrontDoor: frontDoorCtl.retry,
        trustCertificate: frontDoorCtl.trust,
        deferTrustCertificate: frontDoorCtl.deferTrust,
        routes,
        configuredHosts,
        deckItems: () => {
            const workspaceNames: Record<string, string> = Object.fromEntries((input.workspaces?.() ?? []).map((w) => [w.id, (input.workspaceName ?? folderName)(w.path)]));
            const workspaceColors: Record<string, string> = Object.fromEntries((input.workspaces?.() ?? []).flatMap((w) => {
                const color = input.workspaceColor?.(w.path) ?? null;
                return color ? [[w.id, color]] : [];
            }));
            return [
                // An approval is grouped under its workspace on the Deck like a question is, so it carries the same NAME (and colour).
                ...approvals.deckItems().map((i) => {
                    const name = i.workspaceId === null ? undefined : workspaceNames[i.workspaceId];
                    const color = i.workspaceId === null ? undefined : workspaceColors[i.workspaceId];
                    return name === undefined && color === undefined ? i : { ...i, ...(name === undefined ? {} : { workspaceName: name }), ...(color === undefined ? {} : { workspaceColor: color }) };
                }),
                ...frontDoorCtl.deckItems(),
                ...deckItemsFrom({
                    questions: attention.pending(),
                    userList: attention.allUserItems(),
                    unreadDms: inbox.unread(HUMAN),
                    finished: attention.finished(),
                    agents: Object.fromEntries(agents()),
                    workspaceNames,
                    workspaceColors,
                    ...(input.askerLive ? { asker: input.askerLive } : {}),
                }),
            ];
        },
        inboxReminders: ({ run }) => inboxNotices({ agents: agents(), unread: (id) => inbox.unread(id as never), reminders, run }),
        inboxNoticeSettled: (agentId, delivered) => reminders.settled(agentId, delivered),
        appEnv: (source) => appEnvOf(source),
        signals: ({ osAgentWorking, githubBlocked }) => ({
            flowsRunning: flowScheduler.inFlightCount(),
            // Mail agents have not collected: unread for every registered agent, the human excluded.
            uncollectedMail: [...agents().keys()].reduce((n, id) => n + inbox.unread(id as never).length, 0),
            githubBlocked,
            osAgentWorking,
        }),
        integrations: () => {
            return {
                mcp: { url: input.mcpEndpoint?.()?.url ?? null, verified: input.mcpVerification?.() ?? null, tools: input.mcpTools?.() ?? [] },
                agentFiles: agentFiles.list(),
            };
        },
        get plugins() { return plugins; },
        pluginsDir,
        pluginsRefresh: async () => { plugins = await openPlugins(); },
        syncConfig: async (workspacePath, source = 'start') => {
            const endpoint = input.mcpEndpoint?.() ?? null;
            if (!endpoint) {
                const reason = 'Genie has no MCP endpoint yet (the server is not listening); nothing to write into the workspace';
                agentFiles.config(workspacePath, [{ label: 'Genie MCP', ok: false, error: reason }], Date.now(), source);
                throw new Error(reason);
            }
            const values = settings.snapshot();
            const flag = (k: string) => values[k] !== false;
            const request: WorkspaceConfigRequest = { workspacePath, endpoint, flags: { mcp_sync_claude: flag('mcp_sync_claude'), mcp_sync_cursor: flag('mcp_sync_cursor'), mcp_sync_codex: flag('mcp_sync_codex'), mcp_sync_hooks: flag('mcp_sync_hooks') } };
            // One writer (workspace-config-sync.ts): the host's when there is one, and a failure there is not a reason to write here.
            const host = input.hostConfigSync?.() ?? null;
            const results = [...await (host ? host.configSync(request) : withConfig(workspacePath, () => writeWorkspaceConfig(request)))];
            agentFiles.config(workspacePath, results, Date.now(), source);
            return results;
        },
        syncAgentDocs: async (workspacePath, source = 'start') => {
            const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const on = settings.snapshot().mcp_sync_agents !== false;
            // One node fs for every step; each write and removal is reported to the health record Settings reads.
            const nodeFs = (touched: (path: string) => void) => ({
                read: async (p: string) => { try { return await readFileP(p, 'utf8'); } catch { return null; } },
                write: async (p: string, text: string) => { await mkdir(dirname(p), { recursive: true }); await writeFileP(p, text, 'utf8'); touched(p); },
                remove: async (p: string) => { try { await unlinkP(p); touched(p); } catch { /* not there: nothing to remove */ } },
                unlink: async (p: string) => { await unlinkP(p); touched(p); },
                list: async (d: string) => { try { return await readdirP(d); } catch { return []; } },
                removeDir: async (d: string) => { try { await rmdir(d); } catch { /* not empty or not there: left as it is */ } },
                isSymlink: async (p: string) => { try { return (await lstat(p)).isSymbolicLink(); } catch { return false; } },
                exists: async (p: string) => { try { await lstat(p); return true; } catch { return false; } },
            });
            const steps: AgentFilesStep[] = [
                // First, whatever the switches: the files that carry Genie's MCP token are kept out of a commit.
                { step: 'gitignore', run: (t) => writeAgentGitignore({ workspacePath, fs: nodeFs(t) }) },
                // The protocol files (.agents/_genie/), true for Genie 2, listing the tools Genie's MCP actually serves.
                { step: 'protocol', run: (t) => writeAgentProtocol({ workspacePath, enabled: on, tools: input.mcpTools?.() ?? [], fs: nodeFs(t) }) },
            ];
            if (on) {
                // The routers and RULES.md after the protocol they import (Genie 1's repaired); then Genie 2's skills.
                steps.push({ step: 'routers', run: (t) => writeAgentRouters({ workspacePath, stamp, fs: nodeFs(t) }) });
                steps.push({ step: 'skills', run: (t) => writeAgentSkills({ workspacePath, stamp, fs: nodeFs(t) }) });
            }
            // A failing step is recorded and does not stop the steps after it.
            const report = await agentFiles.run(workspacePath, steps, Date.now(), source);
            for (const f of report.failed) console.error(`[workspace-files] ${workspacePath} ${f.step}: ${f.error}`);
        },
        agentAddresses: () => { const slugs = input.workspaceSlugs?.() ?? new Map<string, string>(); return roster().map((r) => ({ address: agentAddress(r, slugs), agentId: r.id as string, name: r.name })); },
        // The inbox's own rule (core/inbox.ts), on the same roster the agents' tool uses: one rule for both.
        resolveAddress: (text) => resolveOnRoster(text, roster(), input.workspaceSlugs?.()),
        setFlowToolCaller: (call) => { ownEngine?.setToolCaller(call); },
        workspaceIds: () => workspacesNow().map((w) => w.id),
        shutdown: () => {
            down ??= (async () => {
                ownApprovals?.cancelAll('Genie is shutting down');
                stopWatchingWorkspaces();
                stopLiveness();
                driver.unwatch();
                // No flow fires from here: its timer is cancelled for good, so nothing starts after `settled()` answers (genie#1351).
                ownEngine?.stop();
                // Nothing more is started (a port probe still in flight) or synced (a pending hosts write) from here.
                frontDoorCtl.close();
                // EVERYTHING SUPERVISED STOPS FIRST, before anything is waited on (hosting fixes 2.2): behind the `.env`
                // pass below, a slow or stuck git kept every dev server, worker and the front door running — and a quit
                // that does not wait that long left them running for good.
                for (const p of supervisor.list()) supervisor.stop(p.id);
                // Then the `.env` pass in flight is let finish (compose-env-drain.test.ts): a quit mid-pass cut a write short.
                await envFiles.close();
                await new Promise<void>((r) => frontDoor.close(r));
                // A run's command was just stopped above (it records as failed); a run waiting on an agent's turn may not end
                // soon, and a quit does not wait on an agent — bounded, then the run is left unrecorded.
                let quitWait: ReturnType<typeof setTimeout> | undefined;
                if (ownEngine) await Promise.race([ownEngine.scheduler.settled(), new Promise<void>((r) => { quitWait = setTimeout(r, FLOW_SETTLE_ON_QUIT_MS); })]);
                clearTimeout(quitWait);
                // And the flows file's last write has landed (a held record, the run in flight kept as it goes).
                await ownFlows?.flushed();
                await remoteDevices.flushed();
                await portAllocator?.settled();
                ownStores?.knowledge.close();
            })();
            return down;
        },
    };
}

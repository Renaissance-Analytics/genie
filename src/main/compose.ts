import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir as readdirP, readFile as readFileP, rmdir, unlink as unlinkP, writeFile as writeFileP } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { deckItemsFrom, type AskerState } from '../core/deck-sources.js';
import { folderName } from '../core/workspace-name.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import { planV1KnowledgeImport, type V1Knowledge } from '../core/v1-import.js';
import type { V1Inbox } from '../core/v1-inbox.js';
import { runV1InboxImport } from './v1-inbox.js';
import { runV1FlowImport } from './v1-flows.js';
import { ensureFlowToolKinds, type FlowToolCall } from './flow-tools.js';
import { HUMAN, agentAddress, resolveAddress as resolveOnRoster, type InboxSessionProbe, type Resolution } from '../core/inbox.js';
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
import { holdMigration, portsOf } from './migration-holds.js';
import { McpPreparationError } from './mcp-preparation-error.js';
import { configWriter, writeWorkspaceConfig, type WorkspaceConfigRequest } from './workspace-config-sync.js';
import type { PluginsApi } from './plugins-replica.js';
import { LocalPlugins } from './plugins-host.js';
import { hostCatalog } from './genie-catalog.js';
import type { ElementDefinition } from '../core/catalog.js';
import { PluginHost } from './plugin-host.js';
import { PUBLISHER_KEYS } from '../core/plugin-keys.js';
import { OFFICIAL_PLUGINS } from '../core/official-plugins.js';
import type { Verification } from './mcp-server.js';
import { Baton, PairingPins } from '../core/remote.js';
import { PairApprovals } from '../core/pair-confirm.js';
import type { ServerTransport } from '../core/remote-protocol.js';
import { ApprovalQueue, SWITCH_ANSWERS } from './approval-queue.js';
import type { AgentSessionsPort } from './flow-runner.js';
import type { FlowScheduler } from './flow-scheduler.js';
import { startFlowsEngine } from './flows-engine.js';
import type { FlowSchedulerApi, FlowsApi } from './flows-host.js';
import { FlowStore } from './flow-store.js';
import type { OwnAgentStores, WindowAgentStores } from './agent-stores-api.js';
import { importV1Inbox, importV1Knowledge, openAgentStores } from './agent-stores-open.js';
import { runtimeDir } from './paths.js';
import { LocalStagingArea } from './local-staging-area.js';
import { ProcessSupervisor, type SupervisorApi } from './process-supervisor.js';
import type { ListedPty } from './spawn-host-protocol.js';
import { DeviceStore } from './remote-devices.js';
import { RemoteHost, type HostApi } from './remote-host.js';
import { setGitReadPolicy, trustAwarePolicy } from './git-read-policy.js';
import { writeGenieInstructions } from './genie-instructions.js';
import type { WorkTracking } from '../core/genie-protocol.js';
import { trustSteps, type TrustApi } from './hosting-trust.js';
import { SettingsStore } from './settings-store.js';
import type { WorkspaceRef } from './envelope-sites-host.js';
import type { PtyPort } from './terminal-host.js';
import { composeHosting, type HostingOptions } from './hosting-compose.js';
import { composeStageDiagnostics, type ComposeStageSample } from './compose-stage-diagnostics.js';
import type { EnginesApi, EnvelopeSitesApi, HostingApi, SitesApi } from './hosting-host.js';
import type { SiteManager } from './site-manager.js';
import type { EnvelopeSites } from './envelope-sites-host.js';
import type { ServiceRegistry } from './service-registry.js';
import type { DotEnvSync } from './dotenv-sync.js';
import type { GenRouterServer } from './gen-router-server.js';

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

export interface ComposeInput extends HostingOptions {
    /**
     * SAFE MODE (Tynn #386), on the emergency no-host path: this window's own flows, sites and engines start nothing by
     * themselves while it is on (window-safe-mode.ts reads it from the runtime files). `heldSite` names a site it held;
     * `safeModeLeft` is told when the person leaves it, so the own flow clock plans again.
     */
    readonly safeMode?: () => boolean;
    readonly heldSite?: (siteId: string, name: string) => void;
    readonly safeModeLeft?: (listener: () => void) => void;
    /** This Genie's build, said in the remote `welcome` (P10.1e). Absent = 'dev'. */
    readonly build?: string;
    /** Optional numeric diagnostics. The hosting fixture logs these only on Windows CI; production leaves it absent. */
    readonly onComposeStage?: (sample: ComposeStageSample) => void;
    /** Internal scheduling port: maintenance runs after ready, and the returned callback cancels a pending sweep. */
    readonly scheduleStagingSweep?: (work: () => Promise<void>) => () => void;
    readonly userData: string;
    /** Read-only live pause state for AgentInbox's automatic replies; no session is started by this probe. */
    readonly inboxSession?: InboxSessionProbe;
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
    /**
     * genie-host's front door, service engines and site routes, through this window's replica (the host split, P5a): this
     * window then builds none of its own. Absent = it builds its own (hosting-compose.ts) — the emergency path, until P6.
     */
    readonly hosting?: HostingApi;
    /** genie-host's plugins, through this window's replica (ADF A3, Tynn #447). Absent = this window opens its own (no host). */
    readonly plugins?: PluginsApi;
    /** genie-host's catalog, through this window's replica (ADF A4/A5). Absent = this window builds its own from its plugins. */
    readonly catalog?: { list(): ElementDefinition[] };
    /** genie-host's flows and their scheduler, through this window's replica (P3.3d). Absent = this window runs its own. */
    readonly flowsEngine?: { readonly flows: FlowsApi; readonly scheduler: FlowSchedulerApi };
    /**
     * Genie 1's database, for bringing its FLOWS over as disarmed canvas flows (main/v1-flows.ts, genie#1204). Absent = none.
     */
    readonly v1Flows?: { readonly database: string };
    /**
     * The live agent sessions a flow's `genie/agent_prompt` prompts (main.ts wires the session host), late-bound like the
     * roster. Absent = no agent is running, so a scheduled prompt fails with that reason.
     */
    readonly agentSessions?: AgentSessionsPort;
    readonly now?: () => number;
    /**
     * Whether a supervised process's pid is still a live OS process (`osPidAlive` in production, main.ts) — one of the two
     * questions the supervisor's liveness check asks (P2). Absent = only the pty engine is asked, so a test's fake pids
     * are never put to the real OS.
     */
    readonly pidAlive?: (pid: number) => boolean;
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
    /** A workspace's trust verdict moved. */
    readonly onTrustVerdict?: (workspaceId: string) => void;
    /** The slow pass over what a verdict reads. Absent = `TRUST_PASS_MS`. */
    readonly trustWatchEveryMs?: number;
    /** False = no folder watchers, the slow pass alone. Absent = watch. */
    readonly trustWatchFolders?: boolean;
    /**
     * The live agent roster — the same one the agents' own inbox tool resolves against. Late-bound: the registry
     * exists after composition. Addresses, names, uncollected mail and reminders all derive from it; absent = none.
     */
    readonly roster?: () => readonly AgentRecord[];
    /** Each workspace's address slug (registry.workspaceSlugs): an agent is `name@slug`. */
    readonly workspaceSlugs?: () => ReadonlyMap<string, string>;
    readonly refusalForRecipient?: (address: string) => string | null;
    readonly inboxParticipantVisible?: (id: string) => boolean;
    readonly inboxVisibilityVersion?: () => unknown;
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

export type { FrontDoorStatus } from './hosting-compose.js';

/**
 * What compose built. `S` is the stores agents write to as this window holds them: genie-host's replicas (engine mode,
 * `WindowServices`) or the stores themselves (`OwnAgentStores`, the default: the emergency path, and every test that composes alone).
 */
/** The settings as compose and its consumers use them: the store itself, or genie-host's through a replica (P3.2). */
type S_Settings = NonNullable<WindowAgentStores['settings']>;

export interface ComposedServices<S extends WindowAgentStores = OwnAgentStores> extends Omit<HostingApi, 'trustDeckItems' | 'shutdown' | 'sites' | 'engines' | 'envelopeSites' | 'trust'> {
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
    /**
     * WHAT EACH WORKSPACE'S OWN FILES SAY WOULD RUN, AND WHETHER THE PERSON HAS SAID YES TO IT (genie#1519). The host owns
     * it: genie-host's verdicts through this window's replica (failing closed before the first dump and after the link
     * drops), or this window's own hosting's on the emergency path, until P6.
     */
    readonly workspaceTrust: TrustApi;
    /** Genie's own files for an agent whose workspace is not trusted, or `null`. */
    untrustedFilesFor(record: { readonly workspaceId: string }): Promise<import('./session-host.js').GenieInstructionFiles | null>;
    /** The workspaces read and not trusted, with what would run: the person's trust step. */
    trustSteps(): readonly { readonly workspaceId: string; readonly changed: boolean; readonly list: import('../core/workspace-trust.js').TrustList }[];
    /** The verdict as last read, without reading: for a shell call. A workspace not read yet is not trusted. */
    untrustedNow(record: { readonly workspaceId: string }): boolean;
    /**
     * Genie's hosting (P5a): the classes themselves when THIS window built it (the emergency path, and every test that
     * composes alone); the narrow surface a window uses (hosting-host.ts) when it is genie-host's, through the replica.
     */
    readonly sites: S extends OwnAgentStores ? SiteManager : SitesApi;
    readonly envelopeSites: S extends OwnAgentStores ? EnvelopeSites : EnvelopeSitesApi;
    readonly engines: S extends OwnAgentStores ? ServiceRegistry : EnginesApi;
    /** The `.env` sync and the in-app front door, when THIS window built its hosting; null when they are genie-host's. */
    readonly envFiles: S extends OwnAgentStores ? DotEnvSync : DotEnvSync | null;
    readonly frontDoor: S extends OwnAgentStores ? GenRouterServer : GenRouterServer | null;
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
    /** §6.7: the plugins, genie-host's through its replica (ADF A3); re-read when developer mode changes. */
    readonly plugins: PluginsApi;
    /** This window's OWN plugins, opened only with no genie-host (the emergency path); `null` when the host owns them. */
    readonly ownPlugins: LocalPlugins | null;
    /**
     * Every element the catalog holds now (ADF A5): what the window's editors, panels and flow palette are projected from.
     * genie-host's through the replica; with no host, this window's own plugins' catalog.
     */
    catalogDefinitions(): readonly ElementDefinition[];
    readonly pluginsDir: string;
    /** Re-read the plugins folder (after developer mode flips, or a plugin was dropped in). */
    pluginsRefresh(): Promise<void>;
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
    mailRefusal(address: string): string | null;
    workspaceVisible(id: string): boolean;
    shutdown(): Promise<void>;
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
    // Tynn story #402: signed in to tynn.ai, the agents' protocol carries Tynn's work model; otherwise the plan-file fallback.
    const workTracking = (): WorkTracking => (input.tynn?.()?.status().signedIn === true ? 'tynn' : 'files');
    const stage = input.onComposeStage ? composeStageDiagnostics(input.onComposeStage) : null;
    const now = input.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    stage?.begin('runtime-directory');
    await mkdir(runtimeDir(input.userData), { recursive: true });
    stage?.end(); stage?.begin('local-staging');
    // No process discovery, staging directories or permission helper on the ready path. First use still verifies all of them.
    const createLocalUploads = async () => (await LocalStagingArea.open(input.userData)).createConnection(now);
    stage?.end();

    // THE SETTINGS (the host split, P3.2): genie-host's, through this window's replica — hot-swap kept: every change, by
    // whoever, fires the listeners below with the new value readable. Opened here only on the emergency path.
    let ownSettings: SettingsStore | null = null;
    stage?.begin('settings');
    if (!input.agentStores?.settings) {
        ownSettings = await SettingsStore.open(input.userData, iso);
        stage?.end(); stage?.begin('settings-carry-over');
        await ownSettings.carryOverFromV1(input.v1Settings());
    }
    stage?.end();
    const settings: S_Settings = input.agentStores?.settings ?? ownSettings!;

    // THE STORES AGENTS WRITE TO (the host split, P3.1): genie-host's, through this window's replicas — or, only when no
    // host could start, this window's own, opened here with Genie 1's history taken once.
    let ownStores: Awaited<ReturnType<typeof openAgentStores>> | null = null;
    stage?.begin('agent-stores');
    if (!input.agentStores) {
        ownStores = await openAgentStores(input.userData, iso, input.inboxSession);
        stage?.end(); stage?.begin('agent-store-imports');
        importV1Knowledge(ownStores.knowledge, input.v1Knowledge);
        await importV1Inbox(ownStores.inbox, input.v1Inbox, input.roster?.() ?? [], now());
    }
    stage?.end();
    const inbox: WindowAgentStores['inbox'] = input.agentStores?.inbox ?? ownStores!.inbox;
    const attention: WindowAgentStores['attention'] = input.agentStores?.attention ?? ownStores!.attention;
    const knowledge: WindowAgentStores['knowledge'] = input.agentStores?.knowledge ?? ownStores!.knowledge;
    const hiddenWorkspaces = () => (input.workspaces?.() ?? []).filter((w) => w.asleep === true).map((w) => w.id);
    ownStores?.knowledge.setHiddenWorkspaces(hiddenWorkspaces);
    ownStores?.inbox.setVisibility((message) => {
        if (input.inboxParticipantVisible) return input.inboxParticipantVisible(message.from) && input.inboxParticipantVisible(message.to);
        const hidden = new Set(hiddenWorkspaces());
        const ghosts = new Set((input.roster?.() ?? []).filter((r) => hidden.has(r.workspaceId)).map((r) => r.id as string));
        return !ghosts.has(message.from) && !ghosts.has(message.to);
    }, input.inboxVisibilityVersion);
    // FLOWS (P3.3d): genie-host's when it runs — its scheduler fires armed flows with no window, and this window reads and
    // drives them through a replica. This window's own (its store, scheduler and file trigger) only on the emergency path.
    // Genie's tools as flow steps (genie#1204): their kinds before the store reads any document that holds one.
    ensureFlowToolKinds();
    let ownFlows: FlowStore | null = null;
    stage?.begin('flows');
    if (!input.flowsEngine) {
        ownFlows = await FlowStore.open(input.userData, now);
        ownFlows.setHiddenWorkspaces(hiddenWorkspaces);
        // Genie 1's FLOWS (genie#1204), once, DISARMED — before the scheduler plans, which arms nothing they bring.
        if (input.v1Flows) await runV1FlowImport(ownFlows, { database: input.v1Flows.database, workspaces: input.workspaces?.() ?? [] }).catch((error: unknown) => console.error(`[genie] v1 flows import failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    stage?.end();
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
    /** A source's app credential, while its workspace allows apps (the setting's default is on). */
    const appEnvOf = (source: AppEnvSource): Readonly<Record<string, string>> =>
        input.appInboxEnv && settings.snapshotFor(source.workspaceId).app_inbox !== false ? input.appInboxEnv(source) : {};
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
    // §6.7: plugins live beside the rest of Genie's state; signed by default, unsigned only under developer mode. They are
    // GENIE-HOST'S (ADF A3, Tynn #447): this window reads them through the host's replica and opens no plugin host itself.
    const pluginsDir = join(input.userData, 'plugins');
    // With NO genie-host (the emergency path) this window loads its own, as it always did: no regression (the coordinator's
    // ruling for the owner, 2026-11-08); genie-host owns them whenever it is there.
    const openOwnPlugins = () => LocalPlugins.start(() => PluginHost.open({ dir: pluginsDir, keys: PUBLISHER_KEYS, developerMode: settings.snapshot().developer_mode === true, official: OFFICIAL_PLUGINS }));
    stage?.begin('plugins');
    const ownPlugins = input.plugins ? null : await openOwnPlugins();
    stage?.end();
    const plugins: PluginsApi = input.plugins ?? ownPlugins!;
    stage?.begin('remote-devices');
    const remoteDevices = await DeviceStore.open(input.userData, { now, random: () => randomBytes(24).toString('base64url') });
    stage?.end();
    // A correct PIN raises "Pair this device?" here; only Allow pairs (q_8c07b142; Genie 1's confirmPair).
    const pairing = new PairApprovals({ host: hostName, now });
    const remote = new RemoteHost({
        createLocalUploads,
        api: input.remoteApi ?? { invoke: async () => { throw new Error(`${hostName} has no remote host API wired in this build`); }, onEvent: () => () => {}, workspaceOfAgent: () => null },
        hostName,
        baton: new Baton(),
        // The PIN from the CSPRNG (PairingPins' default), as Genie 1's crypto.randomInt — not Math.random (genie#1346).
        pins: new PairingPins({ now }),
        devices: remoteDevices,
        confirm: pairing,
        transport: input.remoteTransport ?? { onConnection: () => () => {} },
        now,
        ...(input.build ? { build: input.build } : {}),
    });
    // THE FRONT DOOR, THE SERVICE ENGINES AND THE SITE ROUTES (the host split, P5a): genie-host's when it runs, through this
    // window's replica — this window then starts no Caddy, opens no engine registry and makes no CA. Its own
    // (hosting-compose.ts) only on the emergency path, built exactly as it always was.
    stage?.begin('hosting');
    const ownHosting = input.hosting ? null : await composeHosting({ ...input, supervisor, settings, appEnv: appEnvOf });
    stage?.end();
    const hosting: HostingApi = input.hosting ?? ownHosting!;
    const workspacesNow = (): readonly WorkspaceRef[] => input.workspaces?.() ?? [];
    // THE WORKSPACES' TRUST (genie#1519) is the hosting's. With genie-host's, this window's own git reads follow the host's
    // verdicts through the replica, which fails closed; the emergency path's own hosting set this process's policy itself.
    if (!ownHosting) {
        setGitReadPolicy(trustAwarePolicy((path) => hosting.trust.isTrustedPath(path)));
        hosting.trust.onVerdict((id) => input.onTrustVerdict?.(id));
    }
    const workspaceTrust = hosting.trust;
    /** A registered workspace's folder takes Genie's files once trusted. A folder that is no workspace is not this rule's. */
    const mayWriteInto = (folder: string): Promise<boolean> => workspacesNow().some((w) => w.path === folder && w.asleep === true) ? Promise.resolve(false) : workspaceTrust.mayWriteInto(folder);
    const roster = (): readonly AgentRecord[] => (input.roster?.() ?? []).filter((record) => !(input.workspaces?.() ?? []).some((workspace) => workspace.id === record.workspaceId && workspace.asleep === true));
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
        const outcomes = await migrateSecrets(...portsOf(holdMigration({ sources, vault: tynnVault, book: migrationBook })));
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
        envFor: (id) => hosting.engines.envFor(id),
        addKnowledge: async (entry) => ({ id: (await knowledge.add(entry as never)).id }),
        attention,
        ...(input.safeMode ? { safeMode: input.safeMode } : {}),
        // A Codex agent in a workspace not trusted gets a flow's values with Genie's skill names escaped (genie#1519).
        escapesPromptValues: (address) => {
            const found = resolveOnRoster(address, roster(), input.workspaceSlugs?.());
            if (found.kind !== 'one') return false;
            const agent = roster().find((r) => r.id === found.id);
            if (agent?.provider !== 'codex') return false;
            const workspace = workspacesNow().find((w) => w.id === agent.workspaceId);
            return workspace !== undefined && hosting.trust.view(workspace.id)?.trusted !== true;
        },
    }) : null;
    // Leaving safe mode arms the own flow clock again; it starts nothing by itself.
    if (ownEngine) input.safeModeLeft?.(() => { ownEngine.scheduler.plan(); });
    let flowVisibility = JSON.stringify(hiddenWorkspaces().sort());
    const stopFlowVisibility = input.onWorkspacesChange?.(() => {
        const key = JSON.stringify(hiddenWorkspaces().sort());
        if (key === flowVisibility) return;
        flowVisibility = key; ownFlows?.visibilityChanged();
    });
    const flowScheduler: FlowSchedulerApi = input.flowsEngine?.scheduler ?? ownEngine!.scheduler;
    // A running process is ASKED after on a heartbeat (P2): one whose pty vanished without an exit is a crash, not
    // "running". Started last, after every await that could fail, so a composition that throws leaves no timer behind.
    const stopLiveness = supervisor.watchLiveness();
    let down: Promise<void> | null = null;

    const stagingSweep = new AbortController();
    let sweeping: Promise<void> | null = null;
    const sweepOldStaging = (): Promise<void> => sweeping ??= LocalStagingArea.sweepOld(input.userData, { signal: stagingSweep.signal })
        .catch(() => { if (!stagingSweep.signal.aborted) console.warn('[genie] old local staging could not be swept'); });
    const stopStagingSweep = input.scheduleStagingSweep ? input.scheduleStagingSweep(sweepOldStaging) : (() => {
        const timer = setTimeout(() => { void sweepOldStaging(); }, 0); timer.unref();
        return () => clearTimeout(timer);
    })();
    stage?.ready();
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
        sites: hosting.sites,
        envelopeSites: hosting.envelopeSites,
        engines: hosting.engines,
        engineReconcile: hosting.engineReconcile,
        envFiles: ownHosting?.envFiles ?? null,
        engineStatuses: () => hosting.engineStatuses(),
        engineDependents: (id) => hosting.engineDependents(id),
        startEngine: (id) => hosting.startEngine(id),
        stopEngine: (id) => hosting.stopEngine(id),
        hibernationEngines: hosting.hibernationEngines,
        removeEngine: (id, options) => hosting.removeEngine(id, options),
        updateEngine: (id, options) => hosting.updateEngine(id, options),
        hostingProblems: () => hosting.hostingProblems(),
        frontDoor: ownHosting?.frontDoor ?? null,
        workspaceTrust,
        untrustedFilesFor: async (record) => {
            const workspace = workspacesNow().find((w) => w.id === record.workspaceId);
            // Not in a workspace: the built-in Genie agent, in a folder of Genie's own.
            if (!workspace) return null;
            const view = await workspaceTrust.refresh(workspace.id).catch(() => null);
            if (view !== null && view.trusted) return null;
            return writeGenieInstructions(join(runtimeDir(input.userData), 'untrusted-agent'), input.mcpTools?.() ?? [], workTracking());
        },
        trustSteps: () => trustSteps(workspaceTrust.entries()),
        untrustedNow(record) {
            const workspace = workspacesNow().find((w) => w.id === record.workspaceId);
            if (!workspace) return false;
            return workspaceTrust.view(workspace.id)?.trusted !== true;
        },
        approvals,
        remote,
        pairing,
        // Read at each use (P5a.2): a host that comes back on a new port reaches this window.
        get frontDoorPort() { return hosting.frontDoorPort; },
        browserTrust: () => hosting.browserTrust(),
        get externalFrontDoor() { return hosting.externalFrontDoor; },
        onFrontDoorChange: (listener) => hosting.onFrontDoorChange(listener),
        frontDoorSettled: () => hosting.frontDoorSettled(),
        syncHosts: () => hosting.syncHosts(),
        retryFrontDoor: () => hosting.retryFrontDoor(),
        trustCertificate: () => hosting.trustCertificate(),
        deferTrustCertificate: () => hosting.deferTrustCertificate(),
        routes: () => hosting.routes(),
        configuredHosts: () => hosting.configuredHosts(),
        deckItems: () => {
            const awake = (input.workspaces?.() ?? []).filter((workspace) => workspace.asleep !== true);
            const workspaceNames: Record<string, string> = Object.fromEntries(awake.map((w) => [w.id, (input.workspaceName ?? folderName)(w.path)]));
            const workspaceColors: Record<string, string> = Object.fromEntries(awake.flatMap((w) => {
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
                ...hosting.trustDeckItems(),
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
        plugins,
        ownPlugins,
        catalogDefinitions: () => (input.catalog ? input.catalog.list() : hostCatalog(ownPlugins ?? { tools: () => [] }).list()),
        pluginsDir,
        pluginsRefresh: () => plugins.refresh(),
        syncConfig: async (workspacePath, source = 'start') => {
            // Nothing of Genie's goes into a folder the person has not trusted, its token above all.
            if (!(await mayWriteInto(workspacePath))) return [];
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
            if (!(await mayWriteInto(workspacePath))) return;
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
                { step: 'protocol', run: (t) => writeAgentProtocol({ workspacePath, enabled: on, tools: input.mcpTools?.() ?? [], tracking: workTracking(), fs: nodeFs(t) }) },
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
        mailRefusal: (text) => input.refusalForRecipient?.(text) ?? null,
        workspaceVisible: (id) => !hiddenWorkspaces().includes(id),
        setFlowToolCaller: (call) => { ownEngine?.setToolCaller(call); },
        workspaceIds: () => workspacesNow().filter((workspace) => workspace.asleep !== true).map((workspace) => workspace.id),
        shutdown: () => {
            setGitReadPolicy(null);
            down ??= (async () => {
                stagingSweep.abort(); stopStagingSweep();
                ownApprovals?.cancelAll('Genie is shutting down');
                stopLiveness();
                stopFlowVisibility?.();
                // No flow fires from here: its timer is cancelled for good, so nothing starts after `settled()` answers (genie#1351).
                ownEngine?.stop();
                // Nothing more is started (a port probe still in flight) or synced (a pending hosts write, the docker watch, a
                // workspace change) from here.
                ownHosting?.quiesce();
                // EVERYTHING SUPERVISED STOPS FIRST, before anything is waited on (hosting fixes 2.2): behind the `.env`
                // pass below, a slow or stuck git kept every dev server, worker and the front door running — and a quit
                // that does not wait that long left them running for good. Only what THIS window runs: genie-host's
                // supervised processes (its sites, its front door, its kept workers) are the host's to stop, at "Shut down
                // everything" (host-shutdown.ts), and "Just close the UI" keeps them (P5a.3).
                if (!input.supervisor) for (const p of supervisor.list()) supervisor.stop(p.id);
                // Then the `.env` pass in flight is let finish (compose-env-drain.test.ts): a quit mid-pass cut a write short.
                await ownHosting?.drainEnvFiles();
                // The trust passes end before the front door: a pass in flight reads git in a workspace and writes the record.
                await ownHosting?.closeTrust();
                if (!ownHosting) setGitReadPolicy(null);
                await ownHosting?.closeFrontDoor();
                // A run's command was just stopped above (it records as failed); a run waiting on an agent's turn may not end
                // soon, and a quit does not wait on an agent — bounded, then the run is left unrecorded.
                let quitWait: ReturnType<typeof setTimeout> | undefined;
                if (ownEngine) await Promise.race([ownEngine.scheduler.settled(), new Promise<void>((r) => { quitWait = setTimeout(r, FLOW_SETTLE_ON_QUIT_MS); })]);
                clearTimeout(quitWait);
                // And the flows file's last write has landed (a held record, the run in flight kept as it goes).
                await ownFlows?.flushed();
                await remoteDevices.flushed();
                await ownHosting?.settled();
                await sweeping;
                ownStores?.knowledge.close();
            })();
            return down;
        },
    };
}

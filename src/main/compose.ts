import { describeMcpTool } from '../core/mcp-tool-summaries.js';
import { featureWorkspaceFiles } from './feature-workspace-files.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AskerState } from '../core/deck-sources.js';
import { type V1Knowledge } from '../core/v1-import.js';
import type { V1Inbox } from '../core/v1-inbox.js';
import { runV1FlowImport } from './v1-flows.js';
import { flowPillSignals } from '../core/flow-pill-signals.js';
import { ensureFlowToolKinds } from './flow-tools.js';
import { agentAddress, resolveAddress as resolveOnRoster, type InboxSessionProbe } from '../core/inbox.js';
import type { AgentRecord } from '../core/identity.js';
import { ReminderBook } from '../core/inbox-reminders.js';
import { inboxNotices } from './inbox-notices.js';
import type { AppEnvSource } from './app-inbox-service.js';
import { AgentFilesHealth } from '../core/agent-files-health.js';
import { configWriter, writeWorkspaceConfig, type WorkspaceConfigRequest } from './workspace-config-sync.js';
import { PluginsReplica, type PluginsApi } from './plugins-replica.js';
import { hostCatalog } from './genie-catalog.js';
import type { Verification } from './mcp-server.js';
import { assembleDeckItems } from './deck-assembly.js';
import { ApprovalQueue, SWITCH_ANSWERS } from './approval-queue.js';
import type { AgentSessionsPort } from './flow-runner.js';
import { startFlowsEngine } from './flows-engine.js';
import type { FlowSchedulerApi, FlowsApi } from './flows-host.js';
import { FlowStore } from './flow-store.js';
import type { WindowAgentStores } from './agent-stores-api.js';
import { importV1Inbox, importV1Knowledge, openAgentStores } from './agent-stores-open.js';
import { attentionLimitsFrom } from './attention-store.js';
import { runtimeDir } from './paths.js';
import { ProcessSupervisor, type SupervisorApi } from './process-supervisor.js';
import { RemoteAccessReplica } from './remote-access-replica.js';
import { hostname } from 'node:os';
import { setGitReadPolicy, trustAwarePolicy } from './git-read-policy.js';
import { writeGenieInstructions } from './genie-instructions.js';
import type { WorkTracking } from '../core/genie-protocol.js';
import { trustSteps } from './hosting-trust.js';
import { SettingsStore } from './settings-store.js';
import type { WorkspaceRef } from './envelope-sites-host.js';
import type { HostingComposeInput, HostingOptions, HostingStack } from './hosting-compose.js';
import { composeStageDiagnostics, type ComposeStageSample } from './compose-stage-diagnostics.js';
import type { HostingApi } from './hosting-host.js';

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
    readonly userData: string;
    /** Read-only live pause state for AgentInbox's automatic replies; no session is started by this probe. */
    readonly inboxSession?: InboxSessionProbe;
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
     * genie-host's front door, service engines and site routes, through this window's replica (the host split, P5a): the
     * window builds none of its own (Tynn #584).
     */
    readonly hosting?: HostingApi;
    /** Tests that compose alone hand in a real hosting stack (test/helpers/compose-alone.ts). Nothing in the app does. */
    readonly buildOwnHosting?: (input: HostingComposeInput) => Promise<HostingStack>;
    /** The same for what genie-host owns besides (Tynn #594): only a test that composes alone sets this. */
    readonly alone?: ComposeAlone;
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
    /**
     * Remote access is genie-host's (Tynn #409, P5d.1): the paired devices, the PIN, the pair prompts, the baton and the lock.
     * A client is a dumb terminal and serves no remote connection (Tynn #898 step 2d-4b2): this window's protocol door
     * tunnels to genie-host's RemoteHost. Since Tynn #997 (2g-4a) the app's window passes none: Settings draws remote access
     * from genie-host's features and main's notifications read remote.watch; only a test that composes alone hands one in.
     */
    readonly remoteAccess?: RemoteAccessReplica;
    /**
     * A site's or a kept process's OWN app credential (genie#1345, main/app-inbox-service.ts): `GENIE_INBOX_URL` and
     * `GENIE_INBOX_TOKEN`, or nothing. Compose lays it over THAT site's env only — never the service env — and gives none
     * while the workspace's "Apps and scripts may message agents here" (`app_inbox`) is off. Absent = no app door.
     */
    readonly appInboxEnv?: (source: AppEnvSource) => Readonly<Record<string, string>>;
    /** Genie's own MCP endpoint for agents, once the server listens; `null` until then (config sync refuses). */
    readonly mcpEndpoint?: () => { url: string; token: string } | null;
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

import type { ComposedServices, WindowServices } from './host-services.js';
export type { FrontDoorStatus } from './hosting-compose.js';
export type { ComposedServices, WindowServices } from './host-services.js';

/** The settings as compose and its consumers use them: the store itself, or genie-host's through a replica (P3.2). */
type S_Settings = NonNullable<WindowAgentStores['settings']>;

/** What a test that composes alone opens for itself. The app never does: every one of these is genie-host's (Tynn #594). */
export interface ComposeAlone {
    openSettings(): Promise<SettingsStore>;
    openStores(limits: () => ReturnType<typeof attentionLimitsFrom>): Promise<OwnStores>;
    openFlows(): Promise<FlowStore>;
    readonly startFlows: typeof startFlowsEngine;
    supervisor(): ProcessSupervisor;
    approvals(options: ConstructorParameters<typeof ApprovalQueue>[0]): ApprovalQueue;
}
type OwnStores = Awaited<ReturnType<typeof openAgentStores>>;


/** How long a quit waits for in-flight flow runs before it goes on. */
const FLOW_SETTLE_ON_QUIT_MS = 5_000;



/** The composition itself: the TESTS' (test/helpers/compose-alone.ts). The app composes nothing: its services are genie-host's (Tynn #955). */
export async function composeWith(input: ComposeInput): Promise<WindowServices> {
    if (!input.agentStores?.settings && !input.alone) throw new Error("compose was given no settings: they are genie-host's");
    // Tynn story #402: signed in to tynn.ai, the agents' protocol carries Tynn's work model; otherwise the plan-file fallback.
    // The window holds no Tynn account (Tynn #959) and writes no agent's docs: genie-host decides it from its own account
    // (genie-host.ts featureWorkspaceFiles). What the window composes alone is a test's, and says the fallback (Tynn #961).
    const workTracking = (): WorkTracking => 'files';
    // Remote access is genie-host's: with none handed in, the window's stand-in answers nothing, and refuses whatever is asked.
    const remoteAccess: RemoteAccessReplica = input.remoteAccess ?? new RemoteAccessReplica(hostname(), async () => { throw new Error("remote access is genie-host's"); });
    const stage = input.onComposeStage ? composeStageDiagnostics(input.onComposeStage) : null;
    const now = input.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    stage?.begin('runtime-directory');
    await mkdir(runtimeDir(input.userData), { recursive: true });
    stage?.end();

    // THE SETTINGS (the host split, P3.2): genie-host's, through this window's replica — hot-swap kept: every change, by
    // whoever, fires the listeners below with the new value readable. Opened here only on the emergency path.
    let ownSettings: SettingsStore | null = null;
    stage?.begin('settings');
    if (!input.agentStores?.settings) {
        ownSettings = await input.alone!.openSettings();
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
        ownStores = await input.alone!.openStores(() => attentionLimitsFrom(settings.snapshot()));
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
        ownFlows = await input.alone!.openFlows();
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
    else supervisor = input.alone!.supervisor();
    /** A source's app credential, while its workspace allows apps (the setting's default is on). */
    const appEnvOf = (source: AppEnvSource): Readonly<Record<string, string>> =>
        input.appInboxEnv && settings.snapshotFor(source.workspaceId).app_inbox !== false ? input.appInboxEnv(source) : {};
    // An autonomous agent's gated actions run without asking, recorded (Tynn #801): read from its record at each ask.
    // A permission switch the person turned on answers its own actions the same way (genie#1294, SWITCH_ANSWERS).
    const ownApprovals = input.agentStores ? null : input.alone!.approvals({
        now,
        autoApproved: (caller) => (input.roster?.() ?? []).some((a) => a.id === caller.agentId && a.autoApprove === true),
        granted: (caller, action) => {
            const flag = SWITCH_ANSWERS[action];
            return flag !== undefined && (input.roster?.() ?? []).some((a) => a.id === caller.agentId && a[flag] === true);
        },
    });
    const approvals: WindowAgentStores['approvals'] = input.agentStores?.approvals ?? ownApprovals!;

    // §6.7: plugins live beside the rest of Genie's state; signed by default, unsigned only under developer mode. They are
    // GENIE-HOST'S (ADF A3, Tynn #447): this window reads them through the host's replica and opens no plugin host itself.
    const pluginsDir = join(input.userData, 'plugins');
    // genie-host's plugins and catalog are read in genie-host (feature-machine.ts runs there): the window keeps an empty stand-in (Tynn #961).
    const plugins: PluginsApi = new PluginsReplica(async () => false);
    // THE FRONT DOOR, THE SERVICE ENGINES AND THE SITE ROUTES (the host split, P5a): genie-host's when it runs, through this
    // window's replica — this window then starts no Caddy, opens no engine registry and makes no CA.
    stage?.begin('hosting');
    if (!input.hosting && !input.buildOwnHosting) throw new Error("compose was given no hosting: it is genie-host's");
    const ownHosting = input.hosting ? null : await input.buildOwnHosting!({ ...input, supervisor, settings, appEnv: appEnvOf });
    stage?.end();
    const hosting: HostingApi = input.hosting ?? ownHosting!;
    const workspacesNow = (): readonly WorkspaceRef[] => input.workspaces?.() ?? [];
    // THE WORKSPACES' TRUST (genie#1519) is the hosting's. With genie-host's, this window's own git reads follow the host's
    // verdicts through the replica, which fails closed.
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
    // Cleanup and normal config sync share one writer; a concurrent sync cannot resurrect a removed legacy entry.
    const withConfig = configWriter();
    // FLOWS RUN (P4): the scheduler fires an armed flow through the runner (flow-runner.ts) — a command as a supervised
    // process whose log is kept like any background process's, a prompt to a live agent (held back while it is mid-turn),
    // a knowledge write — and every run's outcome is recorded on the flow. Planned here, after every await that could
    // fail, so a composition that throws leaves no timer behind.
    const workspaceRef = (id: string): WorkspaceRef | undefined => workspacesNow().find((w) => w.id === id);
    const asleep = (id: string): boolean => workspaceRef(id)?.asleep === true;
    const sessions: AgentSessionsPort = input.agentSessions ?? { session: () => null, rows: () => [], prompt: () => false, subscribe: () => () => {} };
    const ownEngine = ownFlows ? input.alone!.startFlows({
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

    // Old local staging is swept by genie-host (host-staging-sweep.ts, Tynn #955): the composition sweeps nothing.
    stage?.ready();
    return {
        own: ownStores ? { ...ownStores, approvals: ownApprovals! } : null,
        ownFlows,
        inbox,
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
        remote: remoteAccess,
        pairing: remoteAccess.pairing,
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
        deferHosts: () => hosting.deferHosts(),
        routes: () => hosting.routes(),
        configuredHosts: () => hosting.configuredHosts(),
        // One assembly for the window's Deck and genie-host's (deck-assembly.ts, Tynn #551).
        deckItems: () => assembleDeckItems({
            workspaces: input.workspaces?.() ?? [],
            workspaceName: input.workspaceName,
            workspaceColor: input.workspaceColor,
            approvals: approvals.deckItems(),
            trust: hosting.trustDeckItems(),
            attention,
            inbox,
            agents: Object.fromEntries(agents()),
            ...(input.askerLive ? { asker: input.askerLive } : {}),
        }),
        inboxReminders: ({ run }) => inboxNotices({ agents: agents(), unread: (id) => inbox.unread(id as never), reminders, run }),
        inboxNoticeSettled: (agentId, delivered) => reminders.settled(agentId, delivered),
        appEnv: (source) => appEnvOf(source),
        signals: ({ osAgentWorking, githubBlocked }) => ({
            flowsRunning: flowScheduler.inFlightCount(),
            ...flowPillSignals(flows.list(), Date.now()),
            // Mail agents have not collected: unread for every registered agent, the human excluded.
            uncollectedMail: [...agents().keys()].reduce((n, id) => n + inbox.unread(id as never).length, 0),
            githubBlocked,
            osAgentWorking,
        }),
        integrations: () => {
            return {
                mcp: { url: input.mcpEndpoint?.()?.url ?? null, verified: input.mcpVerification?.() ?? null, tools: (input.mcpTools?.() ?? []).map((t) => describeMcpTool(t.name, t.description, (t as { someAgents?: boolean }).someAgents === true)) },
                agentFiles: agentFiles.list(),
            };
        },
        plugins,
        catalogDefinitions: () => hostCatalog({ tools: () => [] }).list(),
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
            // One writer (workspace-config-sync.ts). In the app that is genie-host's own (genie-host.ts `featureConfig`): the
            // window never asks this (Tynn #1043), so the write here is a composition's that runs alone.
            const results = [...await withConfig(workspacePath, () => writeWorkspaceConfig(request))];
            agentFiles.config(workspacePath, results, Date.now(), source);
            return results;
        },
        syncAgentDocs: (workspacePath, source = 'start') => {
            return featureWorkspaceFiles({ mayWriteInto, settings, health: agentFiles,
                tools: () => input.mcpTools?.() ?? [], tracking: workTracking }).syncAgentDocs(workspacePath, source);
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
                await ownHosting?.settled();
                ownStores?.knowledge.close();
            })();
            return down;
        },
    };
}

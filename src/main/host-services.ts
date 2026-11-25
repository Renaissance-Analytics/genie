import type { AgentFilesReport, SyncSource } from '../core/agent-files-health.js';
import type { ElementDefinition } from '../core/catalog.js';
import type { DeckItem, SignalState } from '../core/deck.js';
import type { Resolution } from '../core/inbox.js';
import type { SyncResult } from '../core/integrations.js';
import type { McpToolRow } from '../core/mcp-tool-summaries.js';
import type { NoticeMail } from '../core/stream-event.js';
import type { OwnAgentStores, WindowAgentStores } from './agent-stores-api.js';
import type { AppEnvSource } from './app-inbox-service.js';
import type { DotEnvSync } from './dotenv-sync.js';
import type { EnvelopeSites } from './envelope-sites-host.js';
import type { FlowScheduler } from './flow-scheduler.js';
import type { FlowStore } from './flow-store.js';
import type { FlowToolCall } from './flow-tools.js';
import type { FlowSchedulerApi, FlowsApi } from './flows-host.js';
import type { GenRouterServer } from './gen-router-server.js';
import type { EnginesApi, EnvelopeSitesApi, HostingApi, SitesApi } from './hosting-host.js';
import type { TrustApi } from './hosting-trust.js';
import type { Verification } from './mcp-server.js';
import type { PluginsApi } from './plugins-replica.js';
import type { SupervisorApi } from './process-supervisor.js';
import type { PairingView, RemoteAccessView } from './remote-access-replica.js';
import type { ServiceRegistry } from './service-registry.js';
import type { SettingsStore } from './settings-store.js';
import type { SiteManager } from './site-manager.js';

/**
 * THE SERVICES TYPES GENIE-HOST'S FEATURES USE (Tynn #955, client/host split step 2g-4d E): what a composition holds
 * (ComposedServices) and the window-shaped one (WindowServices). They lived in compose.ts, which is only the tests'
 * composition now: the app composes nothing (main reads genie-host over the protocol). feature-controls, feature-ipc,
 * feature-machine and hosting-actions take them from here.
 */

/**
 * What a composition holds. `S` is the stores agents write to as it holds them: the narrow surfaces genie-host's features
 * read (`WindowServices`), or the stores themselves (`OwnAgentStores`, the default: what a test that composes alone opens).
 */
/** The settings as compose and its consumers use them: the store itself, or genie-host's through a replica (P3.2). */
type S_Settings = NonNullable<WindowAgentStores['settings']>;

export interface ComposedServices<S extends WindowAgentStores = OwnAgentStores> extends Omit<HostingApi, 'trustDeckItems' | 'shutdown' | 'sites' | 'engines' | 'envelopeSites' | 'trust'> {
    readonly inbox: S['inbox'];
    readonly attention: S['attention'];
    readonly knowledge: S['knowledge'];
    readonly flows: S extends OwnAgentStores ? FlowStore : FlowsApi;
    readonly flowScheduler: S extends OwnAgentStores ? FlowScheduler : FlowSchedulerApi;
    readonly settings: S extends OwnAgentStores ? SettingsStore : S_Settings;
    readonly supervisor: SupervisorApi;
    /**
     * WHAT EACH WORKSPACE'S OWN FILES SAY WOULD RUN, AND WHETHER THE PERSON HAS SAID YES TO IT (genie#1519). The host owns
     * it: genie-host's verdicts (a window reads them failing closed before the first dump and after the link drops), or
     * the hosting of a test that composes alone.
     */
    readonly workspaceTrust: TrustApi;
    /** Genie's own files for an agent whose workspace is not trusted, or `null`. */
    untrustedFilesFor(record: { readonly workspaceId: string }): Promise<import('./session-host.js').GenieInstructionFiles | null>;
    /** The workspaces read and not trusted, with what would run: the person's trust step. */
    trustSteps(): readonly { readonly workspaceId: string; readonly changed: boolean; readonly list: import('../core/workspace-trust.js').TrustList }[];
    /** The verdict as last read, without reading: for a shell call. A workspace not read yet is not trusted. */
    untrustedNow(record: { readonly workspaceId: string }): boolean;
    /**
     * Genie's hosting (P5a): the classes themselves when the composition built it (every test that composes alone); the
     * narrow surface (hosting-host.ts) when it is genie-host's.
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
    readonly remote: RemoteAccessView;
    /** "Pair this device?" — what waits for Allow on this screen (q_8c07b142). */
    readonly pairing: PairingView;
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
    integrations(): { mcp: { url: string | null; verified: Verification | null; tools: readonly McpToolRow[] }; agentFiles: readonly AgentFilesReport[] };
    /** Config sync (§6.9): Genie's MCP endpoint into a workspace's four targets, each reported on its own. `source`: Genie's start (default) or you. */
    syncConfig(workspacePath: string, source?: SyncSource): Promise<SyncResult[]>;
    /** The Genie 2 protocol files under `.agents/_genie/`, then the AGENTS.md / CLAUDE.md routers and RULES.md, then the skills (separate from the four config-sync targets). */
    syncAgentDocs(workspacePath: string, source?: SyncSource): Promise<void>;
    /** §6.7: the plugins, genie-host's through its replica (ADF A3); re-read when developer mode changes. */
    readonly plugins: PluginsApi;
    /**
     * Every element the catalog holds now (ADF A5): what the window's editors, panels and flow palette are projected from.
     * genie-host's.
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

/** What a window that composed against genie-host's stores holds (the host split, P3.1). */
export type WindowServices = ComposedServices<WindowAgentStores>;

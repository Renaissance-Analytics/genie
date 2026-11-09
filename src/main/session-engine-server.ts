import type { GithubAccountService } from './github-account-service.js';
import type { HostAgentKeys } from './host-agent-keys.js';
import type { KeyringService } from './keyring-service.js';
import type { WorkstationService } from './workstation-service.js';
import type { SyncResult } from '../core/integrations.js';
import type { WorkspaceConfigRequest } from './workspace-config-sync.js';
import type { DeviceLinkEvent, DeviceLinkService } from './device-link-service.js';
import { hostVault } from './keychain-migration.js';
import type { TynnAccountService } from './tynn-account-service.js';
import type { AgentSecrets } from './tynn-agent-identities.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { McpServer } from '@particle-academy/prism-acp';
import { heldRows, rowsPatch, type HeldRows, type RowsPatch } from '../core/agent-push-wire.js';
import {
    BROWSER_LINK_LABEL,
    DURABLE_CALLBACKS,
    ENGINE_PROTOCOL,
    parseEngineFrame,
    type EngineAgentUpdate,
    type EngineCallback,
    type EngineGlobalView,
    type EngineMethod,
    type WireAttachment,
} from '../core/engine-protocol.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { cancelIntent } from '../core/session.js';
import type { CallContext, ClientTransport } from '../core/remote-protocol.js';
import type { TimedEvent } from '../core/stream-view.js';
import type { SessionHost } from './session-host.js';
import type { SpawnFrame } from './spawn-host-protocol.js';
import type { FilesHubEvent, FilesWant } from './files-watch-hub.js';
import { WINDOW_CALLS, type AgentStoresService } from './agent-stores-host.js';
import type { SupervisorService } from './supervisor-host.js';
import type { HostingService } from './hosting-host.js';
import type { AppInboxHost } from './app-inbox-host.js';
import type { ElevationOutcome, PrivilegedStep } from './elevate.js';
import type { ProcessesService } from './processes-host.js';
import type { BrowserService } from './browser-service.js';
import type { FlowsService } from './flows-host.js';
import type { TerminalsService } from './terminals-host.js';
import { UPDATER_HELPER_LABEL, type UpdatesService } from './updates-host.js';
import type { IssueWatchDump, IssueWatchHostEvent, TynnBoardHubEvent } from './issue-watch-host.js';
import type { SafeModeView } from '../core/safe-mode.js';
import type { CrashStateView } from '../core/crash-record.js';
import type { MarketplaceApi } from '../core/marketplace.js';
import { MarketplaceSession } from './marketplace-session.js';

/**
 * THE AGENT ENGINE'S SERVER, in `genie-host` (the host split, phase 1; core/engine-protocol.ts says why).
 *
 * It owns nothing of its own: it puts a real `SessionHost` behind the protocol. What the session host used to tell
 * main.ts through its options (a thread id, a plan, a turn's number, an action's sound) it tells the window as
 * `engine.callback` events; what it used to ask main.ts (the agent's record now, its private credentials) it asks the
 * window, or holds what the window pushed.
 *
 * Three rules make the window's replica exact:
 *  1. **State before answers.** A command's effect is pushed BEFORE its result, on the same ordered socket, so a read the
 *     window makes after awaiting a command sees that command's effect.
 *  2. **Patches, never documents.** An agent's rows travel as `rowsPatch` deltas against what this connection last sent
 *     (core/agent-push-wire.ts), and its ledger only while the window watches it.
 *  3. **Nothing is lost to a crashed window.** Callbacks that change the window's stores (`DURABLE_CALLBACKS`) are queued
 *     while no window is connected and flushed to the next one.
 */

type HostOptions = ConstructorParameters<typeof SessionHost>[0];

/** Only declared operation names belong in timing logs, never a call's arguments or an unknown name. */
function timingLabel(method: EngineMethod, args: readonly unknown[]): string {
    if (method !== 'engine.stores') return method;
    const store = typeof args[0] === 'string' && Object.hasOwn(WINDOW_CALLS, args[0]) ? args[0] as keyof typeof WINDOW_CALLS : null;
    const operation = store !== null && typeof args[1] === 'string' && WINDOW_CALLS[store].includes(args[1]) ? args[1] : null;
    return `engine.stores store=${store ?? '?'} method=${operation ?? '?'}`;
}

/**
 * What a window may ask the keychain for: an agent's key. The accounts' tokens only go the other way, in the one-time move: a
 * window can hand one over and have it compared, and it cannot read it back.
 */
function movableName(name: string): `tynn/agent/${string}` | 'tynn/pairing' | 'github/access' | 'github/refresh' | `workstation/${string}` {
    if (name === 'tynn/pairing' || name === 'github/access' || name === 'github/refresh') return name;
    return name.startsWith('workstation/') ? name as `workstation/${string}` : agentKeyName(name);
}
/** An agent's key, by name. */
function agentKeyName(name: string): `tynn/agent/${string}` {
    if (!/^tynn\/agent\/[0-9A-HJKMNP-TV-Z]{26}$/i.test(name)) throw new Error('A window can ask only for an agent\'s key.');
    return name as `tynn/agent/${string}`;
}

/** What the session host is built with, from this server: its owner's half of the options. */
export type { HostAgentKeys };
export type EngineHostOptions = Required<Pick<HostOptions, 'currentRecord' | 'serviceEnvFor' | 'prepareMcpServers' | 'onThreadId' | 'onCarryOverSent' | 'onRedockSent' | 'markGenieWords' | 'onPlan' | 'onTurnNumbered' | 'onAction' | 'onHeadroom' | 'onMcpServers'>>;

export interface EngineServerOptions {
    /** This machine as a workstation (P3.4): the host holds its key. */
    readonly workstation?: WorkstationService;
    /** Sockets to other machines (P3.4 cut e): the host dials, and holds their device tokens. */
    readonly deviceLink?: DeviceLinkService;
    /** Remote access's host side (Tynn #409, P5d.1): driven from a LOCAL window only; a window leaving ends its bridged connections. */
    readonly remoteAccess?: { call(owner: string, method: string, args: unknown[]): unknown };
    /** The Tynn relay host's registration, role and link (Tynn #410): read and driven from a LOCAL window only. */
    readonly relayHost?: { call(method: string, args: unknown[]): unknown };
    readonly takeOver?: { call(method: string, args: unknown[]): unknown };
    /** A workspace's agent config (P3.4): one writer, here. */
    readonly configSync?: (asked: WorkspaceConfigRequest) => Promise<readonly SyncResult[]>;
    /** The keyring card, as the host found it (P3.4 cut c). */
    readonly keyring?: KeyringService;
    /** The host's GitHub account (P3.4 cut c). */
    readonly github?: GithubAccountService;
    /** What the OS said about proxies, as a window hands it over. */
    readonly proxy?: { remember(answers: Record<string, string>): Promise<void> };
    /** The host's Tynn account (P3.4 cut c). */
    readonly tynn?: TynnAccountService;
    /** The host's keychain (P3.4), which a window reaches for an agent's key. Absent = refused, which a window reads as unavailable. */
    readonly keychain?: AgentSecrets;
    /** An agent's Tynn key with no window connected (genie#1457: host-agent-keys.ts). */
    readonly agentKeys?: HostAgentKeys;
    /** The token a window must say in `hello` (constant-time compared). */
    readonly token: string;
    /** This host's build: a window of another build replaces it (core/engine-protocol.ts `hostDecision`). */
    readonly build: string;
    readonly pid?: number;
    /** `engine.shutdown`: stop gracefully and exit. The host entry's to implement; absent = refused. */
    readonly onShutdown?: () => void;
    /** The number of authenticated windows changed (the host's idle exit watches it). */
    readonly onClients?: (count: number) => void;
    /** How state pushes are coalesced: the timer. Default 16 ms, one frame — a streamed reply's chunks travel together. */
    readonly schedule?: (ms: number, fn: () => void) => () => void;
    readonly coalesceMs?: number;
    readonly log?: (line: string) => void;
    /** Each call a window makes, timed from its dispatch to its answer (genie-host's watchdog: `host ipc slow channel=…`). */
    readonly timeCall?: (method: string) => () => void;
    /**
     * genie-host's spawn-host children (the host split, P2.1): `send` takes a window's frame to the child of its profile;
     * `windowGone` says a window's link closed (its streams' lines now go nowhere). Absent = `engine.spawn` is refused.
     */
    readonly spawn?: { send(profile: string, frame: SpawnFrame): void; windowGone?(): void };
    /**
     * genie-host's file-watch hub (the host split, P2.2: files-watch-hub.ts). Views are owned by their CONNECTION: a window
     * whose link closes drops them all. Absent = `engine.filesWatch` is refused.
     */
    /**
     * Genie's MCP server in the host (P3.1: host-mcp.ts): told what the window says, asked a session's Genie entry and
     * its status. Absent = the window's own MCP entry is all a session gets (phase 1's way).
     */
    readonly mcp?: {
        setView(view: unknown): Promise<void>;
        sessionServers(record: AgentRecord): readonly McpServer[];
        status(): unknown;
        runNative(call: never): Promise<unknown>;
    };
    /** Genie 1's database path from the window: the host takes its memories and mail once. */
    readonly v1Import?: (databasePath: string) => Promise<void>;
    /**
     * genie-host's hang watchdog (Tynn #386: hang-watchdog.ts): each window's `engine.heartbeat` by its connection, and
     * the connection dropping. Absent = a beat is ignored.
     */
    readonly heartbeat?: { beat(connId: string, beat: unknown): void; dropped(connId: string): void };
    /** The latest crash record and the reopened-window notice (crash-state-host.ts): told to LOCAL windows before ready and on change; `engine.crash` dismisses. */
    readonly crash?: { view(): CrashStateView; dismiss(): CrashStateView; onChange(listener: (view: CrashStateView) => void): () => void };
    /** The host's process supervisor (P3.3b: supervisor-host.ts). Absent = `engine.supervisor` is refused. */
    readonly supervisor?: SupervisorService;
    /** The host's hosting: the front door, the engines, the sites (P5a: hosting-host.ts). Absent = `engine.hosting` is refused. */
    readonly hosting?: HostingService;
    /** The host's app door and its keys (P5a.2). Absent = `engine.appInbox` is refused. Local windows only, like the hosting. */
    readonly appInbox?: AppInboxHost;
    /** Takes the window's environment into this host's (`engine.windowEnv`, and with each start); `adoptWindowEnv` on `process.env` by default. */
    readonly adoptWindowEnv?: (env: Readonly<Record<string, string>>) => void;
    /** The host's process book and scheduler (P3.3c: processes-host.ts). Absent = `engine.processes` is refused. */
    readonly processes?: ProcessesService;
    /** Between the window and the Genie browser's process (P2b: browser-service.ts). Absent = `engine.browser` is refused. */
    readonly browser?: BrowserService;
    /** The host's flows (P3.3d: flows-host.ts). Absent = `engine.flows` is refused. */
    readonly flows?: FlowsService;
    /** The host's catalog (ADF A4: catalog-host.ts). Absent = `catalog.*` is refused and no window is sent one. */
    readonly catalog?: Pick<import('./catalog-host.js').CatalogService, 'snapshot' | 'docs' | 'onEvent'>;
    /** The host's plugins (ADF A3: plugins-host.ts). Absent = `engine.plugins` is refused and no window is told of any. */
    readonly plugins?: Pick<import('./plugins-host.js').PluginsService, 'dump' | 'onEvent' | 'call'>;
    readonly marketplace?: MarketplaceApi | undefined;
    /** The host's terminals (P3.3e: terminals-host.ts). Absent = `engine.terminals` is refused. */
    readonly terminals?: TerminalsService;
    /** The host's updater (P5b: updates-host.ts). Absent = `engine.updates` and `engine.updater` are refused. */
    readonly updates?: UpdatesService;
    /** The host's safe mode (Tynn #386: safe-mode-host.ts): told to EVERY window before ready and on change; `engine.safeMode` leaves it. */
    readonly safeMode?: { view(): SafeModeView; leave(): SafeModeView; onChange(listener: (view: SafeModeView) => void): () => void };
    /** The stores agents write to (the host split, P3.1: agent-stores-host.ts). Absent = `engine.stores` is refused. */
    readonly stores?: AgentStoresService;
    /** IssueWatch in the host (P5c: issue-watch-host.ts). Absent = `engine.issueWatch` is refused. Local windows only. */
    readonly issueWatch?: {
        dump(): IssueWatchDump;
        call(method: string, args: readonly unknown[]): Promise<unknown>;
        onEvent(listener: (event: IssueWatchHostEvent) => void): () => void;
    };
    /** The live board's per-view watches (P5c: issue-watch-host.ts TynnBoardHub), owned by the connection. Absent = refused. */
    readonly tynnBoard?: {
        watch(owner: string, viewId: string, workspaceId: string): boolean;
        unwatch(owner: string, viewId: string): void;
        dropOwner(owner: string): void;
    };
    /** Issues follows its own feed, with views owned and released by the same local connection. */
    readonly tynnIssues?: {
        watch(owner: string, viewId: string, workspaceId: string): boolean;
        unwatch(owner: string, viewId: string): void;
        dropOwner(owner: string): void;
    };
    /** The Features page follows its own feed (row F1), with views owned and released by the same local connection. */
    readonly tynnFeatures?: {
        watch(owner: string, viewId: string, workspaceId: string): boolean;
        unwatch(owner: string, viewId: string): void;
        dropOwner(owner: string): void;
    };
    /** Other Tynn pages, resolved and read on the host's account. Absent = refused; local windows only. */
    readonly tynnPages?: { read(workspaceId: string, page: unknown, query: unknown): Promise<unknown> };
    readonly files?: {
        subscribe(owner: string, viewId: string, workspace: { id: string; path: string }, want: FilesWant): void;
        unsubscribe(owner: string, viewId: string): void;
        dropOwner(owner: string): void;
    };
}

/** The most rows one frame carries: a longer patch is cut into several (see `#updatesFor`). */
export const PATCH_CHUNK_ROWS = 200;

/** How many store-changing callbacks are kept for a window that is not there (a resume each, at most). */
const QUEUE_LIMIT = 10_000;

interface Held {
    seq: number;
    rows: HeldRows<TimedEvent> | null;
    ledger: HeldRows<TimedEvent> | null;
}

interface Connection {
    readonly id: string;
    readonly transport: ClientTransport & { trusted?: () => void };
    authed: boolean;
    readonly held: Map<string, Held>;
    readonly watched: Set<string>;
    lastGlobal: string;
    nextCall: number;
    readonly pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    /**
     * A window on this host's OWN endpoint (its local socket or pipe, token-checked). Only such a link is sent the hosting
     * — whose dump carries each workspace's service variables — may drive it, or is asked to elevate (P5a.2).
     * P5d NOTE: a remote or phone path that ever reaches this server must accept as NOT local.
     */
    readonly local: boolean;
    /** The updater helper's link (P5b): never a window — not counted, sent no dump, open to `engine.updater` alone. */
    helper: boolean;
    /**
     * A WINDOW: it answers what the host asks of one (a forwarded tool, an elevation). The Genie browser's process links
     * here too and answers neither (Tynn #444: asked as the newest link, it failed every forwarded tool on beta.60).
     */
    window: boolean;
}

export class SessionEngineServer {
    readonly #options: EngineServerOptions;
    #host: SessionHost | null = null;
    readonly #marketplaceReviews = new WeakMap<Connection, MarketplaceSession>();
    readonly #records = new Map<string, AgentRecord>();
    readonly #env = new Map<string, Readonly<Record<string, string>>>();
    readonly #connections = new Set<Connection>();
    /** The updater helper's links (P5b), apart from the windows': nothing a window is sent or counted for reaches them. */
    readonly #helpers = new Set<Connection>();
    readonly #queue: EngineCallback[] = [];
    readonly #dirty = new Set<string>();
    #cancelFlush: (() => void) | null = null;
    readonly #schedule: (ms: number, fn: () => void) => () => void;

    constructor(options: EngineServerOptions) {
        this.#options = options;
        this.#schedule = options.schedule ?? ((ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
        // Every change to the stores agents write to, to every window's replicas (P3.1).
        options.keyring?.onEvent((dump) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'keyring.event', dump);
        });
        options.github?.onEvent((dump) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'github.event', dump);
        });
        // A page for the person, and it opens once: on the newest window.
        options.github?.onOpen((url) => {
            const conn = [...this.#connections].filter((c) => c.authed).at(-1);
            if (conn) this.#event(conn, 'github.open', { url });
        });
        options.tynn?.onEvent((dump) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'tynn.event', dump);
        });
        options.stores?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'stores.event', event);
        });
        // Every status change and every line of a supervised process's output, to every window's replica (P3.3b).
        options.supervisor?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'supervisor.event', event);
        });
        options.hosting?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'hosting.event', event);
        });
        options.appInbox?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'appInbox.event', event);
        });
        options.processes?.onEvent((dump) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'processes.event', dump);
        });
        options.catalog?.onEvent((change) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'catalog.changed', change);
        });
        options.plugins?.onEvent((dump) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'plugins.event', dump);
        });
        options.browser?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'browser.event', event);
        });
        options.flows?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'flows.event', event);
        });
        options.terminals?.onEvent((event) => {
            // A disposable terminal's output and end go to the window that opened it, and no other (Tynn story #378).
            const owner = event.kind === 'list' ? undefined : event.owner;
            for (const conn of this.#connections) if (conn.authed && (owner === undefined || owner === String(conn.id))) this.#event(conn, 'terminals.event', event);
        });
        // Safe mode (Tynn #386) travels to EVERY window: each one shows its banner.
        options.safeMode?.onChange((view) => { for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'safeMode.event', view); });
        // The crash state (Tynn #386) travels on LOCAL window links only: a record is this machine's.
        options.crash?.onChange((view) => { for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'crash.event', view); });
        // The updater's state (P5b) travels on LOCAL window links only, as the hosting's does (P4 rules).
        options.updates?.onEvent((state) => {
            for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'updates.event', state);
        });
        // IssueWatch's state and its sounds (P5c) travel on LOCAL window links only. A sound goes to the windows open now:
        // with none it is not kept, so nothing plays later.
        options.issueWatch?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'issueWatch.event', event);
        });
    }

    /** The session host's options that this server answers. Built BEFORE the host (it is handed to its constructor). */
    hostOptions(): EngineHostOptions {
        return {
            currentRecord: (id) => this.#records.get(id) ?? null,
            // Handed over with each start (the window's engines know the workspace's variables); read inside `start`.
            serviceEnvFor: (workspaceId) => this.#env.get(workspaceId) ?? {},
            // The host's Genie entry first (P3.1: it owns the MCP server and the caller book), then the agent's own Tynn server, which the
            // host prepares, window or no window (host-agent-keys.ts). What it could not hand out, it says why in the agent's chat.
            prepareMcpServers: async (record, cwd, signal) => {
                const own = this.#options.mcp?.sessionServers(record) ?? [];
                const held = await this.#options.agentKeys?.(record, cwd, signal);
                if (held?.note) this.#host?.notice(record.id, held.note);
                return [...own, ...(held?.servers ?? [])];
            },
            onThreadId: (agentId, threadId) => this.callback({ name: 'threadId', agentId, threadId }),
            onCarryOverSent: (agentId) => this.callback({ name: 'carryOverSent', agentId }),
            onRedockSent: (agentId, at) => this.callback({ name: 'redockSent', agentId, at }),
            markGenieWords: (agentId) => this.callback({ name: 'genieWords', agentId }),
            onPlan: (agentId, steps) => this.callback({ name: 'plan', agentId, steps: steps.map((s) => ({ content: s.content, status: s.status })) }),
            onTurnNumbered: (agentId, n) => this.callback({ name: 'turnNumbered', agentId, n }),
            onAction: (agentId, kind) => this.callback({ name: 'action', agentId, kind }),
            onHeadroom: (provider, headroom) => this.callback({ name: 'headroom', provider, headroom }),
            onMcpServers: (agentId, reports) => this.callback({ name: 'mcpServers', agentId, reports }),
        };
    }

    attach(host: SessionHost): void {
        this.#host = host;
        host.subscribe((agentId) => this.#markDirty(agentId));
    }

    /** The workspace variables (DB_*, REDIS_URL…) the last window handed over with a start, for what the host starts itself. */
    serviceEnvFor(workspaceId: string): Readonly<Record<string, string>> {
        return this.#env.get(workspaceId) ?? {};
    }

    /** Whether a window is connected now (the MCP server forwards window tools only then). The browser's link is none. */
    windowConnected(): boolean {
        return [...this.#connections].some((c) => c.authed && c.window);
    }

    /** A window tool's call, to the newest window (P3.1). Rejects with no window, or when it closes before it answers. */
    forwardTool(call: unknown): Promise<unknown> {
        return this.#reverse('client.toolCall', [call]);
    }

    /** An elevation the host's hosting needs, run by the newest window (P5a). Rejects with no window: the caller holds it. */
    elevate(steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> {
        return this.#reverse('client.elevate', [steps], { localOnly: true }) as Promise<ElevationOutcome>;
    }

    /** A remote method genie-host does not own yet, done by the newest LOCAL window (Tynn #409). Rejects with none. */
    remoteInvoke(method: string, args: unknown[], context?: CallContext): Promise<unknown> {
        return this.#reverse('client.remoteInvoke', [method, args, context ?? null], { localOnly: true });
    }

    /** The newest local window's connection: the one remote calls go to, and whose events remote connections follow. */
    newestLocalWindow(): string | null {
        return [...this.#connections].filter((c) => c.authed && c.window && c.local).at(-1)?.id ?? null;
    }

    /** Remote access's status (to every local window) or a bridged connection's frame (to the window that owns it). */
    remoteAccessEvent(owner: string | null, event: unknown): void {
        for (const conn of this.#connections) if (conn.authed && conn.local && (owner === null || conn.id === owner)) this.#event(conn, 'remoteAccess.event', event);
    }

    /** The relay host's state, to every local window (Tynn #410). */
    relayHostEvent(view: unknown): void {
        for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'relayHost.event', view);
    }

    /** Who has a TUI open, to every local window (Tynn #553). */
    takeOverEvent(view: unknown): void {
        for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'takeOver.event', view);
    }

    /** Whether a LOCAL window is connected now: the only kind asked to elevate (P5a.2). */
    localWindowConnected(): boolean {
        return [...this.#connections].some((c) => c.authed && c.window && c.local);
    }

    /** The records the window last pushed (the roster the host's tools and approvals read until P3.2). */
    records(): AgentRecord[] {
        return [...this.#records.values()];
    }

    get clients(): number {
        return [...this.#connections].filter((c) => c.authed).length;
    }

    /** A callback to the window: now, or (when it changes the window's stores) queued for the next window. */
    callback(callback: EngineCallback): void {
        const live = [...this.#connections].filter((c) => c.authed);
        if (live.length === 0) {
            if (DURABLE_CALLBACKS.has(callback.name) && this.#queue.length < QUEUE_LIMIT) this.#queue.push(callback);
            return;
        }
        // Whatever it is about is pushed first: a callback never runs ahead of the state it concerns.
        this.#flush();
        for (const c of live) this.#event(c, 'engine.callback', callback);
    }

    /** A connection (a window) arrived: it must say the token before anything else. */
    accept(transport: ClientTransport & { trusted?: () => void }, options: { local?: boolean } = {}): void {
        const conn: Connection = { id: randomUUID(), transport, authed: false, held: new Map(), watched: new Set(), lastGlobal: '', nextCall: 1, pending: new Map(), local: options.local === true, helper: false, window: false };
        this.#connections.add(conn);
        transport.onMessage((text) => this.#onMessage(conn, text));
        transport.onClose(() => {
            if (this.#helpers.delete(conn)) {
                this.#options.updates?.helperDropped(conn.id);
                return;
            }
            const was = conn.authed;
            this.#connections.delete(conn);
            const reviews = this.#marketplaceReviews.get(conn);
            if (reviews) {
                this.#marketplaceReviews.delete(conn);
                void reviews.close().catch(() => this.#options.log?.('Marketplace review cleanup failed after a window disconnected.'));
            }
            for (const p of conn.pending.values()) p.reject(new Error('The window closed before it answered.'));
            conn.pending.clear();
            if (was) this.#options.onClients?.(this.clients);
            if (was) this.#options.spawn?.windowGone?.();
            if (was) this.#options.browser?.dropped(String(conn.id));
            // Its disposable terminals end with it: nothing re-attaches one (Tynn story #378).
            if (was) this.#options.terminals?.dropped(String(conn.id));
            if (was) this.#options.files?.dropOwner(conn.id);
            if (was) this.#options.tynnBoard?.dropOwner(conn.id);
            if (was) this.#options.tynnIssues?.dropOwner(conn.id);
            if (was) this.#options.tynnFeatures?.dropOwner(conn.id);
            if (was) void this.#options.stores?.dropDraftFiles(conn.id);
            if (was) this.#options.deviceLink?.dropOwner(conn.id);
            if (was) this.#options.heartbeat?.dropped(conn.id);
        });
    }

    #onMessage(conn: Connection, text: string): void {
        const parsed = parseEngineFrame(text);
        if (!parsed.ok) {
            if (!conn.authed) conn.transport.close();
            else this.#options.log?.(`engine: a frame was refused: ${parsed.reason}`);
            return;
        }
        const message = parsed.message;
        if (!conn.authed) {
            // Nothing before the token: a call, an event or a wrong token closes the connection.
            if (message.kind !== 'hello' || message.auth.kind !== 'token' || !sameToken(message.auth.token, this.#options.token)) {
                conn.transport.send(JSON.stringify({ kind: 'refused', reason: 'this host does not know that token' }));
                conn.transport.close();
                return;
            }
            conn.authed = true;
            conn.window = message.label !== BROWSER_LINK_LABEL;
            conn.transport.trusted?.();
            conn.transport.send(JSON.stringify({ kind: 'welcome', connectionId: conn.id, host: hostname(), isOwner: true, workspaceId: null, protocol: ENGINE_PROTOCOL, build: this.#options.build, pid: this.#options.pid ?? process.pid }));
            // THE UPDATER HELPER (P5b), on this host's own endpoint with the token: no dump, never counted as a window.
            if (message.label === UPDATER_HELPER_LABEL && conn.local) {
                conn.helper = true;
                this.#connections.delete(conn);
                this.#helpers.add(conn);
                return;
            }
            this.#dump(conn);
            this.#options.onClients?.(this.clients);
            return;
        }
        if (message.kind === 'call') {
            // THE HEARTBEAT (Tynn #386): heard here, before any dispatch — cheap, no reply, no flush.
            if (message.method === 'engine.heartbeat') { this.#options.heartbeat?.beat(conn.id, message.args[0]); return; }
            void this.#call(conn, message.id, message.method, message.args);
            return;
        }
        if (message.kind === 'result') {
            const pending = conn.pending.get(message.id);
            if (!pending) return;
            conn.pending.delete(message.id);
            if (message.ok) pending.resolve(message.value);
            else pending.reject(new Error(message.reason));
        }
    }

    /** Everything a window that just connected needs: every running agent in full, the global view, then the queue. */
    #dump(conn: Connection): void {
        const host = this.#host;
        if (host) for (const id of host.startedIds()) for (const u of this.#updatesFor(conn, id)) this.#event(conn, 'engine.agent', u);
        this.#sendGlobal(conn);
        // Who is signed in BEFORE ready: a window never reads signed out when it is not.
        if (this.#options.tynn) this.#event(conn, 'tynn.event', this.#options.tynn.dump());
        if (this.#options.github) this.#event(conn, 'github.event', this.#options.github.dump());
        if (this.#options.keyring) this.#event(conn, 'keyring.event', this.#options.keyring.dump());
        // The stores' whole state BEFORE ready: a window never reads an empty inbox that is not (P3.1).
        if (this.#options.stores) this.#event(conn, 'stores.dump', this.#options.stores.dump());
        if (this.#options.supervisor) this.#event(conn, 'supervisor.dump', this.#options.supervisor.dump());
        // The hosting BEFORE ready: a window mounts its browsers on the front door's port and CA as soon as it connects (P5a).
        if (this.#options.hosting && conn.local) this.#event(conn, 'hosting.dump', this.#options.hosting.dump());
        if (this.#options.appInbox && conn.local) this.#event(conn, 'appInbox.dump', this.#options.appInbox.dump());
        if (this.#options.updates && conn.local) {
            this.#event(conn, 'updates.dump', this.#options.updates.dump());
            // Why the last install did not happen: the first local window is told, once (P5b).
            const failed = this.#options.updates.takeFailed();
            if (failed !== null) this.#event(conn, 'updates.failed', failed);
        }
        if (this.#options.issueWatch && conn.local) this.#event(conn, 'issueWatch.dump', this.#options.issueWatch.dump());
        if (this.#options.processes) this.#event(conn, 'processes.event', this.#options.processes.dump());
        // The catalog BEFORE ready (ADF A4): a window has the snapshot it follows changes from as soon as it connects.
        if (this.#options.catalog) this.#event(conn, 'catalog.snapshot', this.#options.catalog.snapshot());
        // The plugins BEFORE ready (ADF A3): a window lists them and routes files to their editors as soon as it connects.
        if (this.#options.plugins) this.#event(conn, 'plugins.event', this.#options.plugins.dump());
        if (this.#options.flows) this.#event(conn, 'flows.event', { kind: 'dump', dump: this.#options.flows.dump() });
        if (this.#options.terminals) this.#event(conn, 'terminals.dump', this.#options.terminals.dump());
        // Safe mode BEFORE ready: the window's own boot restore holds on it (relaunch-restore.ts).
        if (this.#options.safeMode) this.#event(conn, 'safeMode.event', this.#options.safeMode.view());
        if (this.#options.crash && conn.local) this.#event(conn, 'crash.event', this.#options.crash.view());
        conn.transport.send(JSON.stringify({ kind: 'event', channel: 'engine.ready', payload: { running: host ? host.startedIds() : [] } }));
        const queued = this.#queue.splice(0, this.#queue.length);
        for (const callback of queued) this.#event(conn, 'engine.callback', callback);
    }

    async #call(conn: Connection, id: number, method: EngineMethod, args: unknown[]): Promise<void> {
        let reply: { ok: true; value: unknown } | { ok: false; reason: string };
        // A notification (id 0: a spawn frame, a keystroke) is not a call anyone waits on: not timed.
        const timed = id === 0 ? undefined : this.#options.timeCall?.(timingLabel(method, args));
        try {
            reply = { ok: true, value: await this.#dispatch(conn, method, args) };
        } catch (error) {
            reply = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        timed?.();
        // RULE 1: the command's effect, then its answer.
        this.#flush();
        // A notification (id 0, a spawn frame) wants no answer.
        if (id === 0) return;
        conn.transport.send(JSON.stringify(reply.ok ? { kind: 'result', id, ok: true, value: reply.value ?? null } : { kind: 'result', id, ok: false, reason: reply.reason }));
    }

    async #marketplace(conn: Connection, args: unknown[]): Promise<unknown> {
        if (!conn.local || !conn.window) throw new Error('Marketplace actions require a local window.');
        if (args.length !== 2 || !Array.isArray(args[1])) throw new Error('Invalid Marketplace operation arguments.');
        let session = this.#marketplaceReviews.get(conn);
        if (!session) { session = new MarketplaceSession(() => this.#options.marketplace ?? null, this.#options.log); this.#marketplaceReviews.set(conn, session); }
        return session.call(args[0], args[1]);
    }

    async #dispatch(conn: Connection, method: EngineMethod, args: unknown[]): Promise<unknown> {
        // The updater helper's link calls its own method and nothing else (P5b).
        if (conn.helper || method === 'engine.updater') return this.#updater(conn, method, args);
        if (method === 'engine.marketplace') return this.#marketplace(conn, args);
        // The crash state is the host's own, ready before any agent engine is: answered here.
        if (method === 'engine.crash') {
            if (!this.#options.crash || !conn.local) throw new Error('This window is not told about crashes here.');
            if (args[0] !== 'dismiss') throw new Error('engine.crash takes dismiss');
            return this.#options.crash.dismiss();
        }
        // Remote access is the host's own too (Tynn #409), up before any agent engine: a phone may already be connected.
        if (method === 'engine.remoteAccess') {
            if (!this.#options.remoteAccess) throw new Error('This host runs no remote access.');
            if (!conn.local) throw new Error('Remote access is driven from a local window only.');
            return this.#options.remoteAccess.call(conn.id, typeof args[0] === 'string' ? args[0] : '', Array.isArray(args[1]) ? args[1] : []);
        }
        if (method === 'engine.takeOver') {
            if (!this.#options.takeOver) throw new Error('This host runs no take-over host.');
            if (!conn.local) throw new Error('Take over is driven from a local window only.');
            return this.#options.takeOver.call(typeof args[0] === 'string' ? args[0] : '', Array.isArray(args[1]) ? args[1] : []);
        }
        if (method === 'engine.relayHost') {
            if (!this.#options.relayHost) throw new Error('This host runs no relay host.');
            if (!conn.local) throw new Error('The relay host is driven from a local window only.');
            return this.#options.relayHost.call(typeof args[0] === 'string' ? args[0] : '', Array.isArray(args[1]) ? args[1] : []);
        }
        // The catalog is the host's own, ready before any agent engine is (ADF A4): answered here.
        if (method === 'catalog.snapshot' || method === 'catalog.docs') {
            if (!this.#options.catalog) throw new Error('This host keeps no catalog.');
            return method === 'catalog.snapshot' ? this.#options.catalog.snapshot() : this.#options.catalog.docs(String(args[0] ?? '') as never, String(args[1] ?? ''));
        }
        const host = this.#host;
        if (!host) throw new Error('The agent engine is still starting.');
        const id = (i = 0): AgentId => {
            const v = args[i];
            if (typeof v !== 'string') throw new Error(`${method} names an agent`);
            return v as AgentId;
        };
        const str = (i: number): string => (typeof args[i] === 'string' ? (args[i] as string) : '');
        const by = (i: number): string | null => (typeof args[i] === 'string' ? (args[i] as string) : null);
        switch (method) {
            case 'engine.start': {
                const record = args[0] as AgentRecord;
                if (!record || typeof record.id !== 'string') throw new Error('engine.start needs a record');
                this.#records.set(record.id, record);
                const env = args[2];
                this.#env.set(record.workspaceId, env && typeof env === 'object' ? (env as Record<string, string>) : {});
                const windowEnv = args[3];
                if (windowEnv && typeof windowEnv === 'object') (this.#options.adoptWindowEnv ?? ((e) => adoptWindowEnv(process.env, e)))(windowEnv as Record<string, string>);
                return host.start(record, str(1));
            }
            case 'engine.stop':
                return host.stop(id(), (args[1] as { graceful?: boolean } | undefined) ?? {});
            case 'engine.prompt':
                return host.prompt(id(), str(1), by(2), (args[3] as Parameters<SessionHost['prompt']>[3]) ?? {});
            case 'engine.handOff':
                return host.handOff(id(), str(1), by(2), (args[3] as Parameters<SessionHost['handOff']>[3]) ?? {});
            case 'engine.promptWith': {
                const wire = Array.isArray(args[2]) ? (args[2] as WireAttachment[]) : [];
                const attachments = wire.map((a) => ({ name: a.name, type: a.type, bytes: new Uint8Array(Buffer.from(a.b64, 'base64')) }));
                return host.promptWith(id(), str(1), attachments, by(3));
            }
            case 'engine.cancel':
                // Only `interrupt` is an interrupt; anything else, or nothing, is a Stop (Tynn #672 part 3).
                return host.cancel(id(), by(1), cancelIntent(args[2]));
            case 'engine.deliver':
                return host.deliver(id(), str(1), by(2));
            case 'engine.answerApproval':
                return host.answerApproval(id(), str(1), str(2));
            case 'engine.settleParked':
                return host.settleParked(id(), args[1] === 'allow' ? 'allow' : 'deny');
            case 'engine.notice':
                return host.notice(id(), str(1));
            case 'engine.reportPlan':
                return host.reportPlan(id(), Array.isArray(args[1]) ? (args[1] as { content: string; status: string }[]) : []);
            case 'engine.resolvePrompt':
                return host.resolvePrompt(id(), str(1), args[2] === 'send' ? 'send' : 'discard');
            case 'engine.recordOwed':
                await host.recordOwed(id(), str(1), by(2));
                return true;
            case 'engine.deliverOwed':
                return host.deliverOwed(id(), (args[1] as { text: string; by: string } | undefined) ?? undefined);
            case 'engine.ended':
                return host.ended(id());
            case 'engine.historyRows': {
                const o = (args[1] ?? {}) as { limit?: unknown; maxBytes?: unknown };
                return host.historyRows(id(), { limit: typeof o.limit === 'number' ? o.limit : 0, maxBytes: typeof o.maxBytes === 'number' ? o.maxBytes : 0 });
            }
            case 'engine.toolOutput':
                return host.toolOutput(id(), typeof args[1] === 'string' ? args[1] : '');
            case 'engine.settled':
                await host.settled();
                return true;
            case 'engine.drained':
                await host.drained(typeof args[0] === 'number' ? args[0] : 2_000);
                return true;
            case 'engine.modelState': {
                const state = host.modelState(id());
                return state === null ? null : { state: await state };
            }
            case 'engine.switchModel': {
                const switched = host.switchModel(id(), str(1));
                if (switched === null) return false;
                await switched;
                return true;
            }
            case 'engine.resumeLimit':
                host.resumeLimit(str(0));
                return true;
            case 'engine.clearDesignLogin':
                host.clearDesignLogin(str(0));
                return true;
            case 'engine.stopAll':
                await host.stopAll((left) => this.#event(conn, 'engine.stopAllLeft', left));
                return true;
            case 'engine.watchLedger':
                conn.watched.add(id());
                this.#markDirty(id());
                return true;
            case 'engine.unwatchLedger': {
                conn.watched.delete(id());
                const held = conn.held.get(id());
                if (held) held.ledger = null;
                return true;
            }
            case 'engine.records': {
                const records = Array.isArray(args[0]) ? (args[0] as AgentRecord[]) : [];
                this.#records.clear();
                for (const r of records) if (r && typeof r.id === 'string') this.#records.set(r.id, r);
                return true;
            }
            case 'engine.windowEnv': {
                const env = args[0];
                if (env && typeof env === 'object') (this.#options.adoptWindowEnv ?? ((e) => adoptWindowEnv(process.env, e)))(env as Record<string, string>);
                return true;
            }
            case 'engine.ping':
                return 'pong';
            case 'engine.shutdown':
                if (!this.#options.onShutdown) throw new Error('This host cannot be shut down from a window.');
                // Answered first: the shutdown ends this process, and the window waits for the pid, not for this reply.
                setTimeout(() => this.#options.onShutdown?.(), 0);
                return true;
            case 'engine.spawn': {
                if (!this.#options.spawn) throw new Error('This host runs no spawn host.');
                this.#options.spawn.send(str(0), args[1] as SpawnFrame);
                return true;
            }
            case 'engine.filesWatch': {
                if (!this.#options.files) throw new Error('This host runs no file watcher.');
                const ws = (args[1] ?? {}) as { id?: unknown; path?: unknown };
                if (typeof ws.id !== 'string' || typeof ws.path !== 'string') throw new Error('engine.filesWatch needs a workspace id and path');
                const want = (args[2] ?? {}) as { git?: unknown; repos?: unknown };
                const repos = Array.isArray(want.repos) ? want.repos.filter((r): r is string => typeof r === 'string') : [];
                this.#options.files.subscribe(conn.id, str(0), { id: ws.id, path: ws.path }, { ...(want.git === true ? { git: true } : {}), ...(repos.length > 0 ? { repos } : {}) });
                return true;
            }
            case 'engine.windowView':
                if (!this.#options.mcp) return false;
                await this.#options.mcp.setView(args[0]);
                return true;
            case 'engine.v1Import':
                if (!this.#options.v1Import) return false;
                await this.#options.v1Import(str(0));
                return true;
            case 'engine.runTool':
                if (!this.#options.mcp) throw new Error('This host runs no MCP server.');
                return this.#options.mcp.runNative(args[0] as never);
            case 'engine.mcpStatus':
                return this.#options.mcp?.status() ?? null;
            case 'engine.terminals':
                if (!this.#options.terminals) throw new Error('This host runs no terminals.');
                return this.#options.terminals.call(str(0), Array.isArray(args[1]) ? args[1] : [], String(conn.id));
            case 'engine.browser':
                if (!this.#options.browser) throw new Error('This host has no browser service.');
                return this.#options.browser.call(str(0), Array.isArray(args[1]) ? args[1] : [], String(conn.id));
            case 'engine.flows':
                if (!this.#options.flows) throw new Error('This host keeps no flows.');
                return this.#options.flows.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.processes':
                if (!this.#options.processes) throw new Error('This host keeps no process book.');
                return this.#options.processes.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.plugins':
                if (!this.#options.plugins) throw new Error('This host keeps no plugins.');
                if (!conn.local) throw new Error('Genie’s plugins are changed from a local window only.');
                return this.#options.plugins.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.appInbox':
                if (!this.#options.appInbox) throw new Error('This host runs no app door.');
                if (!conn.local) throw new Error('The app door’s keys are managed from a local window only.');
                return this.#options.appInbox.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.safeMode':
                if (!this.#options.safeMode) throw new Error('This host keeps no safe mode.');
                if (str(0) !== 'leave') throw new Error(`safe mode has no ${str(0)}`);
                // Leaving starts nothing here: the host's listener re-arms its clocks, and that is all.
                return this.#options.safeMode.leave();
            case 'engine.updates':
                if (!this.#options.updates) throw new Error('This host runs no updater.');
                if (!conn.local) throw new Error('Genie’s updates are driven from a local window only.');
                return this.#options.updates.call(str(0), Array.isArray(args[1]) ? args[1] : [], { window: true });
            case 'engine.hosting':
                if (!this.#options.hosting) throw new Error('This host runs no hosting.');
                if (!conn.local) throw new Error('Genie’s hosting is driven from a local window only.');
                return this.#options.hosting.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.supervisor':
                if (!this.#options.supervisor) throw new Error('This host runs no process supervisor.');
                return this.#options.supervisor.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.stores': {
                if (!this.#options.stores) throw new Error('This host keeps no stores.');
                return this.#options.stores.call(str(0), str(1), Array.isArray(args[2]) ? args[2] : []);
            }
            case 'engine.drafts.fileOpen':
            case 'engine.drafts.fileRead':
            case 'engine.drafts.fileClose': {
                if (!this.#connections.has(conn)) throw new Error('the draft file engine connection is closed');
                const stores = this.#options.stores; if (!stores) throw new Error('this host keeps no chat drafts');
                if (method === 'engine.drafts.fileOpen') return stores.draftFileOpen(conn.id, args[0]);
                if (method === 'engine.drafts.fileRead') return stores.draftFileRead(conn.id, args[0], args[1], args[2]);
                return stores.draftFileClose(conn.id, args[0]);
            }
            case 'engine.filesUnwatch':
                this.#options.files?.unsubscribe(conn.id, str(0));
                return true;
            case 'engine.issueWatch':
                if (!this.#options.issueWatch) throw new Error('This host runs no IssueWatch.');
                if (!conn.local) throw new Error('IssueWatch is asked from a local window only.');
                return this.#options.issueWatch.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            // LOCAL ONLY (P4 rule 4): a non-local link may be a share-link guest, and the board is the owner's, read with the
            // owner's own account. So a guest neither follows one nor is sent its events (it holds no views).
            case 'engine.tynnBoardWatch':
                if (!this.#options.tynnBoard) throw new Error('This host follows no Tynn board.');
                if (!conn.local) throw new Error('The Tynn board is followed from a local window only.');
                return this.#options.tynnBoard.watch(conn.id, str(0), str(1));
            case 'engine.tynnBoardUnwatch':
                if (!conn.local) throw new Error('The Tynn board is followed from a local window only.');
                this.#options.tynnBoard?.unwatch(conn.id, str(0));
                return true;
            case 'engine.tynnIssuesWatch':
                if (!conn.local) throw new Error('The Tynn Issues queue is followed from a local window only.');
                if (!this.#options.tynnIssues) throw new Error('This host follows no Tynn Issues queue.');
                return this.#options.tynnIssues.watch(conn.id, str(0), str(1));
            case 'engine.tynnIssuesUnwatch':
                if (!conn.local) throw new Error('The Tynn Issues queue is followed from a local window only.');
                this.#options.tynnIssues?.unwatch(conn.id, str(0));
                return true;
            case 'engine.tynnFeaturesWatch':
                if (!conn.local) throw new Error('The Tynn Features page is followed from a local window only.');
                if (!this.#options.tynnFeatures) throw new Error('This host follows no Tynn Features page.');
                return this.#options.tynnFeatures.watch(conn.id, str(0), str(1));
            case 'engine.tynnFeaturesUnwatch':
                if (!conn.local) throw new Error('The Tynn Features page is followed from a local window only.');
                this.#options.tynnFeatures?.unwatch(conn.id, str(0));
                return true;
            case 'engine.tynnPage':
                if (!conn.local) throw new Error('The Tynn pages are read from a local window only.');
                if (!this.#options.tynnPages) throw new Error('This host reads no Tynn pages.');
                return this.#options.tynnPages.read(str(0), args[1], args[2]);
            case 'engine.configSync':
                if (!this.#options.configSync) throw new Error('This host writes no workspace config.');
                return this.#options.configSync((args[0] ?? {}) as WorkspaceConfigRequest);
            case 'engine.deviceLink':
                if (!this.#options.deviceLink) throw new Error('This host dials no other machines.');
                return this.#options.deviceLink.call(conn.id, str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.workstation':
                if (!this.#options.workstation) throw new Error('This host keeps no workstation identity.');
                return this.#options.workstation.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.keyring':
                if (!this.#options.keyring) throw new Error('This host keeps no keyring card.');
                return this.#options.keyring.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.github':
                if (!this.#options.github) throw new Error('This host keeps no GitHub account.');
                return this.#options.github.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.proxyRemember':
                if (!this.#options.proxy) throw new Error('This host keeps no proxy answers.');
                return this.#options.proxy.remember((args[0] ?? {}) as Record<string, string>);
            case 'engine.tynn':
                if (!this.#options.tynn) throw new Error('This host keeps no Tynn account.');
                return this.#options.tynn.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.secretProbe':
                return this.#keychain().probe();
            case 'engine.secretRead':
                return this.#keychain().get(agentKeyName(str(0)));
            case 'engine.secretStore':
                return this.#keychain().set(movableName(str(0)), str(1));
            case 'engine.secretCompare':
                return hostVault(this.#keychain()).compare(movableName(str(0)), str(1));
            case 'client.toolCall':
                throw new Error('client.toolCall is the window\'s to answer');
        }
    }

    /** The updater helper's calls (P5b): `register [pid]`, then its answers. Only a link that said hello as the updater. */
    #updater(conn: Connection, method: EngineMethod, args: unknown[]): unknown {
        if (!conn.helper || method !== 'engine.updater') throw new Error('Genie’s updater may call its own method only, and only Genie’s updater may call it.');
        const updates = this.#options.updates;
        if (!updates) throw new Error('This host runs no updater.');
        const name = typeof args[0] === 'string' ? args[0] : '';
        const rest = Array.isArray(args[1]) ? args[1] as unknown[] : [];
        if (name === 'register') {
            const pid = typeof rest[0] === 'number' && Number.isInteger(rest[0]) ? rest[0] : 0;
            return updates.helperLinked(conn.id, pid, (event) => this.#event(conn, 'updater.event', event));
        }
        return updates.helperCall(name, rest, conn.id);
    }

    #keychain(): AgentSecrets {
        if (!this.#options.keychain) throw new Error('This host keeps no keychain.');
        return this.#options.keychain;
    }

    /** A call to the WINDOW (the newest one, never the browser's link): what only it has. Refused when no window is connected. */
    #reverse(method: EngineMethod, args: unknown[], options: { localOnly?: boolean } = {}): Promise<unknown> {
        const conn = [...this.#connections].filter((c) => c.authed && c.window && (options.localOnly !== true || c.local)).at(-1);
        if (!conn) return Promise.reject(new Error('No Genie window is connected to prepare this agent\'s credentials. Open Genie and start it again.'));
        const id = conn.nextCall++;
        return new Promise((resolve, reject) => {
            conn.pending.set(id, { resolve, reject });
            conn.transport.send(JSON.stringify({ kind: 'call', id, method, args }));
        });
    }

    /** A batch or a git result of the file-watch hub, to the window (connection) that owns the views it is for. */
    /** A socket to another machine said something: to the window that opened it, and no other. */
    deviceEvent(owner: string, event: DeviceLinkEvent): void {
        for (const conn of this.#connections) if (conn.authed && conn.id === owner) this.#event(conn, 'device.event', event);
    }

    /** A board's ring or state, to the connection whose views watch that workspace, and no other (P5c). */
    tynnBoardEvent(owner: string, event: TynnBoardHubEvent): void {
        for (const conn of this.#connections) if (conn.authed && conn.local && conn.id === owner) this.#event(conn, 'tynnBoard.event', event);
    }

    /** Issues rings go only to the local connection whose views follow the queue. */
    tynnIssuesEvent(owner: string, event: TynnBoardHubEvent): void {
        for (const conn of this.#connections) if (conn.authed && conn.local && conn.id === owner) this.#event(conn, 'tynnIssues.event', event);
    }

    /** Features rings go only to the local connection whose views follow the page. */
    tynnFeaturesEvent(owner: string, event: TynnBoardHubEvent): void {
        for (const conn of this.#connections) if (conn.authed && conn.local && conn.id === owner) this.#event(conn, 'tynnFeatures.event', event);
    }

    filesEvent(owner: string, event: FilesHubEvent): void {
        for (const conn of this.#connections) if (conn.authed && conn.id === owner) this.#event(conn, 'files.event', event);
    }

    /** A frame from genie-host's spawn-host child of `profile`, to every window. */
    spawnFrame(profile: string, frame: SpawnFrame): void {
        for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'spawn.frame', { profile, frame });
    }

    #markDirty(agentId: string): void {
        this.#dirty.add(agentId);
        if (this.#cancelFlush !== null) return;
        this.#cancelFlush = this.#schedule(this.#options.coalesceMs ?? 16, () => { this.#cancelFlush = null; this.#flush(); });
    }

    /** Every pending change, to every window, now (RULE 1 calls this before each answer). */
    #flush(): void {
        if (this.#cancelFlush !== null) { this.#cancelFlush(); this.#cancelFlush = null; }
        if (this.#dirty.size === 0) return;
        const ids = [...this.#dirty];
        this.#dirty.clear();
        for (const conn of this.#connections) {
            if (!conn.authed) continue;
            for (const id of ids) for (const u of this.#updatesFor(conn, id)) this.#event(conn, 'engine.agent', u);
            this.#sendGlobal(conn);
        }
    }

    /**
     * One agent's change as updates for this connection: usually one. A patch longer than `PATCH_CHUNK_ROWS` rows (a
     * first full ledger, a long run's rows) is CUT into several frames, each applying to the one before — so the window
     * never parses megabytes in one block on the thread that routes keystrokes (it drains frames under a time budget).
     */
    #updatesFor(conn: Connection, agentId: string): EngineAgentUpdate[] {
        const host = this.#host!;
        const id = agentId as AgentId;
        let held = conn.held.get(agentId);
        if (!held) { held = { seq: 0, rows: null, ledger: null }; conn.held.set(agentId, held); }
        const rows = host.rowsFor(id);
        const rowsP = rowsPatch(held.rows, rows);
        const watched = conn.watched.has(agentId);
        const ledgerRows = watched ? host.ledgerFor(id) : null;
        const ledgerP = ledgerRows !== null ? rowsPatch(held.ledger, ledgerRows) : null;
        const view = this.#viewFor(id);
        const pieces = Math.max(1, Math.ceil(rowsP.append.length / PATCH_CHUNK_ROWS), ledgerP ? Math.ceil(ledgerP.append.length / PATCH_CHUNK_ROWS) : 0);
        const cut = (p: RowsPatch<TimedEvent>, k: number, prevSeq: number | null): RowsPatch<TimedEvent> => {
            if (k === 0) return { base: p.base, keep: p.keep, append: p.append.slice(0, PATCH_CHUNK_ROWS) };
            const from = Math.min(p.append.length, k * PATCH_CHUNK_ROWS);
            return { base: prevSeq, keep: p.keep + from, append: p.append.slice(from, from + PATCH_CHUNK_ROWS) };
        };
        const updates: EngineAgentUpdate[] = [];
        for (let k = 0; k < pieces; k += 1) {
            const prev = k === 0 ? null : held.seq;
            const seq = ++held.seq;
            updates.push({ id: agentId, seq, view, rows: cut(rowsP, k, prev), ...(ledgerP ? { ledger: cut(ledgerP, k, prev) } : {}) });
        }
        held.rows = heldRows(held.seq, rows);
        if (ledgerRows !== null) held.ledger = heldRows(held.seq, ledgerRows);
        return updates;
    }

    #viewFor(id: AgentId): EngineAgentUpdate['view'] {
        const host = this.#host!;
        return {
            probe: host.probe(id),
            runOf: host.runOf(id),
            promptable: host.promptable(id),
            lastTurnEnd: host.lastTurnEnd(id),
            turns: host.turnsFor(id),
            turnsEndedThisRun: host.turnsEndedThisRun(id),
            recentStderr: [...host.recentStderrFor(id)],
            refusal: host.refusals.get(id) ?? null,
            unusableThreadId: host.unusableThreadIds.get(id) ?? null,
            models: host.modelCaps(id),
            deliverable: host.deliverable(id),
            inTurn: host.inTurn(id),
            queued: [...host.queuedPromptIds(id)],
            needsNewDriver: host.needsNewDriver(id),
        };
    }

    #sendGlobal(conn: Connection): void {
        const host = this.#host;
        if (!host) return;
        const view: EngineGlobalView = {
            startedIds: host.startedIds(),
            heldLogins: host.heldLogins(),
            signedOutProviders: host.signedOutProviders(),
            pausedProviders: host.pausedProviders(),
            pausedAgents: Object.fromEntries(host.pausedProviders().map((p) => [p, host.pausedAgents(p)])),
            signedOutAgents: Object.fromEntries(host.signedOutProviders().map((p) => [p, host.signedOutAgents(p)])),
            designLoginAgents: host.designLoginAgents(),
        };
        const text = JSON.stringify(view);
        if (text === conn.lastGlobal) return;
        conn.lastGlobal = text;
        conn.transport.send(`{"kind":"event","channel":"engine.global","payload":${text}}`);
    }

    #event(conn: Connection, channel: string, payload: unknown): void {
        conn.transport.send(JSON.stringify({ kind: 'event', channel, payload }));
    }
}

/** What is the host's own and never the window's: how it runs, and where its home is. */
const HOST_ONLY_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'GENIE_HOME', 'GENIE_HOST_BUILD', 'GENIE_HOST_IDLE_MS', 'GENIE_V1_USERDATA', 'GENIE_APPDATA', 'GENIE_RESOURCES']);

/**
 * THE WINDOW'S ENVIRONMENT, TAKEN BEFORE A START: a provider is launched from the host's `process.env` (filtered by the
 * drivers' allow-list), so the host takes the window's — added, changed and removed — except what is the host's own.
 * Names compare case-insensitively on Windows, as the OS does.
 */
export function adoptWindowEnv(target: NodeJS.ProcessEnv, windowEnv: Readonly<Record<string, string>>, platform: NodeJS.Platform = process.platform): void {
    const norm = (k: string): string => (platform === 'win32' ? k.toUpperCase() : k);
    const incoming = new Map(Object.entries(windowEnv).filter(([k]) => !HOST_ONLY_ENV.has(norm(k))).map(([k, v]) => [norm(k), [k, v] as const]));
    const existing = new Map<string, string>();
    for (const key of Object.keys(target)) {
        if (HOST_ONLY_ENV.has(norm(key))) continue;
        if (!incoming.has(norm(key))) delete target[key];
        else existing.set(norm(key), key);
    }
    // A name the host already has keeps its own spelling (`Path` stays `Path`): one variable, never two.
    for (const [n, [k, v]] of incoming) target[existing.get(n) ?? k] = v;
}

function sameToken(given: string, expected: string): boolean {
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

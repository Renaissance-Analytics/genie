import { accountsActionOf } from '../core/account-settings.js';
import type { FeatureCallers, FeatureBrowser } from './feature-callers.js';
import type { HostAgentKeys } from './host-agent-keys.js';
import type { WorkstationService } from './workstation-service.js';
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
import type { ClientTransport } from '../core/remote-protocol.js';
import type { TimedEvent } from '../core/stream-view.js';
import type { SessionHost } from './session-host.js';
import type { SpawnFrame } from './spawn-host-protocol.js';
import { WINDOW_CALLS, type AgentStoresService } from './agent-stores-host.js';
import type { SupervisorService } from './supervisor-host.js';
import type { HostingService } from './hosting-host.js';
import type { AppInboxHost } from './app-inbox-host.js';
import type { ElevationOutcome, PrivilegedStep } from './elevate.js';
import type { CloneOffersService } from './clone-offers-service.js';
import type { ProcessesService } from './processes-host.js';
import type { BrowserService } from './browser-service.js';
import type { FlowsService } from './flows-host.js';
import type { TerminalsService } from './terminals-host.js';
import { UPDATER_HELPER_LABEL, type UpdatesService } from './updates-host.js';
import type { SafeModeView } from '../core/safe-mode.js';
import type { CrashStateView } from '../core/crash-record.js';
import type { MarketplaceApi } from '../core/marketplace.js';
import type { GAppBookApi, GAppSessionsApi } from '../core/gapps.js';
import { dispatchGapps, GAppSessionOwner } from './gapps-api.js';
import { MarketplaceSession } from './marketplace-session.js';
import { fromWireAttachment } from './engine-wire.js';
import type { Attachment } from '../core/prompt-content.js';
import { isPromptAction } from '../core/prompt-delivery.js';

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

/** What the session host is built with, from this server: its owner's half of the options. */
export type { HostAgentKeys };
export type EngineHostOptions = Required<Pick<HostOptions, 'serviceEnvFor' | 'prepareMcpServers' | 'onThreadId' | 'onCarryOverSent' | 'onRedockSent' | 'markGenieWords' | 'onPlan' | 'onTurnNumbered' | 'onAction' | 'onHeadroom' | 'onMcpServers'>>;

export interface EngineServerOptions {
    /** This machine's windows' protocol connections, tunnelled to genie-host's RemoteHost (protocol-tunnels.ts). */
    readonly protocol?: Pick<import('./protocol-tunnels.js').ProtocolTunnels, 'receive' | 'dropOwner'>;
    readonly features?: FeatureCallers;
    /** This machine as a workstation (P3.4): the host holds its key. */
    readonly workstation?: WorkstationService;
    /** Remote access's host side (Tynn #409, P5d.1): driven from a LOCAL window only; a window leaving ends its bridged connections. */
    readonly remoteAccess?: { call(owner: string, method: string, args: unknown[]): unknown };
    readonly takeOver?: { call(method: string, args: unknown[]): unknown };
    /** What the OS said about proxies, as a window hands it over. */
    readonly proxy?: { remember(answers: Record<string, string>): Promise<void> };
    /** An agent's Tynn key with no window connected (genie#1457: host-agent-keys.ts). */
    readonly agentKeys?: HostAgentKeys;
    /** The token a window must say in `hello` (constant-time compared). */
    readonly token: string;
    /** This host's build: a window of another build replaces it (core/engine-protocol.ts `hostDecision`). */
    readonly build: string;
    readonly pid?: number;
    /** A provider's model list, from the host's one cache (core/provider-models.ts); `refresh` asks the CLI again. */
    readonly providerModels?: (provider: string, refresh: boolean) => Promise<import('../core/provider-models.js').ModelChoices>;
    /** The switch offers genie-host keeps (Tynn #481): listed, and dismissed (Not now), by this machine's window only. */
    readonly switchOffers?: { offers(): readonly import('../core/switch-offer.js').SwitchOffer[]; dismiss(id: string): boolean };
    /** Every known account with its readings, and the standing offers (Tynn #483): this machine's window only. No credential. */
    readonly accounts?: () => import('../core/accounts-view.js').AccountsSnapshot;
    /** Rename or forget a known account (Tynn #484): this machine's window only. */
    readonly accountsAct?: (action: import('../core/account-settings.js').AccountsAction) => Promise<import('../core/account-settings.js').AccountsActResult>;
    /** After a login: read the provider's account identity again (Tynn #477). */
    readonly refreshAccountIdentity?: (provider: string) => Promise<void>;
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
     * Genie's MCP server in the host (P3.1: host-mcp.ts): told what the window says, asked a session's Genie entry and
     * its status. Absent = the window's own MCP entry is all a session gets (phase 1's way).
     */
    readonly mcp?: {
        setView(view: unknown): Promise<void>;
        sessionServers(record: AgentRecord): readonly McpServer[];
        status(): unknown;
    };
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
    /** An agent's service variables (DB_URL and the rest), from genie-host's own engines (Tynn #1044). Absent = none. */
    readonly serviceEnvFor?: (workspaceId: string) => Readonly<Record<string, string>>;
    readonly adoptWindowEnv?: (env: Readonly<Record<string, string>>) => void;
    /** The host's process book and scheduler (P3.3c: processes-host.ts). Absent = `engine.processes` is refused. */
    readonly processes?: ProcessesService;
    /** The offers a clone's repo brings (Tynn #756: clone-offers-service.ts). Absent = `engine.cloneOffers` is refused. */
    readonly cloneOffers?: CloneOffersService;
    /** Between the window and the Genie browser's process (P2b: browser-service.ts). Absent = `engine.browser` is refused. */
    readonly browser?: BrowserService;
    /** The host's flows (P3.3d: flows-host.ts). Absent = `engine.flows` is refused. */
    readonly flows?: FlowsService;
    readonly marketplace?: MarketplaceApi | undefined;
    /** The GApp book's actions (GApps v2 V7). Absent = the book could not open, and the store says so. */
    readonly gapps?: GAppBookApi | undefined;
    /** One window of one app (Tynn #595), for the window process to open; never asked for by a page. */
    readonly gappSessions?: GAppSessionsApi | undefined;
    /** The GApp book changed: every local window reads its list again (Tynn #596). */
    readonly gappsChanged?: ((listener: () => void) => () => void) | undefined;
    /** The host's terminals (P3.3e: terminals-host.ts). Absent = `engine.terminals` is refused. */
    readonly terminals?: TerminalsService;
    /** The host's updater (P5b: updates-host.ts). Absent = `engine.updates` and `engine.updater` are refused. */
    readonly updates?: UpdatesService;
    /** The host's safe mode (Tynn #386: safe-mode-host.ts): told to EVERY window before ready and on change; `engine.safeMode` leaves it. */
    readonly safeMode?: { view(): SafeModeView; leave(): SafeModeView; onChange(listener: (view: SafeModeView) => void): () => void };
    /** The stores agents write to (the host split, P3.1: agent-stores-host.ts). Absent = `engine.stores` is refused. */
    readonly stores?: AgentStoresService;
    /** Other Tynn pages, resolved and read on the host's account. Absent = refused; local windows only. */
    readonly tynnPages?: { read(workspaceId: string, page: unknown, query: unknown): Promise<unknown> };
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
    readonly #gappSessionOwners = new WeakMap<Connection, GAppSessionOwner>();
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
        options.gappsChanged?.(() => {
            for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'gapps.changed', null);
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
    }

    /** The session host's options that this server answers. Built BEFORE the host (it is handed to its constructor). */
    hostOptions(): EngineHostOptions {
        return {
            // Handed over with each start (the window's engines know the workspace's variables); read inside `start`.
            serviceEnvFor: (workspaceId) => this.#options.serviceEnvFor?.(workspaceId) ?? {},
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
            onHeadroom: (provider, headroom, stamp) => this.callback({ name: 'headroom', provider, headroom, ...(stamp ? { stamp } : {}) }),
            onMcpServers: (agentId, reports) => this.callback({ name: 'mcpServers', agentId, reports }),
        };
    }

    attach(host: SessionHost): void {
        this.#host = host;
        host.subscribe((agentId) => this.#markDirty(agentId));
    }

    /** The workspace variables (DB_*, REDIS_URL…) the last window handed over with a start, for what the host starts itself. */
    serviceEnvFor(workspaceId: string): Readonly<Record<string, string>> {
        return this.#options.serviceEnvFor?.(workspaceId) ?? {};
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

    /** Remote access's status (to every local window) or a bridged connection's frame (to the window that owns it). */
    remoteAccessEvent(owner: string | null, event: unknown): void {
        for (const conn of this.#connections) if (conn.authed && conn.local && (owner === null || conn.id === owner)) this.#event(conn, 'remoteAccess.event', event);
    }

    /** Who has a TUI open, to every local window (Tynn #553). */
    takeOverEvent(view: unknown): void {
        for (const conn of this.#connections) if (conn.authed && conn.local) this.#event(conn, 'takeOver.event', view);
    }

    /** Whether a LOCAL window is connected now: the only kind asked to elevate (P5a.2). */
    localWindowConnected(): boolean {
        return [...this.#connections].some((c) => c.authed && c.window && c.local);
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
            // A window that said it is one is no longer spared or waited for by an install (Tynn #898).
            this.#options.updates?.windowDropped(conn.id);
            this.#gappSessionOwners.get(conn)?.closeAll();
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
            if (was) this.#options.features?.dropOwner(conn.id);
            // Every protocol connection this window process tunnelled ends with its link (the page reconnects).
            if (was) this.#options.protocol?.dropOwner(conn.id);
            if (was) this.#options.heartbeat?.dropped(conn.id);
        });
    }

    #onMessage(conn: Connection, text: string): void {
        const parsed = parseEngineFrame(text);
        if (!parsed.ok) {
            if (!conn.authed) conn.transport.close();
            // A window's call this host does not know (Tynn #894: a client-only update keeps an older host): answered with
            // its id, so the window's call settles instead of waiting forever.
            else if (parsed.code === 'unsupported' && parsed.id !== undefined) conn.transport.send(JSON.stringify({ kind: 'result', id: parsed.id, ok: false, reason: parsed.reason, code: 'unsupported' }));
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
            // THE WINDOW'S PROTOCOL FRAMES (Tynn #898 step 2d-4b): handed on here, in arrival order, never behind a slow call.
            if (message.method === 'engine.protocol') {
                this.#protocol(conn, message.args);
                if (message.id !== 0) conn.transport.send(JSON.stringify({ kind: 'result', id: message.id, ok: true, value: null }));
                return;
            }
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
        if (this.#options.processes) this.#event(conn, 'processes.event', this.#options.processes.dump());
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
        if (method === 'engine.gapps') {
            if (!conn.local || !conn.window) throw new Error('GApp actions require a local window.');
            if (args[0] === 'openSession' || args[0] === 'closeSession') {
                let owner = this.#gappSessionOwners.get(conn);
                if (!owner) { owner = new GAppSessionOwner(() => this.#options.gappSessions ?? null); this.#gappSessionOwners.set(conn, owner); }
                return owner.call(args[0], Array.isArray(args[1]) ? args[1] : []);
            }
            return dispatchGapps(() => this.#options.gapps ?? null, args[0], Array.isArray(args[1]) ? args[1] : []);
        }
        // The crash state is the host's own, ready before any agent engine is: answered here.
        if (method === 'engine.crash') {
            if (!this.#options.crash || !conn.local) throw new Error('This window is not told about crashes here.');
            if (args[0] !== 'dismiss') throw new Error('engine.crash takes dismiss');
            return this.#options.crash.dismiss();
        }
        // Remote access is the host's own too (Tynn #409), up before any agent engine: a phone may already be connected.
        if (method === 'engine.accountsAct') {
            if (!conn.local || !conn.window) throw new Error('Accounts need this machine’s own window.');
            if (!this.#options.accountsAct) throw new Error('The accounts are not ready in the host yet.');
            const action = accountsActionOf(args[0]);
            if (!action) throw new Error('That is not an account action.');
            return this.#options.accountsAct(action);
        }
        if (method === 'engine.accounts') {
            if (!conn.local || !conn.window) throw new Error('Accounts need this machine’s own window.');
            if (!this.#options.accounts) throw new Error('The accounts are not ready in the host yet.');
            return this.#options.accounts();
        }
        if (method === 'engine.switchOffers' || method === 'engine.dismissSwitchOffer') {
            if (!conn.local || !conn.window) throw new Error('Switch offers need this machine’s own window.');
            if (!this.#options.switchOffers) throw new Error('Switch offers are not ready in the host yet.');
            return method === 'engine.switchOffers' ? this.#options.switchOffers.offers() : this.#options.switchOffers.dismiss(typeof args[0] === 'string' ? args[0] : '');
        }
        if (method === 'engine.refreshAccountIdentity') {
            if (!conn.local || !conn.window) throw new Error('Account identity needs this machine’s own window.');
            await this.#options.refreshAccountIdentity?.(typeof args[0] === 'string' ? args[0] : '');
            return true;
        }
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
                const wire: readonly WireAttachment[] = Array.isArray(args[2]) ? (args[2] as WireAttachment[]) : [];
                // A saved file crosses as its path (Tynn #829); a malformed one refuses the message, never a made-up path.
                const attachments = wire.map(fromWireAttachment);
                if (attachments.some((a) => a === null)) return { ok: false, reason: 'an attachment did not arrive whole; nothing was sent' };
                return host.promptWith(id(), str(1), attachments as Attachment[], by(3));
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
                // Each action as asked (Tynn #843): a Withdraw read as a Discard would drop the message from the thread.
                if (!isPromptAction(args[2])) return { ok: false, reason: 'Invalid draft action.' };
                return host.resolvePrompt(id(), str(1), args[2]);
            case 'engine.recordOwed':
                await host.recordOwed(id(), str(1), by(2));
                return true;
            case 'engine.deliverOwed':
                return host.deliverOwed(id(), (args[1] as { text: string; by: string } | undefined) ?? undefined);
            case 'engine.forgetShown':
                host.forgetShown(id());
                return true;
            case 'engine.ended':
                return host.ended(id());
            case 'engine.historyRows': {
                const o = (args[1] ?? {}) as { limit?: unknown; maxBytes?: unknown };
                return host.historyRows(id(), { limit: typeof o.limit === 'number' ? o.limit : 0, maxBytes: typeof o.maxBytes === 'number' ? o.maxBytes : 0 });
            }
            case 'engine.toolOutput':
                return host.toolOutput(id(), typeof args[1] === 'string' ? args[1] : '');
            case 'engine.attachment':
                return host.attachment(id(), typeof args[1] === 'string' ? args[1] : '');
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
            case 'engine.providerModels': {
                if (!this.#options.providerModels) throw new Error('This host cannot ask a provider for its models.');
                return this.#options.providerModels(str(0), args[1] === true);
            }
            case 'engine.switchModel': {
                const switched = host.switchModel(id(), str(1));
                if (switched === null) return false;
                await switched;
                return true;
            }
            case 'engine.resumeLimit':
                host.resumeLimit(str(0), typeof args[1] === 'string' ? args[1] : undefined);
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
            case 'engine.cloneOffers':
                if (!this.#options.cloneOffers) throw new Error('This host does not watch a workspace’s repo.');
                return this.#options.cloneOffers.call(str(0), Array.isArray(args[1]) ? args[1] : []);
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
                return this.#options.updates.call(str(0), Array.isArray(args[1]) ? args[1] : [], { window: true, connection: conn.id });
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
            case 'engine.tynnPage':
                if (!conn.local) throw new Error('The Tynn pages are read from a local window only.');
                if (!this.#options.tynnPages) throw new Error('This host reads no Tynn pages.');
                return this.#options.tynnPages.read(str(0), args[1], args[2]);
            case 'engine.workstation':
                if (!this.#options.workstation) throw new Error('This host keeps no workstation identity.');
                return this.#options.workstation.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.proxyRemember':
                if (!this.#options.proxy) throw new Error('This host keeps no proxy answers.');
                return this.#options.proxy.remember((args[0] ?? {}) as Record<string, string>);
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

    /** A call to the WINDOW (the newest one, never the browser's link): what only it has. Refused when no window is connected. */
    #reverse(method: EngineMethod, args: unknown[], options: { localOnly?: boolean } = {}): Promise<unknown> {
        const conn = [...this.#connections].filter((c) => c.authed && c.window && (options.localOnly !== true || c.local)).at(-1);
        if (!conn) return Promise.reject(new Error('No Genie window is connected to prepare this agent\'s credentials. Open Genie and start it again.'));
        return this.#reverseTo(conn, method, args);
    }

    #reverseTo(conn: Connection, method: EngineMethod, args: unknown[]): Promise<unknown> {
        if (!this.#connections.has(conn) || !conn.authed || !conn.window) return Promise.reject(new Error('the caller’s own window is no longer connected'));
        const id = conn.nextCall++;
        return new Promise((resolve, reject) => {
            conn.pending.set(id, { resolve, reject });
            conn.transport.send(JSON.stringify({ kind: 'call', id, method, args }));
        });
    }

    /** A batch or a git result of the file-watch hub, to the window (connection) that owns the views it is for. */
    /** One op of a window's tunnelled protocol connection (protocol-tunnels.ts): a LOCAL window's link only. */
    #protocol(conn: Connection, args: unknown[]): void {
        const [op, tunnel, payload] = args;
        const send = (event: import('./protocol-tunnels.js').TunnelEvent) => { if (this.#connections.has(conn)) this.#event(conn, 'protocol.frame', event); };
        if (!this.#options.protocol || conn.helper || !conn.local || !conn.window) {
            if (typeof tunnel === 'string' && op !== 'close') send({ tunnel, kind: 'closed', reason: 'genie-host tunnels protocol connections for this machine’s own windows only' });
            return;
        }
        this.#options.protocol.receive(conn.id, op, tunnel, payload, send);
    }

    /** A LOCAL window's link by its id; null when it is gone or is not one. */
    #localWindow(owner: string): Connection | null {
        return [...this.#connections].find((c) => c.id === owner && c.authed && c.window && c.local) ?? null;
    }

    /** A feature effect for a tunnelled connection (a page to open, a sign-in), to the window process that owns it. */
    featureEffect(owner: string, connectionId: string, method: string, args: unknown[]): Promise<unknown> {
        const conn = this.#localWindow(owner);
        if (!conn) return Promise.reject(new Error('the caller’s own window is no longer connected'));
        return this.#reverseTo(conn, 'client.featureEffect', [connectionId, method, args]);
    }

    /**
     * WHAT ONLY A WINDOW CAN DO (Tynn #898 step 2d-4b): the OS trash, an app's window. To `owner`'s window process (the
     * caller's), or with `null` to the newest local one: every window on this machine moves a file to the same trash.
     */
    windowOp(owner: string | null, op: string, args: unknown[]): Promise<unknown> {
        const conn = owner === null ? [...this.#connections].filter((c) => c.authed && c.window && c.local).at(-1) ?? null : this.#localWindow(owner);
        if (!conn) return Promise.reject(new Error(owner === null ? 'no Genie window is open on this machine' : 'the caller’s own window is no longer connected'));
        return this.#reverseTo(conn, 'client.windowOp', [op, args]);
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
            updates.push({ id: agentId, seq, view, rows: cut(rowsP, k, prev), ...(ledgerP ? { ledger: cut(ledgerP, k, prev) } : {}), ...(k < pieces - 1 ? { more: true as const } : {}) });
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
            historyPending: host.historyPending(id),
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

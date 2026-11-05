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
import type { ClientTransport } from '../core/remote-protocol.js';
import type { TimedEvent } from '../core/stream-view.js';
import type { SessionHost } from './session-host.js';
import type { SpawnFrame } from './spawn-host-protocol.js';
import type { FilesHubEvent, FilesWant } from './files-watch-hub.js';
import type { AgentStoresService } from './agent-stores-host.js';
import type { SupervisorService } from './supervisor-host.js';
import type { HostingService } from './hosting-host.js';
import type { AppInboxHost } from './app-inbox-host.js';
import type { ElevationOutcome, PrivilegedStep } from './elevate.js';
import type { ProcessesService } from './processes-host.js';
import type { BrowserService } from './browser-service.js';
import type { FlowsService } from './flows-host.js';
import type { TerminalsService } from './terminals-host.js';

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
export type EngineHostOptions = Required<Pick<HostOptions, 'currentRecord' | 'serviceEnvFor' | 'prepareMcpServers' | 'onThreadId' | 'onPlan' | 'onTurnNumbered' | 'onAction' | 'onHeadroom' | 'onMcpServers'>>;

export interface EngineServerOptions {
    /** This machine as a workstation (P3.4): the host holds its key. */
    readonly workstation?: WorkstationService;
    /** Sockets to other machines (P3.4 cut e): the host dials, and holds their device tokens. */
    readonly deviceLink?: DeviceLinkService;
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
    /** The host's terminals (P3.3e: terminals-host.ts). Absent = `engine.terminals` is refused. */
    readonly terminals?: TerminalsService;
    /** The stores agents write to (the host split, P3.1: agent-stores-host.ts). Absent = `engine.stores` is refused. */
    readonly stores?: AgentStoresService;
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
}

export class SessionEngineServer {
    readonly #options: EngineServerOptions;
    #host: SessionHost | null = null;
    readonly #records = new Map<string, AgentRecord>();
    readonly #env = new Map<string, Readonly<Record<string, string>>>();
    readonly #connections = new Set<Connection>();
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
        options.browser?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'browser.event', event);
        });
        options.flows?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'flows.event', event);
        });
        options.terminals?.onEvent((event) => {
            for (const conn of this.#connections) if (conn.authed) this.#event(conn, 'terminals.event', event);
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

    /** Whether a window is connected now (the MCP server forwards window tools only then). */
    windowConnected(): boolean {
        return this.clients > 0;
    }

    /** A window tool's call, to the newest window (P3.1). Rejects with no window, or when it closes before it answers. */
    forwardTool(call: unknown): Promise<unknown> {
        return this.#reverse('client.toolCall', [call]);
    }

    /** An elevation the host's hosting needs, run by the newest window (P5a). Rejects with no window: the caller holds it. */
    elevate(steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> {
        return this.#reverse('client.elevate', [steps], { localOnly: true }) as Promise<ElevationOutcome>;
    }

    /** Whether a LOCAL window is connected now: the only kind asked to elevate (P5a.2). */
    localWindowConnected(): boolean {
        return [...this.#connections].some((c) => c.authed && c.local);
    }

    /** Each kept process's app-inbox credential, asked of the newest window (P3.3c). Rejects with no window. */
    appEnvs(processes: ReadonlyArray<{ id: string; name: string; workspaceId: string; kind?: 'site' | 'process' }>): Promise<Record<string, Record<string, string>>> {
        return this.#reverse('client.appEnvs', [processes]) as Promise<Record<string, Record<string, string>>>;
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
        const conn: Connection = { id: randomUUID(), transport, authed: false, held: new Map(), watched: new Set(), lastGlobal: '', nextCall: 1, pending: new Map(), local: options.local === true };
        this.#connections.add(conn);
        transport.onMessage((text) => this.#onMessage(conn, text));
        transport.onClose(() => {
            const was = conn.authed;
            this.#connections.delete(conn);
            for (const p of conn.pending.values()) p.reject(new Error('The window closed before it answered.'));
            conn.pending.clear();
            if (was) this.#options.onClients?.(this.clients);
            if (was) this.#options.spawn?.windowGone?.();
            if (was) this.#options.browser?.dropped(String(conn.id));
            if (was) this.#options.files?.dropOwner(conn.id);
            if (was) this.#options.deviceLink?.dropOwner(conn.id);
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
            conn.transport.trusted?.();
            conn.transport.send(JSON.stringify({ kind: 'welcome', connectionId: conn.id, host: hostname(), isOwner: true, workspaceId: null, protocol: ENGINE_PROTOCOL, build: this.#options.build, pid: this.#options.pid ?? process.pid }));
            this.#dump(conn);
            this.#options.onClients?.(this.clients);
            return;
        }
        if (message.kind === 'call') {
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
        if (this.#options.processes) this.#event(conn, 'processes.event', this.#options.processes.dump());
        if (this.#options.flows) this.#event(conn, 'flows.event', { kind: 'dump', dump: this.#options.flows.dump() });
        if (this.#options.terminals) this.#event(conn, 'terminals.dump', this.#options.terminals.dump());
        conn.transport.send(JSON.stringify({ kind: 'event', channel: 'engine.ready', payload: { running: host ? host.startedIds() : [] } }));
        const queued = this.#queue.splice(0, this.#queue.length);
        for (const callback of queued) this.#event(conn, 'engine.callback', callback);
    }

    async #call(conn: Connection, id: number, method: EngineMethod, args: unknown[]): Promise<void> {
        let reply: { ok: true; value: unknown } | { ok: false; reason: string };
        // A notification (id 0: a spawn frame, a keystroke) is not a call anyone waits on: not timed.
        const timed = id === 0 ? undefined : this.#options.timeCall?.(method);
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

    async #dispatch(conn: Connection, method: EngineMethod, args: unknown[]): Promise<unknown> {
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
                return host.cancel(id(), by(1));
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
                return this.#options.terminals.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.browser':
                if (!this.#options.browser) throw new Error('This host has no browser service.');
                return this.#options.browser.call(str(0), Array.isArray(args[1]) ? args[1] : [], String(conn.id));
            case 'engine.flows':
                if (!this.#options.flows) throw new Error('This host keeps no flows.');
                return this.#options.flows.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.processes':
                if (!this.#options.processes) throw new Error('This host keeps no process book.');
                return this.#options.processes.call(str(0), Array.isArray(args[1]) ? args[1] : []);
            case 'engine.appInbox':
                if (!this.#options.appInbox) throw new Error('This host runs no app door.');
                if (!conn.local) throw new Error('The app door’s keys are managed from a local window only.');
                return this.#options.appInbox.call(str(0), Array.isArray(args[1]) ? args[1] : []);
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
            case 'engine.filesUnwatch':
                this.#options.files?.unsubscribe(conn.id, str(0));
                return true;
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
            case 'client.appEnvs':
            case 'client.toolCall':
                throw new Error('client.toolCall is the window\'s to answer');
        }
    }

    #keychain(): AgentSecrets {
        if (!this.#options.keychain) throw new Error('This host keeps no keychain.');
        return this.#options.keychain;
    }

    /** A call to the WINDOW (the newest one): what only it has in phase 1. Refused when no window is connected. */
    #reverse(method: EngineMethod, args: unknown[], options: { localOnly?: boolean } = {}): Promise<unknown> {
        const conn = [...this.#connections].filter((c) => c.authed && (options.localOnly !== true || c.local)).at(-1);
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

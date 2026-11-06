import type { StreamEvent } from '../core/stream-event.js';
import type { ToolOutputReply } from '../core/tool-row-bound.js';
import { WorkstationReplica } from './workstation-replica.js';
import { DeviceLinkReplica } from './device-link-replica.js';
import type { SyncResult } from '../core/integrations.js';
import type { WorkspaceConfigRequest } from './workspace-config-sync.js';
import type { DeviceLinkEvent } from './device-link-service.js';
import { KeyringReplica } from './keyring-replica.js';
import type { KeyringDump } from './keyring-service.js';
import { GithubAccountReplica } from './github-account-replica.js';
import type { GithubAccountDump } from './github-account-service.js';
import { TynnAccountReplica } from './tynn-account-replica.js';
import type { TynnAccountDump } from './tynn-account-service.js';
import type { McpServer, SessionModelState } from '@particle-academy/prism-acp';
import type { RowsPatch } from '../core/agent-push-wire.js';
import type { AgentActionKind } from '../core/agent-actions.js';
import type { Comms } from '../core/comms.js';
import {
    ENGINE_PROTOCOL,
    parseEngineFrame,
    type EngineAgentUpdate,
    type EngineAgentView,
    type EngineCallback,
    type EngineGlobalView,
    type EngineMethod,
    type EngineWelcome,
    type WireAttachment,
} from '../core/engine-protocol.js';
import type { Headroom } from '../core/headroom.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import type { McpServerReport } from '../core/mcp-missing.js';
import type { Attachment } from '../core/prompt-content.js';
import type { GateView } from '../core/rate-limit-gate.js';
import type { ClientTransport } from '../core/remote-protocol.js';
import type { LiveSession } from '../core/roster.js';
import type { CancelOutcome, PromptContext, StopVerdict } from '../core/session.js';
import type { TimedEvent } from '../core/stream-view.js';
import { commsFields } from './session-host.js';
import type { SpawnFrame } from './spawn-host-protocol.js';
import type { FilesHubEvent, FilesWant } from './files-watch-hub.js';
import type { StoreName, StoresDump, StoresEvent } from './agent-stores-host.js';
import { storeReplicas, type StoreReplicas } from './agent-stores-replica.js';
import { SupervisorReplica, type SupervisorDump, type SupervisorEvent } from './supervisor-host.js';
import { HostingReplica, type HostingDump, type HostingEvent } from './hosting-host.js';
import { AppInboxReplica, type AppInboxDump, type AppInboxEvent } from './app-inbox-host.js';
import type { ElevationOutcome, PrivilegedStep } from './elevate.js';
import type { PhpCgiResolution } from './site-manager.js';
import { ProcessBookReplica, type ProcessesDump } from './processes-host.js';
import type { BrowserEvent } from './browser-service.js';
import { FlowsReplica, type FlowsEvent } from './flows-host.js';
import { TerminalsReplica, type TerminalsDump, type TerminalsEvent } from './terminals-host.js';
import type { ForwardedToolCall } from './mcp-host-tools.js';
import type { HostMcp, WindowView } from './host-mcp.js';
import type { McpToolResult } from '@particle-academy/prism-mcp';
import { UpdatesReplica } from './updates-replica.js';
import type { UpdateState } from './updater.js';
import type { UpdateFailedRecord } from './updates-host.js';
import { IssueWatchReplica } from './issue-watch-replica.js';
import type { IssueWatchDump, IssueWatchHostEvent, TynnBoardHubEvent } from './issue-watch-host.js';
import type { SafeModeView } from '../core/safe-mode.js';

/**
 * THE AGENT ENGINE AS THE WINDOW SEES IT (the host split, phase 1; core/engine-protocol.ts says why).
 *
 * The sessions run in `genie-host`. This is the window's half: the same surface main.ts used on its in-process
 * `SessionHost`, served from a REPLICA the host keeps current with patches. Reads (`probe`, `rowsFor`, `ledgerFor`,
 * `runOf` …) answer synchronously from the replica, as they did; commands (`start`, `prompt`, `stop` …) are calls to the
 * host and answer with a promise of exactly what the session host answered. A command NEVER rejects: with no host
 * connected it answers the refusal the session host gives for an agent it does not run, so a fire-and-forget call site
 * cannot raise an unhandled rejection.
 *
 * Row identity is kept as the session host keeps it (`ledgerFor`'s note): an unchanged row is the same object, a row
 * that grew is a new one, and the array grows in place only for an append or a replaced last row — so main's own push
 * to the window (core/agent-push-wire.ts `rowsPatch`) still finds what changed by identity.
 */

export type Awaitable<T> = T | Promise<T>;

/** What main.ts handed its in-process SessionHost, minus what runs on the host. Same names, same meanings. */
export interface EngineClientOptions {
    readonly onThreadId?: (agentId: AgentId, threadId: string) => void;
    readonly onCarryOverSent?: (agentId: AgentId) => void;
    readonly onPlan?: (agentId: AgentId, steps: readonly { content: string; status: string }[]) => void;
    readonly onTurnNumbered?: (agentId: AgentId, n: number) => void;
    readonly onAction?: (agentId: AgentId, kind: AgentActionKind | 'started' | 'replied' | 'limited' | 'resumed') => void;
    readonly onHeadroom?: (provider: string, headroom: Headroom) => void;
    readonly onMcpServers?: (agentId: AgentId, reports: readonly McpServerReport[]) => void;
    readonly mcpServersFor?: (record: AgentRecord) => readonly McpServer[];
    readonly prepareMcpServers?: (record: AgentRecord, cwd: string, signal: AbortSignal) => Promise<readonly McpServer[]>;
    /** A window tool's call, forwarded by the host's MCP server (P3.1): run it, answer its result. */
    readonly onToolCall?: (call: ForwardedToolCall) => Promise<McpToolResult>;
    /** openFileForUser, made while no window was there (P3.1). */
    readonly onOpenFileLater?: (call: ForwardedToolCall) => void;
    /** A tool's moment: a glow, a thumbs-up, an action signal. */
    readonly onToolSignal?: (signal: unknown) => void;
    /** An elevation genie-host's hosting needs (P5a): run it here, as the window always has, and answer the outcome. Absent = refused. */
    readonly elevate?: (steps: readonly PrivilegedStep[]) => Promise<ElevationOutcome>;
    /** Which php-cgi a site's pin runs, for the hosting replica's synchronous check (P5a). */
    readonly phpCgiFor?: (pin: string | undefined) => PhpCgiResolution;
    readonly serviceEnvFor?: (workspaceId: string) => Readonly<Record<string, string>>;
    /**
     * The window's environment NOW, sent with every start (default: `process.env`). Check and repair changes PATH and the
     * toolchain variables in the window's process at run time; the host takes them before it starts a provider, so a
     * repaired toolchain reaches the next agent with no restart (all config hot-swappable).
     */
    readonly env?: () => NodeJS.ProcessEnv;
    readonly comms?: (agentId: AgentId, since: number) => Comms | null;
    /** A stop the host could not verify (the lifecycle's `refused`): main records it on the Deck. */
    readonly onStopUnverified?: (agentId: AgentId, reason: string) => void;
    /** Every agent record, pushed to the host on connect and on `recordsChanged()` (genie#1188 reads them per call). */
    readonly records?: () => readonly AgentRecord[];
    /** The link closed (the host exited or was lost): main reconnects. */
    readonly onDisconnected?: (reason: string) => void;
    /** How long an agent's ledger stays watched after the window last read it. Default 60 s. */
    readonly ledgerIdleMs?: number;
    readonly now?: () => number;
    readonly log?: (line: string) => void;
}

/** How long the link may hold the window's thread at a time before yielding to the event loop. */
export const DRAIN_BUDGET_MS = 8;

/** What a command answers while no host is connected — said, never thrown. */
export const NOT_CONNECTED = 'Genie\'s agent host is not connected; it is being restarted. Try again in a moment.';

interface Replica {
    view: EngineAgentView;
    rows: { seq: number; rows: TimedEvent[] } | null;
    ledger: { seq: number; rows: TimedEvent[] } | null;
    /** When the window last read the ledger: an agent nobody reads for `ledgerIdleMs` is unwatched. */
    ledgerReadAt: number;
}

const EMPTY_VIEW: EngineAgentView = { probe: null, runOf: null, promptable: null, lastTurnEnd: null, turns: 0, turnsEndedThisRun: 0, recentStderr: [], refusal: null, unusableThreadId: null, models: { state: false, switch: false }, deliverable: null, inTurn: false, queued: [] };
const EMPTY_GLOBAL: EngineGlobalView = { startedIds: [], heldLogins: [], signedOutProviders: [], pausedProviders: [], pausedAgents: {}, signedOutAgents: {}, designLoginAgents: [] };
const NO_ROWS: readonly TimedEvent[] = [];

export class SessionEngineClient {
    readonly #options: EngineClientOptions;
    #transport: ClientTransport | null = null;
    #welcome: EngineWelcome | null = null;
    #nextCall = 1;
    readonly #pending = new Map<number, (reply: { ok: true; value: unknown } | { ok: false; reason: string }) => void>();
    readonly #agents = new Map<string, Replica>();
    #global: EngineGlobalView = EMPTY_GLOBAL;
    readonly #listeners = new Set<(agentId: AgentId) => void>();
    readonly #watched = new Set<string>();
    #stopAllLeft: ((left: number) => void) | null = null;
    /** The spawn host's frames by profile (the host split, P2.1), and who hears the link come and go. */
    readonly #spawnListeners = new Map<string, Set<(frame: SpawnFrame) => void>>();
    readonly #linkListeners = new Set<{ up: () => void; down: (reason: string) => void }>();
    /** The file-watch views this window holds (P2.2), sent again after a reconnect: the host dropped them with the link. */
    readonly #filesViews = new Map<string, { workspace: { id: string; path: string }; want: FilesWant }>();
    readonly #filesListeners = new Set<(event: FilesHubEvent) => void>();
    /** The board views this window follows in the host (P5c), sent again after a reconnect: the host dropped them with the link. */
    readonly #boardViews = new Map<string, string>();
    readonly #boardListeners = new Set<(event: TynnBoardHubEvent) => void>();
    #replicas: StoreReplicas | null = null;
    #supervisor: SupervisorReplica | null = null;
    #hosting: HostingReplica | null = null;
    #appInbox: AppInboxReplica | null = null;
    #processBook: ProcessBookReplica | null = null;
    #flows: FlowsReplica | null = null;
    readonly #browserListeners = new Set<(event: BrowserEvent) => void>();
    #tynn: TynnAccountReplica | null = null;
    #github: GithubAccountReplica | null = null;
    #keyring: KeyringReplica | null = null;
    #workstation: WorkstationReplica | null = null;
    #deviceLink: DeviceLinkReplica | null = null;
    #terminals: TerminalsReplica | null = null;
    /** Agents updated since the last `welcome`: what a reconnect's dump did NOT mention has stopped meanwhile. */
    #seenSinceWelcome = new Set<string>();

    /** Why a start was refused, by agent — the session host's `refusals`, as last pushed. */
    readonly refusals = new Map<AgentId, string>();
    readonly unusableThreadIds = new Map<AgentId, string>();

    constructor(options: EngineClientOptions = {}) {
        this.#options = options;
    }

    get connected(): boolean {
        return this.#transport !== null && this.#welcome !== null;
    }

    get welcome(): EngineWelcome | null {
        return this.#welcome;
    }

    /**
     * Say the token, take the welcome and the host's dump. Resolves once the dump is in (`engine.ready`), so the replica
     * reads true before main uses it. A refusal, a protocol mismatch or a close before the welcome answers `ok: false`.
     */
    connect(transport: ClientTransport, token: string): Promise<{ ok: true; welcome: EngineWelcome } | { ok: false; reason: string }> {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (r: { ok: true; welcome: EngineWelcome } | { ok: false; reason: string }): void => { if (!settled) { settled = true; resolve(r); } };
            let welcomed: EngineWelcome | null = null;
            const handle = (text: string): void => {
                const parsed = parseEngineFrame(text);
                if (!parsed.ok) { this.#options.log?.(`engine: a frame was refused: ${parsed.reason}`); return; }
                const m = parsed.message;
                if (welcomed === null) {
                    if (m.kind === 'refused') { finish({ ok: false, reason: m.reason }); transport.close(); return; }
                    if (m.kind !== 'welcome') return;
                    const w = m as unknown as Record<string, unknown>;
                    if (w.protocol !== ENGINE_PROTOCOL) {
                        finish({ ok: false, reason: `the host speaks protocol ${String(w.protocol)}, this window ${ENGINE_PROTOCOL}` });
                        transport.close();
                        return;
                    }
                    welcomed = { protocol: ENGINE_PROTOCOL, build: typeof w.build === 'string' ? w.build : '', pid: typeof w.pid === 'number' ? w.pid : 0 };
                    // THE HOST IS AUTHENTICATED: its frames may now exceed the pre-auth line limit. Without this the window
                    // closed its own link the first time a busy agent's update passed 64 KiB, and every reconnect's dump
                    // closed it again (genie-test-windows, 2026-11-01: 11 agents, the link lost every 8 s).
                    (transport as ClientTransport & { trusted?: () => void }).trusted?.();
                    this.#transport = transport;
                    this.#welcome = welcomed;
                    this.#seenSinceWelcome = new Set();
                    // Every replica is re-based: the host sends each running agent in full.
                    for (const r of this.#agents.values()) { r.rows = null; r.ledger = null; }
                    return;
                }
                if (m.kind === 'event') {
                    if (m.channel === 'engine.ready') {
                        this.#afterDump();
                        finish({ ok: true, welcome: welcomed });
                        for (const l of [...this.#linkListeners]) l.up();
                        return;
                    }
                    this.#onEvent(m.channel, m.payload);
                    return;
                }
                if (m.kind === 'result') {
                    const pending = this.#pending.get(m.id);
                    if (!pending) return;
                    this.#pending.delete(m.id);
                    pending(m.ok ? { ok: true, value: m.value } : { ok: false, reason: m.reason });
                    return;
                }
                if (m.kind === 'call') void this.#answer(m.id, m.method, m.args);
            };
            // Every frame, and the close after them, in arrival order and under a time budget (#drain).
            transport.onMessage((text) => this.#enqueue(() => handle(text)));
            transport.onClose(() => this.#enqueue(() => {
                finish({ ok: false, reason: 'the host closed the connection' });
                if (this.#transport !== transport) return;
                this.#transport = null;
                this.#welcome = null;
                for (const p of this.#pending.values()) p({ ok: false, reason: NOT_CONNECTED });
                this.#pending.clear();
                for (const l of [...this.#linkListeners]) l.down('the host closed the connection');
                this.#deviceLink?.lost('the host closed the connection');
                this.#options.onDisconnected?.('the host closed the connection');
            }));
            transport.send(JSON.stringify({ kind: 'hello', auth: { kind: 'token', token }, label: 'genie window' }));
        });
    }

    /**
     * THE WINDOW'S THREAD IS NEVER HELD BY THE LINK: frames are handled in order, but at most `DRAIN_BUDGET_MS` at a time —
     * then the rest wait for the next turn of the event loop, so a keystroke is routed between them. (A long patch is
     * already cut into frames by the host, so no single frame is large.)
     */
    readonly #inbox: Array<() => void> = [];
    #inboxHead = 0;
    #draining = false;

    #enqueue(job: () => void): void {
        this.#inbox.push(job);
        if (!this.#draining) this.#drain();
    }

    #drain(): void {
        this.#draining = true;
        const started = performance.now();
        while (this.#inboxHead < this.#inbox.length) {
            if (performance.now() - started > DRAIN_BUDGET_MS) { setImmediate(() => this.#drain()); return; }
            const job = this.#inbox[this.#inboxHead]!;
            this.#inboxHead += 1;
            try { job(); } catch (error) { this.#options.log?.(`engine: a frame failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
        this.#inbox.length = 0;
        this.#inboxHead = 0;
        this.#draining = false;
    }

    /** End the link from this side (a quit): no reconnect is asked for. */
    /** The window's environment NOW, to the host (P5a.2): after a Check and repair, what the host starts next reads it. */
    async pushEnv(): Promise<void> {
        const env = Object.fromEntries(Object.entries((this.#options.env ?? (() => process.env))()).filter((e): e is [string, string] => typeof e[1] === 'string'));
        const reply = await this.call('engine.windowEnv', [env]);
        if (!reply.ok) throw new Error(reply.reason);
    }

    disconnect(): void {
        const t = this.#transport;
        this.#transport = null;
        this.#welcome = null;
        t?.close();
    }

    #afterDump(): void {
        // What the dump did not mention is not running on the host now (it stopped while the window was away).
        for (const [id, r] of this.#agents) {
            if (this.#seenSinceWelcome.has(id)) continue;
            r.view = EMPTY_VIEW;
            r.rows = null;
            this.refusals.delete(id as AgentId);
            this.#emit(id as AgentId);
        }
        void this.call('engine.records', [this.#options.records?.() ?? []]);
        for (const id of this.#watched) void this.call('engine.watchLedger', [id]);
        for (const [viewId, v] of this.#filesViews) void this.call('engine.filesWatch', [viewId, v.workspace, v.want]);
        for (const [viewId, workspaceId] of this.#boardViews) void this.call('engine.tynnBoardWatch', [viewId, workspaceId]);
    }

    #onEvent(channel: string, payload: unknown): void {
        switch (channel) {
            case 'engine.agent':
                this.#applyAgent(payload as EngineAgentUpdate);
                return;
            case 'engine.global':
                this.#global = payload as EngineGlobalView;
                return;
            case 'engine.callback':
                this.#onCallback(payload as EngineCallback);
                return;
            case 'spawn.frame': {
                const p = payload as { profile?: unknown; frame?: unknown };
                const listeners = typeof p?.profile === 'string' ? this.#spawnListeners.get(p.profile) : undefined;
                if (listeners && p.frame) for (const l of [...listeners]) l(p.frame as SpawnFrame);
                return;
            }
            case 'terminals.dump':
                this.terminals().rebase(payload as TerminalsDump);
                return;
            case 'terminals.event':
                this.terminals().apply(payload as TerminalsEvent);
                return;
            case 'browser.event':
                for (const listener of [...this.#browserListeners]) listener(payload as BrowserEvent);
                return;
            case 'flows.event':
                this.flows().apply(payload as FlowsEvent);
                return;
            case 'processes.event':
                this.processBook().rebase(payload as ProcessesDump);
                return;
            case 'appInbox.dump':
                this.appInbox().rebase(payload as AppInboxDump);
                return;
            case 'appInbox.event':
                this.appInbox().apply(payload as AppInboxEvent);
                return;
            case 'hosting.dump':
                this.hosting().rebase(payload as HostingDump);
                return;
            // genie-host's updater (P5b): its whole state, on this window's local link only.
            case 'safeMode.event':
                this.#setSafeMode(payload as SafeModeView);
                return;
            case 'updates.dump':
            case 'updates.event':
                this.updates().rebase(payload as UpdateState);
                return;
            case 'updates.failed':
                this.updates().failedInstall(payload as UpdateFailedRecord);
                return;
            case 'hosting.event':
                this.hosting().apply(payload as HostingEvent);
                return;
            case 'supervisor.dump':
                this.supervisor().rebase(payload as SupervisorDump);
                return;
            case 'supervisor.event':
                this.supervisor().apply(payload as SupervisorEvent);
                return;
            case 'stores.dump':
                this.stores().rebase(payload as StoresDump);
                return;
            case 'stores.event':
                this.stores().apply(payload as StoresEvent);
                return;
            case 'keyring.event':
                this.keyring().rebase(payload as KeyringDump);
                return;
            case 'github.event':
                this.github().rebase(payload as GithubAccountDump);
                return;
            case 'github.open':
                this.github().openFromHost(String((payload as { url?: unknown } | null)?.url ?? ''));
                return;
            case 'tynn.event':
                this.tynn().rebase(payload as TynnAccountDump);
                return;
            case 'device.event':
                this.deviceLink().deliver(payload as DeviceLinkEvent);
                return;
            case 'files.event':
                for (const l of [...this.#filesListeners]) l(payload as FilesHubEvent);
                return;
            case 'issueWatch.dump':
                this.issueWatch().apply({ kind: 'dump', dump: payload as IssueWatchDump });
                return;
            case 'issueWatch.event':
                this.issueWatch().apply(payload as IssueWatchHostEvent);
                return;
            case 'tynnBoard.event':
                for (const l of [...this.#boardListeners]) l(payload as TynnBoardHubEvent);
                return;
            case 'engine.stopAllLeft':
                if (typeof payload === 'number') this.#stopAllLeft?.(payload);
                return;
            default:
                return;
        }
    }

    #applyAgent(update: EngineAgentUpdate): void {
        let r = this.#agents.get(update.id);
        if (!r) { r = { view: EMPTY_VIEW, rows: null, ledger: null, ledgerReadAt: 0 }; this.#agents.set(update.id, r); }
        this.#seenSinceWelcome.add(update.id);
        r.view = update.view;
        const id = update.id as AgentId;
        if (update.view.refusal === null) this.refusals.delete(id); else this.refusals.set(id, update.view.refusal);
        if (update.view.unusableThreadId === null) this.unusableThreadIds.delete(id); else this.unusableThreadIds.set(id, update.view.unusableThreadId);
        const seq = update.seq;
        r.rows = applyPatch(r.rows, update.rows, seq, this.#options.log);
        if (update.ledger) r.ledger = applyPatch(r.ledger, update.ledger, seq, this.#options.log);
        this.#emit(id);
    }

    #onCallback(c: EngineCallback): void {
        const o = this.#options;
        switch (c.name) {
            case 'threadId': o.onThreadId?.(c.agentId as AgentId, c.threadId); return;
            case 'carryOverSent': o.onCarryOverSent?.(c.agentId as AgentId); return;
            case 'plan': o.onPlan?.(c.agentId as AgentId, c.steps); return;
            case 'turnNumbered': o.onTurnNumbered?.(c.agentId as AgentId, c.n); return;
            case 'action': o.onAction?.(c.agentId as AgentId, c.kind as AgentActionKind); return;
            case 'headroom': o.onHeadroom?.(c.provider, c.headroom as Headroom); return;
            case 'mcpServers': o.onMcpServers?.(c.agentId as AgentId, c.reports as readonly McpServerReport[]); return;
            case 'stopUnverified': o.onStopUnverified?.(c.agentId as AgentId, c.reason); return;
            case 'openFileForUser': o.onOpenFileLater?.(c.call as ForwardedToolCall); return;
            case 'toolSignal': o.onToolSignal?.(c.signal); return;
        }
    }

    /** The host asks the window: a window tool's call, and an elevation. */
    async #answer(id: number, method: EngineMethod, args: unknown[]): Promise<void> {
        let reply: Record<string, unknown>;
        try {
            if (method === 'client.elevate') {
                if (!this.#options.elevate) throw new Error('this window runs no elevation');
                reply = { kind: 'result', id, ok: true, value: await this.#options.elevate((Array.isArray(args[0]) ? args[0] : []) as readonly PrivilegedStep[]) };
                this.#transport?.send(JSON.stringify(reply));
                return;
            }
            if (method === 'client.toolCall') {
                if (!this.#options.onToolCall) throw new Error('this window runs no tools');
                reply = { kind: 'result', id, ok: true, value: await this.#options.onToolCall(args[0] as ForwardedToolCall) };
                this.#transport?.send(JSON.stringify(reply));
                return;
            }
            throw new Error(`${method} is not the window's to answer`);
        } catch (error) {
            reply = { kind: 'result', id, ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        this.#transport?.send(JSON.stringify(reply));
    }

    /** One call to the host; with none connected, `{ ok: false, reason: NOT_CONNECTED }`. Never rejects. */
    call(method: EngineMethod, args: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
        const t = this.#transport;
        if (t === null || this.#welcome === null) return Promise.resolve({ ok: false, reason: NOT_CONNECTED });
        const id = this.#nextCall++;
        return new Promise((resolve) => {
            this.#pending.set(id, resolve);
            t.send(JSON.stringify({ kind: 'call', id, method, args }));
        });
    }

    async #value<T>(method: EngineMethod, args: unknown[], refused: T): Promise<T> {
        const reply = await this.call(method, args);
        if (!reply.ok) { if (reply.reason !== NOT_CONNECTED) this.#options.log?.(`engine: ${method} failed: ${reply.reason}`); return refused; }
        return reply.value as T;
    }

    #emit(agentId: AgentId): void {
        for (const listener of [...this.#listeners]) listener(agentId);
    }

    /**
     * genie-host's spawn-host child of `profile`, as a link for a SpawnHostClient (the host split, P2.1): its frames go
     * out as notifications (no result per keystroke), in order on the one socket; nothing is sent while not connected.
     */
    spawnLink(profile: string): { send(frame: SpawnFrame): void } {
        return {
            send: (frame) => {
                const t = this.#transport;
                if (t === null || this.#welcome === null) return;
                t.send(JSON.stringify({ kind: 'call', id: 0, method: 'engine.spawn', args: [profile, frame] }));
            },
        };
    }

    /**
     * A view wants a workspace's disk changes (the host split, P2.2): genie-host's watcher runs while any view holds one.
     * Kept here too, so a reconnect subscribes it again.
     */
    filesWatch(viewId: string, workspace: { id: string; path: string }, want: FilesWant): Promise<boolean> {
        this.#filesViews.set(viewId, { workspace: { id: workspace.id, path: workspace.path }, want });
        return this.#value('engine.filesWatch', [viewId, workspace, want], false).then((v) => v === true);
    }

    filesUnwatch(viewId: string): Promise<boolean> {
        this.#filesViews.delete(viewId);
        return this.#value('engine.filesUnwatch', [viewId], false).then((v) => v === true);
    }

    /**
     * The window's replicas of genie-host's stores (the host split, P3.1): the inbox, attention, approvals (read here,
     * synchronously, re-based at every connect) and the knowledge graph (read by call). Writes answer in the host's words.
     */
    stores(): StoreReplicas {
        this.#replicas ??= storeReplicas(async (store: StoreName, method: string, args: readonly unknown[]) => {
            const reply = await this.call('engine.stores', [store, method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#replicas;
    }

    /** What Genie's MCP server in the host needs of this window until P3.2 (host-mcp.ts `WindowView`); the first starts it. */
    pushWindowView(view: WindowView): Promise<boolean> {
        return this.#value('engine.windowView', [view], false).then((v) => v === true);
    }

    /** One of the host's own tools, for a caller this window resolved (a flow's step). Refused in words with no host. */
    async runHostTool(call: ForwardedToolCall): Promise<McpToolResult> {
        const reply = await this.call('engine.runTool', [call]);
        return reply.ok ? (reply.value as McpToolResult) : { text: `${call.name}: genie-host did not answer (${reply.reason}); nothing was done`, isError: true };
    }

    /** Genie 1's database: the host takes its memories and AgentInbox history once. */
    v1Import(databasePath: string): Promise<boolean> {
        return this.#value('engine.v1Import', [databasePath], false).then((v) => v === true);
    }

    /** The host MCP server's endpoint, verification and tools; null when it has not started. */
    mcpStatus(): Promise<ReturnType<HostMcp['status']> | null> {
        return this.#value<ReturnType<HostMcp['status']> | null>('engine.mcpStatus', [], null);
    }

    /**
     * genie-host's front door, service engines and site routes (P5a), as this window reads and drives them: the dump
     * arrives before `engine.ready`, so a connected window reads them synchronously.
     */
    appInbox(): AppInboxReplica {
        this.#appInbox ??= new AppInboxReplica(async (method, args) => {
            const reply = await this.call('engine.appInbox', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#appInbox;
    }

    /** genie-host's safe mode (Tynn #386), as this window last heard it; `null` = the host has said nothing (an older host). */
    safeModeView(): SafeModeView | null { return this.#safeMode; }

    onSafeMode(listener: (view: SafeModeView) => void): () => void {
        this.#safeModeListeners.add(listener);
        return () => { this.#safeModeListeners.delete(listener); };
    }

    /** "Leave safe mode": the host's leave. It starts nothing; it lets the automatic behaviour run again. */
    async leaveSafeMode(): Promise<{ ok: true } | { ok: false; reason: string }> {
        const reply = await this.call('engine.safeMode', ['leave']);
        if (!reply.ok) return reply;
        this.#setSafeMode(reply.value as SafeModeView);
        return { ok: true };
    }

    #safeMode: SafeModeView | null = null;
    readonly #safeModeListeners = new Set<(view: SafeModeView) => void>();

    #setSafeMode(view: SafeModeView): void {
        const was = this.#safeMode;
        this.#safeMode = view;
        if (was !== null && JSON.stringify(was) === JSON.stringify(view)) return;
        for (const l of [...this.#safeModeListeners]) l(view);
    }

    #updates: UpdatesReplica | null = null;

    /** genie-host's updater (P5b), as this window reads and drives it. */
    updates(): UpdatesReplica {
        this.#updates ??= new UpdatesReplica(async (method, args) => {
            const reply = await this.call('engine.updates', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        }, process.pid);
        return this.#updates;
    }

    /** genie-host's app door and its keys (P5a.2), as this window reads and changes them. */
    hosting(): HostingReplica {
        this.#hosting ??= new HostingReplica(async (method, args) => {
            const reply = await this.call('engine.hosting', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        }, this.#options.phpCgiFor ? { phpCgiFor: this.#options.phpCgiFor } : {});
        return this.#hosting;
    }

    /**
     * genie-host's process supervisor, as this window drives it (P3.3b): sites, the front door and the Processes view run
     * their processes there, so they live — and restart — with the UI closed.
     */
    supervisor(): SupervisorReplica {
        this.#supervisor ??= new SupervisorReplica(async (method, args) => {
            const reply = await this.call('engine.supervisor', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#supervisor;
    }

    /** genie-host's terminals, as this window opens, types into and shows them (P3.3e). */
    terminals(): TerminalsReplica {
        this.#terminals ??= new TerminalsReplica(async (method, args) => {
            const reply = await this.call('engine.terminals', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#terminals;
    }

    /** A workspace's agent config: the host writes it. Anything but its answer rejects, so nothing reads as synced. */
    async configSync(request: WorkspaceConfigRequest): Promise<SyncResult[]> {
        const reply = await this.call('engine.configSync', [request]);
        if (!reply.ok) throw new Error(reply.reason);
        return reply.value as SyncResult[];
    }

    /** Other machines: genie-host dials them and holds their device tokens (P3.4 cut e). */
    deviceLink(): DeviceLinkReplica {
        this.#deviceLink ??= new DeviceLinkReplica(async (method, args) => {
            const reply = await this.call('engine.deviceLink', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#deviceLink;
    }

    /** This machine as a workstation: genie-host holds the key and signs (P3.4). */
    workstation(): WorkstationReplica {
        this.#workstation ??= new WorkstationReplica(async (method, args) => {
            const reply = await this.call('engine.workstation', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#workstation;
    }

    /** The keyring card, as genie-host found it (P3.4 cut c). */
    keyring(): KeyringReplica {
        this.#keyring ??= new KeyringReplica(async (method, args) => {
            const reply = await this.call('engine.keyring', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#keyring;
    }

    /** genie-host's GitHub account (P3.4 cut c). */
    github(options?: { openExternal?: (url: string) => Promise<void> }): GithubAccountReplica {
        this.#github ??= new GithubAccountReplica(async (method, args) => {
            const reply = await this.call('engine.github', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        if (options?.openExternal) this.#github.useBrowser(options.openExternal);
        return this.#github;
    }

    /** genie-host's Tynn account, as this window reads and asks it (P3.4 cut c). */
    tynn(options?: { openExternal?: (url: string) => Promise<void> }): TynnAccountReplica {
        this.#tynn ??= new TynnAccountReplica(async (method, args) => {
            const reply = await this.call('engine.tynn', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        if (options?.openExternal) this.#tynn.useBrowser(options.openExternal);
        return this.#tynn;
    }

    /** genie-host's flows, as this window reads, edits, arms and runs them (P3.3d). */
    /** Between the window and the Genie browser's process (P2b: browser-service.ts). */
    async browserCall(method: string, args: readonly unknown[]): Promise<unknown> {
        const reply = await this.call('engine.browser', [method, [...args]]);
        if (!reply.ok) throw new Error(reply.reason);
        return reply.value;
    }

    onBrowserEvent(listener: (event: BrowserEvent) => void): () => void {
        this.#browserListeners.add(listener);
        return () => { this.#browserListeners.delete(listener); };
    }

    flows(): FlowsReplica {
        this.#flows ??= new FlowsReplica(async (method, args) => {
            const reply = await this.call('engine.flows', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#flows;
    }

    /** genie-host's process book and scheduler, as this window lists and manages them (P3.3c). */
    processBook(): ProcessBookReplica {
        this.#processBook ??= new ProcessBookReplica(async (method, args) => {
            const reply = await this.call('engine.processes', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#processBook;
    }

    #issueWatch: IssueWatchReplica | null = null;

    /** genie-host's IssueWatch (P5c), as this window reads it (local links only) and asks it. */
    issueWatch(): IssueWatchReplica {
        this.#issueWatch ??= new IssueWatchReplica(async (method, args) => {
            const reply = await this.call('engine.issueWatch', [method, [...args]]);
            if (!reply.ok) throw new Error(reply.reason);
            return reply.value;
        });
        return this.#issueWatch;
    }

    /**
     * A view follows a workspace's live board in the host (P5c); false = not linked to a Tynn project. Kept here too, so a
     * reconnect follows it again.
     */
    tynnBoardWatch(viewId: string, workspaceId: string): Promise<boolean> {
        this.#boardViews.set(viewId, workspaceId);
        return this.#value('engine.tynnBoardWatch', [viewId, workspaceId], false).then((v) => {
            if (v !== true) this.#boardViews.delete(viewId);
            return v === true;
        });
    }

    tynnBoardUnwatch(viewId: string): Promise<boolean> {
        this.#boardViews.delete(viewId);
        return this.#value('engine.tynnBoardUnwatch', [viewId], false).then((v) => v === true);
    }

    /** The rings and states for this window's board views. */
    onTynnBoardEvent(listener: (event: TynnBoardHubEvent) => void): () => void {
        this.#boardListeners.add(listener);
        return () => { this.#boardListeners.delete(listener); };
    }

    /** The batches and git results for this window's views. */
    onFilesEvent(listener: (event: FilesHubEvent) => void): () => void {
        this.#filesListeners.add(listener);
        return () => { this.#filesListeners.delete(listener); };
    }

    /** The frames of genie-host's spawn-host child of `profile`. */
    onSpawnFrame(profile: string, listener: (frame: SpawnFrame) => void): () => void {
        let set = this.#spawnListeners.get(profile);
        if (!set) { set = new Set(); this.#spawnListeners.set(profile, set); }
        set.add(listener);
        return () => set!.delete(listener);
    }

    /** The link came up (connected, its dump in) or went down: when spawn clients reconcile, and when they stop. */
    onLink(up: () => void, down: (reason: string) => void): () => void {
        const entry = { up, down };
        this.#linkListeners.add(entry);
        return () => this.#linkListeners.delete(entry);
    }

    /** Push every record again (main calls it when one changed). */
    recordsChanged(): void {
        void this.call('engine.records', [this.#options.records?.() ?? []]);
    }

    /** The agents whose ledger the window has not read for `ledgerIdleMs`: unwatched, their replica dropped. */
    sweepLedgers(): void {
        const now = (this.#options.now ?? Date.now)();
        const idle = this.#options.ledgerIdleMs ?? 60_000;
        for (const id of [...this.#watched]) {
            const r = this.#agents.get(id);
            if (r && now - r.ledgerReadAt < idle) continue;
            this.#watched.delete(id);
            if (r) r.ledger = null;
            void this.call('engine.unwatchLedger', [id]);
        }
    }

    // ── The session host's surface ────────────────────────────────────────────────────────────────────────────────

    subscribe(listener: (agentId: AgentId) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    get count(): number {
        return this.#global.startedIds.length;
    }

    startedIds(): AgentId[] {
        return [...this.#global.startedIds] as AgentId[];
    }

    heldLogins(): Array<{ provider: string; view: GateView }> {
        return [...this.#global.heldLogins];
    }

    signedOutProviders(): string[] {
        return [...this.#global.signedOutProviders];
    }

    pausedProviders(): string[] {
        return [...this.#global.pausedProviders];
    }

    pausedAgents(provider: string): AgentId[] {
        return [...(this.#global.pausedAgents[provider] ?? [])] as AgentId[];
    }

    signedOutAgents(provider: string): AgentId[] {
        return [...(this.#global.signedOutAgents[provider] ?? [])] as AgentId[];
    }

    designLoginAgents(): AgentId[] {
        return [...this.#global.designLoginAgents] as AgentId[];
    }

    clearDesignLogin(agentId: string): void {
        void this.call('engine.clearDesignLogin', [agentId]);
    }

    resumeLimit(provider: string): void {
        void this.call('engine.resumeLimit', [provider]);
    }

    #view(agentId: string): EngineAgentView {
        return this.#agents.get(agentId)?.view ?? EMPTY_VIEW;
    }

    probe(agentId: AgentId): LiveSession | null {
        const probe = this.#view(agentId).probe;
        if (probe === null) return null;
        // The comms cell is the window's (the inbox lives here in phase 1): added on read, as the host added it.
        return { ...probe, ...commsFields(this.#options.comms?.(agentId, probe.startedAt ?? 0) ?? null) };
    }

    runOf(agentId: AgentId): number | null {
        return this.#view(agentId).runOf;
    }

    promptable(agentId: AgentId): number | null {
        return this.#view(agentId).promptable;
    }

    /** The inbox push's gate (#1412): the run when a notice may be delivered now, else null — the host's answer, as pushed. */
    deliverable(agentId: AgentId): number | null {
        return this.#view(agentId).deliverable;
    }

    inTurn(agentId: AgentId): boolean {
        return this.#view(agentId).inTurn;
    }

    hasQueuedPrompt(agentId: AgentId, id: string): boolean {
        return this.#view(agentId).queued.includes(id);
    }

    lastTurnEnd(agentId: AgentId): EngineAgentView['lastTurnEnd'] {
        return this.#view(agentId).lastTurnEnd;
    }

    turnsFor(agentId: AgentId): number {
        return this.#view(agentId).turns;
    }

    turnsEndedThisRun(agentId: AgentId): number {
        return this.#view(agentId).turnsEndedThisRun;
    }

    recentStderrFor(agentId: AgentId): readonly string[] {
        return this.#view(agentId).recentStderr;
    }

    rowsFor(agentId: AgentId): readonly TimedEvent[] {
        return this.#agents.get(agentId)?.rows?.rows ?? NO_ROWS;
    }

    /**
     * The agent's history and this run, as the host's `ledgerFor` serves it. The first read WATCHES the agent: the host
     * then sends its ledger (in full once, patches after) until the window stops reading it (`sweepLedgers`). Until the
     * first patch lands this answers what is held, or no rows — the host's own answer while it reads a history.
     */
    ledgerFor(agentId: AgentId): readonly TimedEvent[] {
        let r = this.#agents.get(agentId);
        if (!r) { r = { view: EMPTY_VIEW, rows: null, ledger: null, ledgerReadAt: 0 }; this.#agents.set(agentId, r); }
        r.ledgerReadAt = (this.#options.now ?? Date.now)();
        if (!this.#watched.has(agentId)) {
            this.#watched.add(agentId);
            void this.call('engine.watchLedger', [agentId]);
        }
        return r.ledger?.rows ?? NO_ROWS;
    }

    start(record: AgentRecord, cwd: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        const env = Object.fromEntries(Object.entries((this.#options.env ?? (() => process.env))()).filter((e): e is [string, string] => typeof e[1] === 'string'));
        return this.#value('engine.start', [record, cwd, this.#options.serviceEnvFor?.(record.workspaceId) ?? {}, env], { ok: false, reason: NOT_CONNECTED });
    }

    stop(agentId: AgentId, options: { graceful?: boolean } = {}): Promise<boolean> {
        return this.#value('engine.stop', [agentId, options], false);
    }

    prompt(agentId: AgentId, text: string, by: string | null = null, context: PromptContext = {}): Promise<boolean> {
        return this.#value('engine.prompt', [agentId, text, by, context], false);
    }

    /**
     * The typed-input path (#1412): the host's `{ queued }` or null. Its effect — a held prompt among them — is in the
     * replica when this answers (the host pushes state before answers).
     */
    handOff(agentId: AgentId, text: string, by: string | null = null, context: PromptContext = {}): Promise<{ queued: string | null } | null> {
        return this.#value<{ queued: string | null } | null>('engine.handOff', [agentId, text, by, context], null);
    }

    promptWith(agentId: AgentId, text: string, attachments: readonly Attachment[], by: string | null = 'you'): Promise<{ ok: true } | { ok: false; reason: string | null }> {
        const wire: WireAttachment[] = attachments.map((a) => ({ name: a.name, type: a.type, b64: Buffer.from(a.bytes).toString('base64') }));
        return this.#value('engine.promptWith', [agentId, text, wire, by], { ok: false, reason: NOT_CONNECTED });
    }

    cancel(agentId: AgentId, by: string | null = 'you'): Promise<CancelOutcome> {
        return this.#value<CancelOutcome>('engine.cancel', [agentId, by], { ok: false, reason: 'refused' });
    }

    deliver(agentId: AgentId, text: string, by: string | null = 'you'): Promise<boolean> {
        return this.#value('engine.deliver', [agentId, text, by], false);
    }

    answerApproval(agentId: AgentId, optionId: string, note = ''): Promise<{ ok: true } | { ok: false; reason: string }> {
        return this.#value('engine.answerApproval', [agentId, optionId, note], { ok: false, reason: NOT_CONNECTED });
    }

    settleParked(agentId: AgentId, decision: 'allow' | 'deny'): Promise<boolean> {
        return this.#value('engine.settleParked', [agentId, decision], false);
    }

    notice(agentId: AgentId, message: string): Promise<boolean> {
        return this.#value('engine.notice', [agentId, message], false);
    }

    reportPlan(agentId: AgentId, steps: readonly { content: string; status: string }[]): Promise<boolean> {
        return this.#value('engine.reportPlan', [agentId, steps], false);
    }

    resolvePrompt(agentId: AgentId, id: string, action: 'send' | 'discard'): Promise<{ ok: true } | { ok: false; reason: string }> {
        return this.#value('engine.resolvePrompt', [agentId, id, action], { ok: false, reason: NOT_CONNECTED });
    }

    async recordOwed(agentId: AgentId, text: string, by: string | null): Promise<void> {
        await this.#value('engine.recordOwed', [agentId, text, by], false);
    }

    deliverOwed(agentId: AgentId, then?: { text: string; by: string }): Promise<number> {
        return this.#value('engine.deliverOwed', [agentId, then ?? null], 0);
    }

    ended(agentId: AgentId): Promise<StopVerdict | null> {
        return this.#value<StopVerdict | null>('engine.ended', [agentId], null);
    }

    /** The agent's newest recorded rows, bounded in rows and bytes, as the host reads them from its own store (`SessionHost.historyRows`). */
    historyRows(agentId: AgentId, options: { limit: number; maxBytes: number }): Promise<{ rows: readonly { event: StreamEvent; at: number | null }[]; cut: boolean }> {
        return this.#value<{ rows: readonly { event: StreamEvent; at: number | null }[]; cut: boolean }>('engine.historyRows', [agentId, { limit: options.limit, maxBytes: options.maxBytes }], { rows: [], cut: false });
    }

    /** A tool row's whole output, read by the host from its own store, bounded (`SessionHost.toolOutput`, Tynn story #386). */
    toolOutput(agentId: AgentId, toolCallId: string): Promise<ToolOutputReply> {
        return this.#value<ToolOutputReply>('engine.toolOutput', [agentId, toolCallId], { ok: false, reason: 'Genie’s agents are not running yet' });
    }

    async settled(): Promise<void> {
        await this.#value('engine.settled', [], false);
    }

    async drained(exitWithinMs: number): Promise<void> {
        await this.#value('engine.drained', [exitWithinMs], false);
    }

    /** `null` when the agent is not running or its driver cannot say (as the host answers); otherwise the host's answer. */
    modelState(agentId: AgentId): Promise<SessionModelState> | null {
        if (!this.#view(agentId).models.state) return null;
        return this.call('engine.modelState', [agentId]).then((reply) => {
            if (!reply.ok || reply.value === null) throw new Error(reply.ok ? 'This agent cannot say its models.' : reply.reason);
            return (reply.value as { state: SessionModelState }).state;
        });
    }

    switchModel(agentId: AgentId, modelId: string): Promise<void> | null {
        if (!this.#view(agentId).models.switch) return null;
        return this.call('engine.switchModel', [agentId, modelId]).then((reply) => {
            if (!reply.ok) throw new Error(reply.reason);
            if (reply.value !== true) throw new Error('This agent cannot switch its model without a restart.');
        });
    }

    async stopAll(onLeft?: (left: number) => void): Promise<void> {
        this.#stopAllLeft = onLeft ?? null;
        try {
            await this.#value('engine.stopAll', [], false);
        } finally {
            this.#stopAllLeft = null;
        }
    }

    /** Window main's heartbeat to genie-host's hang watchdog (Tynn #386): a notification (call id 0), no reply. Nothing while not linked. */
    heartbeat(beat: { pid: number; rss: number; bye?: true }): void {
        const t = this.#transport;
        if (t === null || this.#welcome === null) return;
        t.send(JSON.stringify({ kind: 'call', id: 0, method: 'engine.heartbeat', args: [beat] }));
    }

    /** Liveness: `true` when the host answered. */
    async ping(): Promise<boolean> {
        const reply = await this.call('engine.ping', []);
        return reply.ok && reply.value === 'pong';
    }

    /** Ask the host to stop gracefully and exit (a quit, or a host of another build being replaced). */
    async shutdown(): Promise<boolean> {
        const reply = await this.call('engine.shutdown', []);
        return reply.ok;
    }
}

/**
 * Apply a rows patch the way the session host changes its arrays: in place for an append or a replaced last row, a new
 * array for anything else — so identity reads the same on this side as on the host's. A patch for a base not held is a
 * protocol fault (the socket is ordered): logged, and the replica rebuilt from what arrived.
 */
export function applyPatch(held: { seq: number; rows: TimedEvent[] } | null, patch: RowsPatch<TimedEvent>, seq: number, log?: (line: string) => void): { seq: number; rows: TimedEvent[] } {
    if (patch.base === null) return { seq, rows: patch.append.slice() };
    if (held === null || held.seq !== patch.base) {
        log?.(`engine: a rows patch for base ${patch.base} arrived while holding ${held?.seq ?? 'nothing'}`);
        return { seq, rows: held ? [...held.rows.slice(0, patch.keep), ...patch.append] : patch.append.slice() };
    }
    const rows = held.rows;
    if (patch.keep === rows.length && patch.append.length === 0) return { seq, rows };
    if (patch.keep >= rows.length - 1 && patch.keep <= rows.length) {
        rows.length = patch.keep;
        for (const row of patch.append) rows.push(row);
        return { seq, rows };
    }
    return { seq, rows: [...rows.slice(0, patch.keep), ...patch.append] };
}

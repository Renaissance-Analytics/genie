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
    readonly onPlan?: (agentId: AgentId, steps: readonly { content: string; status: string }[]) => void;
    readonly onTurnNumbered?: (agentId: AgentId, n: number) => void;
    readonly onAction?: (agentId: AgentId, kind: AgentActionKind | 'started' | 'replied' | 'limited' | 'resumed') => void;
    readonly onHeadroom?: (provider: string, headroom: Headroom) => void;
    readonly onMcpServers?: (agentId: AgentId, reports: readonly McpServerReport[]) => void;
    readonly mcpServersFor?: (record: AgentRecord) => readonly McpServer[];
    readonly prepareMcpServers?: (record: AgentRecord, cwd: string, signal: AbortSignal) => Promise<readonly McpServer[]>;
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
            case 'plan': o.onPlan?.(c.agentId as AgentId, c.steps); return;
            case 'turnNumbered': o.onTurnNumbered?.(c.agentId as AgentId, c.n); return;
            case 'action': o.onAction?.(c.agentId as AgentId, c.kind as AgentActionKind); return;
            case 'headroom': o.onHeadroom?.(c.provider, c.headroom as Headroom); return;
            case 'mcpServers': o.onMcpServers?.(c.agentId as AgentId, c.reports as readonly McpServerReport[]); return;
            case 'stopUnverified': o.onStopUnverified?.(c.agentId as AgentId, c.reason); return;
        }
    }

    /** The host asks the window: only `client.prepareMcpServers` in phase 1. */
    async #answer(id: number, method: EngineMethod, args: unknown[]): Promise<void> {
        let reply: Record<string, unknown>;
        try {
            if (method !== 'client.prepareMcpServers') throw new Error(`${method} is not the window's to answer`);
            const record = args[0] as AgentRecord;
            const cwd = typeof args[1] === 'string' ? args[1] : '';
            const servers = this.#options.prepareMcpServers
                ? await this.#options.prepareMcpServers(record, cwd, new AbortController().signal)
                : (this.#options.mcpServersFor?.(record) ?? []);
            reply = { kind: 'result', id, ok: true, value: servers };
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

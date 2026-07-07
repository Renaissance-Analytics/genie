import crypto from 'crypto';
import {
    normalizePurpose,
    previewText,
    WHISPER_HUMAN,
    type WhisperAgentInfo,
    type WhisperBrokerEvent,
    type WhisperChannelInfo,
    type WhisperDmThreadInfo,
    type WhisperJoinInput,
    type WhisperMessage,
    type WhisperScope,
} from './types';

/**
 * WhisperChat broker — the in-memory registry + channels + inboxes powering the
 * local inter-agent messaging network. PURE: no electron, no db, no fs. All
 * durable identity (agent_id, purpose, scope, workspaces, chat_session_id) rides
 * `terminal_specs.meta`; the caller resolves that (+ workspace slug/name) and
 * hands the broker plain {@link WhisperJoinInput}s, and rehydrates them at boot.
 *
 * Delivery is PULL-based: `send` appends to each recipient's capped inbox (and a
 * capped per-channel / per-DM LOG for the human panel's history), and `receive`
 * pages an agent's inbox by cursor — optionally LONG-POLLING (one live waiter per
 * agent) until a message arrives, the agent leaves, or a timeout. The broker
 * NEVER writes into a pty; an `interrupt` DM is the only nudge, surfaced as a
 * terminal-attention event the caller maps to the glow.
 *
 * Presence + message events flow out through an injected emitter (presence.ts
 * wires the real local-broadcast + mobile push); a test passes a spy.
 */

/** Per-agent inbox cap — oldest messages age out (in-memory, reset on restart). */
export const INBOX_CAP = 200;
/** Per-channel / per-DM-pair history log cap (for the human panel). */
export const LOG_CAP = 500;
/** Default long-poll window — sits under the SSE heartbeat's client keepalive so
 *  the poll returns empty and the agent re-polls rather than the socket timing. */
export const DEFAULT_WAIT_MS = 55_000;
/** Hard cap on a requested long-poll window. */
export const MAX_WAIT_MS = 600_000;

interface Waiter {
    resolve: (msgs: WhisperMessage[]) => void;
    cursor: number;
    timer: ReturnType<typeof setTimeout> | null;
}

interface WhisperAgent extends WhisperAgentInfo {
    /** Queued messages awaiting `receive` (capped). */
    inbox: WhisperMessage[];
    /** The single live long-poll resolver, or null. */
    waiter: Waiter | null;
}

/** Normalise a DM pair into a stable, order-independent log key. */
function pairKey(a: string, b: string): string {
    return [a, b].sort().join('|');
}

export class WhisperBroker {
    private agents = new Map<string, WhisperAgent>();
    private byTerminal = new Map<string, string>(); // terminalId → agentId
    private channelMembers = new Map<string, Set<string>>(); // channelKey → agentIds
    /** workspaceId → { slug, name }, learned from every join (for channel labels). */
    private wsInfo = new Map<string, { slug: string; name: string }>();
    private channelLogs = new Map<string, WhisperMessage[]>();
    private dmLogs = new Map<string, WhisperMessage[]>();
    private seq = 0;
    private emit: (ev: WhisperBrokerEvent) => void = () => {};

    /** Wire the outbound event sink (presence.ts installs the real one at boot). */
    setEmitter(fn: (ev: WhisperBrokerEvent) => void): void {
        this.emit = fn;
    }

    /** The internal channel key for a workspace + purpose. */
    private keyFor(workspaceId: string, purpose: string): string {
        return `${workspaceId}:${normalizePurpose(purpose)}`;
    }

    private toInfo(a: WhisperAgent): WhisperAgentInfo {
        return {
            agentId: a.agentId,
            terminalId: a.terminalId,
            workspaceId: a.workspaceId,
            workspaceName: a.workspaceName,
            slug: a.slug,
            agentType: a.agentType,
            label: a.label,
            purpose: a.purpose,
            scope: a.scope,
            scopeWorkspaces: [...a.scopeWorkspaces],
            status: a.status,
            chatSessionId: a.chatSessionId,
        };
    }

    private emitPresence(a: WhisperAgent): void {
        this.emit({ type: 'presence', agent: this.toInfo(a) });
    }

    // --- membership --------------------------------------------------------

    /**
     * Register (or re-register) an agent. Idempotent per agentId: a second join
     * with the same id updates the record in place (e.g. rehydrate, or a spec
     * edit). Auto-joins the agent's own `workspaceId:purpose` channel. Returns the
     * public info.
     */
    join(input: WhisperJoinInput): WhisperAgentInfo {
        this.wsInfo.set(input.workspaceId, {
            slug: input.slug,
            name: input.workspaceName,
        });
        const purpose = normalizePurpose(input.purpose);
        const existing = this.agents.get(input.agentId);
        const agent: WhisperAgent = {
            agentId: input.agentId,
            terminalId: input.terminalId,
            workspaceId: input.workspaceId,
            workspaceName: input.workspaceName,
            slug: input.slug,
            agentType: input.agentType,
            label: input.label,
            purpose,
            scope: input.scope,
            scopeWorkspaces: [...(input.scopeWorkspaces ?? [])],
            status: input.status ?? 'online',
            chatSessionId: input.chatSessionId ?? null,
            inbox: existing?.inbox ?? [],
            waiter: existing?.waiter ?? null,
        };
        this.agents.set(agent.agentId, agent);
        this.byTerminal.set(agent.terminalId, agent.agentId);
        // Own channel — its purpose room.
        this.addToChannel(agent.agentId, this.keyFor(agent.workspaceId, purpose));
        this.emitPresence(agent);
        return this.toInfo(agent);
    }

    /** Re-register a set of agents at boot (from persisted specs). */
    rehydrate(inputs: WhisperJoinInput[]): void {
        for (const input of inputs) {
            this.join({ ...input, status: input.status ?? 'away' });
        }
    }

    /** Mark an agent's terminal alive again (it's actively calling whisper). */
    markOnline(agentId: string): void {
        const a = this.agents.get(agentId);
        if (!a || a.status === 'online') return;
        a.status = 'online';
        this.emitPresence(a);
    }

    /** The pty exited but the spec is retained — soft offline, revivable. Resolves
     *  any live waiter so a blocked `receive` unblocks. */
    away(terminalId: string): void {
        const agentId = this.byTerminal.get(terminalId);
        const a = agentId ? this.agents.get(agentId) : undefined;
        if (!a) return;
        a.status = 'away';
        this.settleWaiter(a);
        this.emitPresence(a);
    }

    /** The terminal was killed / spec removed — hard leave. Drops the agent from
     *  every channel, resolves its waiter, and emits an offline presence. */
    leaveByTerminal(terminalId: string): void {
        const agentId = this.byTerminal.get(terminalId);
        if (agentId) this.leave(agentId);
    }

    /** Hard leave by agent id. */
    leave(agentId: string): void {
        const a = this.agents.get(agentId);
        if (!a) return;
        for (const members of this.channelMembers.values()) members.delete(agentId);
        this.settleWaiter(a);
        this.agents.delete(agentId);
        this.byTerminal.delete(a.terminalId);
        this.emit({ type: 'offline', agentId });
    }

    /** Update a captured chat-session id (detect strategy resolved it post-launch). */
    setChatSession(agentId: string, chatSessionId: string): void {
        const a = this.agents.get(agentId);
        if (!a) return;
        a.chatSessionId = chatSessionId;
        this.emitPresence(a);
    }

    /**
     * Change an agent's accessibility. A purpose change RE-KEYS its channel (leave
     * the old `wsId:oldPurpose`, join `wsId:newPurpose`). Emits presence. Returns
     * the updated info, or null when the agent is unknown.
     */
    setAccessibility(
        agentId: string,
        patch: { scope?: WhisperScope; workspaces?: string[]; purpose?: string },
    ): WhisperAgentInfo | null {
        const a = this.agents.get(agentId);
        if (!a) return null;
        if (patch.purpose !== undefined) {
            const next = normalizePurpose(patch.purpose);
            if (next !== a.purpose) {
                this.removeFromChannel(agentId, this.keyFor(a.workspaceId, a.purpose));
                a.purpose = next;
                this.addToChannel(agentId, this.keyFor(a.workspaceId, next));
            }
        }
        if (patch.scope !== undefined) a.scope = patch.scope;
        if (patch.workspaces !== undefined) a.scopeWorkspaces = [...patch.workspaces];
        this.emitPresence(a);
        return this.toInfo(a);
    }

    // --- channels ----------------------------------------------------------

    private addToChannel(agentId: string, key: string): void {
        let set = this.channelMembers.get(key);
        if (!set) {
            set = new Set();
            this.channelMembers.set(key, set);
        }
        set.add(agentId);
    }

    private removeFromChannel(agentId: string, key: string): void {
        const set = this.channelMembers.get(key);
        if (!set) return;
        set.delete(agentId);
        if (set.size === 0) this.channelMembers.delete(key);
    }

    /**
     * Resolve a channel argument to an internal key for `callerAgentId`. A bare
     * purpose (`frontend`) targets the caller's OWN workspace room; a qualified
     * `<slugOrWorkspaceId>:<purpose>` targets another workspace's room. Returns
     * null when the workspace part can't be resolved.
     */
    resolveChannelKey(callerAgentId: string, channelArg: string): string | null {
        const caller = this.agents.get(callerAgentId);
        const raw = String(channelArg ?? '').trim();
        if (!raw) return null;
        const idx = raw.indexOf(':');
        if (idx < 0) {
            if (!caller) return null;
            return this.keyFor(caller.workspaceId, raw);
        }
        const left = raw.slice(0, idx);
        const purpose = raw.slice(idx + 1);
        // `left` is a workspace id we already know, or a slug to resolve.
        if (this.wsInfo.has(left)) return this.keyFor(left, purpose);
        for (const [wsId, info] of this.wsInfo) {
            if (info.slug === left) return this.keyFor(wsId, purpose);
        }
        return null;
    }

    /** Opt an agent into an arbitrary channel (beyond its own purpose room). */
    joinChannel(agentId: string, channelArg: string): boolean {
        const a = this.agents.get(agentId);
        if (!a) return false;
        const key = this.resolveChannelKey(agentId, channelArg);
        if (!key) return false;
        this.addToChannel(agentId, key);
        this.emitPresence(a);
        return true;
    }

    /** Opt an agent out of a channel. */
    leaveChannel(agentId: string, channelArg: string): boolean {
        const a = this.agents.get(agentId);
        if (!a) return false;
        const key = this.resolveChannelKey(agentId, channelArg);
        if (!key) return false;
        this.removeFromChannel(agentId, key);
        this.emitPresence(a);
        return true;
    }

    private channelInfo(key: string): WhisperChannelInfo {
        const idx = key.indexOf(':');
        const workspaceId = idx >= 0 ? key.slice(0, idx) : key;
        const purpose = idx >= 0 ? key.slice(idx + 1) : key;
        const info = this.wsInfo.get(workspaceId);
        return {
            key,
            slug: info?.slug ?? workspaceId,
            purpose,
            workspaceId,
            workspaceName: info?.name ?? workspaceId,
            memberCount: this.channelMembers.get(key)?.size ?? 0,
        };
    }

    /** Every non-empty channel (the human panel's full list). */
    channels(): WhisperChannelInfo[] {
        const out: WhisperChannelInfo[] = [];
        for (const [key, members] of this.channelMembers) {
            if (members.size > 0) out.push(this.channelInfo(key));
        }
        return out.sort((a, b) => a.key.localeCompare(b.key));
    }

    /** The channels an agent is a member of (its agent-facing `list`). */
    channelsForAgent(agentId: string): WhisperChannelInfo[] {
        const out: WhisperChannelInfo[] = [];
        for (const [key, members] of this.channelMembers) {
            if (members.has(agentId)) out.push(this.channelInfo(key));
        }
        return out.sort((a, b) => a.key.localeCompare(b.key));
    }

    // --- discovery ---------------------------------------------------------

    /** Whether `target` is discoverable/DM-able BY `caller` under target's scope. */
    private visible(caller: WhisperAgent, target: WhisperAgent): boolean {
        if (caller.agentId === target.agentId) return true; // always sees itself
        switch (target.scope) {
            case 'all':
                return true;
            case 'self':
                return caller.workspaceId === target.workspaceId;
            case 'specific':
                return (
                    caller.workspaceId === target.workspaceId ||
                    target.scopeWorkspaces.includes(caller.workspaceId)
                );
            case 'none':
            default:
                return false;
        }
    }

    /** Every agent (the human panel's directory — the human sees all, no scope). */
    directory(): WhisperAgentInfo[] {
        return [...this.agents.values()].map((a) => this.toInfo(a));
    }

    /** The peers discoverable BY an agent (excludes itself; honours scope). */
    discoverableFor(callerAgentId: string): WhisperAgentInfo[] {
        const caller = this.agents.get(callerAgentId);
        if (!caller) return [];
        const out: WhisperAgentInfo[] = [];
        for (const target of this.agents.values()) {
            if (target.agentId === callerAgentId) continue;
            if (this.visible(caller, target)) out.push(this.toInfo(target));
        }
        return out;
    }

    /** The public info for one agent (or null). */
    getInfo(agentId: string): WhisperAgentInfo | null {
        const a = this.agents.get(agentId);
        return a ? this.toInfo(a) : null;
    }

    // --- delivery ----------------------------------------------------------

    private push(agent: WhisperAgent, msg: WhisperMessage): void {
        agent.inbox.push(msg);
        if (agent.inbox.length > INBOX_CAP) {
            agent.inbox.splice(0, agent.inbox.length - INBOX_CAP);
        }
        this.settleWaiter(agent);
    }

    private appendLog(map: Map<string, WhisperMessage[]>, key: string, msg: WhisperMessage): void {
        let log = map.get(key);
        if (!log) {
            log = [];
            map.set(key, log);
        }
        log.push(msg);
        if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    }

    private emitMessage(msg: WhisperMessage): void {
        this.emit({
            type: 'message',
            preview: {
                kind: msg.kind,
                channelKey: msg.kind === 'channel' ? msg.channel : undefined,
                toAgentId: msg.kind === 'dm' ? msg.to : undefined,
                from: msg.from,
                fromLabel: msg.fromLabel,
                seq: msg.seq,
                ts: msg.ts,
                preview: previewText(msg.text),
            },
        });
    }

    /**
     * Deliver a message. Exactly one of `toAgentId` (a DM) or `channelArg` (a
     * channel broadcast) must be set. `human:true` posts as the human panel; else
     * `fromAgentId` is the sending agent. Returns how many recipients it reached
     * (`delivered`) or an error. No self-echo on channels.
     */
    send(input: {
        fromAgentId?: string;
        human?: boolean;
        toAgentId?: string;
        channelArg?: string;
        text: string;
        interrupt?: boolean;
    }): { ok: true; delivered: number; message: WhisperMessage } | { ok: false; error: string } {
        const text = String(input.text ?? '');
        if (!text.trim()) return { ok: false, error: 'A message needs non-empty text.' };

        let from: string;
        let fromLabel: string;
        let sender: WhisperAgent | null = null;
        if (input.human) {
            from = WHISPER_HUMAN;
            fromLabel = 'You';
        } else {
            sender = input.fromAgentId ? this.agents.get(input.fromAgentId) ?? null : null;
            if (!sender) return { ok: false, error: 'Unknown sender.' };
            from = sender.agentId;
            fromLabel = sender.label || `${sender.slug}:${sender.purpose}`;
        }

        if (input.toAgentId && input.channelArg) {
            return { ok: false, error: 'Send to a channel OR an agent, not both.' };
        }

        const base = {
            seq: 0, // assigned below
            id: crypto.randomUUID(),
            from,
            fromLabel,
            ts: Date.now(),
        };

        // --- DM ---
        if (input.toAgentId) {
            const target = this.agents.get(input.toAgentId);
            if (!target) return { ok: false, error: `No agent "${input.toAgentId}".` };
            // Agent senders may only DM a peer discoverable AT SEND TIME. The human
            // panel owns the workstation, so it can DM anyone.
            if (sender && !this.visible(sender, target)) {
                return { ok: false, error: 'That agent is not reachable from your workspace.' };
            }
            const msg: WhisperMessage = {
                ...base,
                seq: ++this.seq,
                kind: 'dm',
                to: target.agentId,
                text,
                ...(input.interrupt ? { interrupt: true } : {}),
            };
            this.push(target, msg);
            this.appendLog(this.dmLogs, pairKey(from, target.agentId), msg);
            this.emitMessage(msg);
            if (input.interrupt && target.terminalId) {
                this.emit({ type: 'interrupt', terminalId: target.terminalId });
            }
            return { ok: true, delivered: 1, message: msg };
        }

        // --- channel ---
        if (input.channelArg) {
            let key: string | null;
            if (input.human) {
                // The human posts by an explicit channel KEY (from the panel);
                // resolve a slug-qualified form too, but a bare key is the norm.
                key = this.channelMembers.has(input.channelArg)
                    ? input.channelArg
                    : this.resolveChannelKeyFromAny(input.channelArg);
            } else {
                key = this.resolveChannelKey(sender!.agentId, input.channelArg);
                // Convenience: a sending agent auto-joins the channel it posts to.
                if (key) this.addToChannel(sender!.agentId, key);
            }
            if (!key) return { ok: false, error: `Unknown channel "${input.channelArg}".` };
            const msg: WhisperMessage = {
                ...base,
                seq: ++this.seq,
                kind: 'channel',
                channel: key,
                text,
            };
            const members = this.channelMembers.get(key) ?? new Set<string>();
            let delivered = 0;
            for (const memberId of members) {
                if (memberId === from) continue; // no self-echo
                const member = this.agents.get(memberId);
                if (!member) continue;
                this.push(member, msg);
                delivered++;
            }
            this.appendLog(this.channelLogs, key, msg);
            this.emitMessage(msg);
            return { ok: true, delivered, message: msg };
        }

        return { ok: false, error: 'Send needs `to` (an agent) or `channel`.' };
    }

    /** Resolve a channel arg without a caller context (human posts / lookups). */
    private resolveChannelKeyFromAny(channelArg: string): string | null {
        const raw = String(channelArg ?? '').trim();
        const idx = raw.indexOf(':');
        if (idx < 0) return null;
        const left = raw.slice(0, idx);
        const purpose = raw.slice(idx + 1);
        if (this.wsInfo.has(left)) return this.keyFor(left, purpose);
        for (const [wsId, info] of this.wsInfo) {
            if (info.slug === left) return this.keyFor(wsId, purpose);
        }
        return null;
    }

    // --- receive (pull + long-poll) ---------------------------------------

    private settleWaiter(agent: WhisperAgent): void {
        const w = agent.waiter;
        if (!w) return;
        agent.waiter = null;
        if (w.timer) clearTimeout(w.timer);
        const pending = agent.inbox.filter((m) => m.seq > w.cursor);
        w.resolve(pending);
    }

    /**
     * Page an agent's inbox from `cursor` (exclusive). With `wait:true` and
     * nothing new, LONG-POLL: park a single waiter that resolves when a message
     * arrives, the agent leaves/goes away, or `timeoutMs` elapses (returning
     * empty). Always resolves; the returned `cursor` is the highest seq seen (so
     * the caller pages forward). A second concurrent wait supersedes the first
     * (resolving it empty) — one live waiter per agent.
     */
    receive(
        agentId: string,
        opts: { cursor?: number; wait?: boolean; timeoutMs?: number } = {},
    ): Promise<{ messages: WhisperMessage[]; cursor: number }> {
        const agent = this.agents.get(agentId);
        const cursor = opts.cursor ?? 0;
        if (!agent) return Promise.resolve({ messages: [], cursor });

        const pending = agent.inbox.filter((m) => m.seq > cursor);
        const nextCursor = (msgs: WhisperMessage[]): number =>
            msgs.length ? msgs[msgs.length - 1].seq : cursor;

        if (pending.length > 0 || !opts.wait) {
            return Promise.resolve({ messages: pending, cursor: nextCursor(pending) });
        }

        // Long-poll: supersede any existing waiter, then park a new one.
        if (agent.waiter) this.settleWaiter(agent);
        const waitMs = Math.min(
            Math.max(1, opts.timeoutMs ?? DEFAULT_WAIT_MS),
            MAX_WAIT_MS,
        );
        return new Promise((resolve) => {
            const finish = (msgs: WhisperMessage[]): void =>
                resolve({ messages: msgs, cursor: nextCursor(msgs) });
            const timer = setTimeout(() => {
                if (agent.waiter && agent.waiter.resolve === finish) agent.waiter = null;
                finish([]);
            }, waitMs);
            if (typeof (timer as { unref?: () => void }).unref === 'function') {
                (timer as { unref: () => void }).unref();
            }
            agent.waiter = { resolve: finish, cursor, timer };
        });
    }

    // --- history (human panel) --------------------------------------------

    /**
     * Resolve a display label for a DM participant, tolerating a departed agent.
     * The human is always `You`; a live agent uses its current label; an agent
     * that has already LEFT is recovered from the label it stamped on a message
     * in `log` (else the raw id, so the thread is never label-less).
     */
    private dmLabelFor(id: string, log: WhisperMessage[]): string {
        if (id === WHISPER_HUMAN) return 'You';
        const live = this.agents.get(id);
        if (live) return live.label || `${live.slug}:${live.purpose}`;
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].from === id) return log[i].fromLabel;
        }
        return id;
    }

    /**
     * Every DM thread that has messages — human↔agent AND agent↔agent — for the
     * human panel's DMs list. The human owns the workstation, so (like
     * {@link directory}) there is NO scope filter. Each entry carries both
     * participants' labels and a last-message preview, sorted newest-first.
     */
    dmThreads(): WhisperDmThreadInfo[] {
        const out: WhisperDmThreadInfo[] = [];
        for (const [key, log] of this.dmLogs) {
            if (log.length === 0) continue;
            const sep = key.indexOf('|');
            const a = key.slice(0, sep);
            const b = key.slice(sep + 1);
            const last = log[log.length - 1];
            out.push({
                key,
                a,
                b,
                aLabel: this.dmLabelFor(a, log),
                bLabel: this.dmLabelFor(b, log),
                withHuman: a === WHISPER_HUMAN || b === WHISPER_HUMAN,
                lastFromLabel: last.fromLabel,
                lastPreview: previewText(last.text),
                lastSeq: last.seq,
                lastTs: last.ts,
                count: log.length,
            });
        }
        // Newest-first by ts, tie-broken by seq (monotonic — never ties, so the
        // order is deterministic even for messages within the same millisecond).
        return out.sort((x, y) => y.lastTs - x.lastTs || y.lastSeq - x.lastSeq);
    }

    /**
     * The message log for a channel (`channelKey`), an arbitrary DM pair
     * (`dmPair: [idA, idB]` — either may be the human; covers agent↔agent), or —
     * for back-compat — the human↔agent thread (`agentId`). Newest-last, capped
     * by `limit`, optionally paged with `before` (only messages with seq <
     * before).
     */
    history(opts: {
        channelKey?: string;
        agentId?: string;
        dmPair?: [string, string];
        limit?: number;
        before?: number;
    }): WhisperMessage[] {
        let log: WhisperMessage[] = [];
        if (opts.channelKey) {
            log = this.channelLogs.get(opts.channelKey) ?? [];
        } else if (opts.dmPair) {
            log = this.dmLogs.get(pairKey(opts.dmPair[0], opts.dmPair[1])) ?? [];
        } else if (opts.agentId) {
            log = this.dmLogs.get(pairKey(WHISPER_HUMAN, opts.agentId)) ?? [];
        }
        let out = log;
        if (opts.before !== undefined) out = out.filter((m) => m.seq < opts.before!);
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
        return out.slice(-limit);
    }

    // --- test / diagnostic accessors --------------------------------------

    /** Reset all state — test-only. */
    _reset(): void {
        this.agents.clear();
        this.byTerminal.clear();
        this.channelMembers.clear();
        this.wsInfo.clear();
        this.channelLogs.clear();
        this.dmLogs.clear();
        this.seq = 0;
    }
}

/**
 * The process-wide singleton. Everyone (MCP host-tools, terminal lifecycle, IPC
 * handlers) shares this instance; presence.ts installs the real emitter at boot.
 */
export const whisperBroker = new WhisperBroker();

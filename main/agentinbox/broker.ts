import crypto from 'crypto';
import {
    normalizePurpose,
    previewText,
    AGENTINBOX_HUMAN,
    type AgentInboxAgentInfo,
    type AgentInboxBrokerEvent,
    type AgentInboxChannelInfo,
    type AgentInboxDmThreadInfo,
    type AgentInboxEscalation,
    type AgentInboxJoinInput,
    type AgentInboxMessage,
    type AgentInboxScope,
    type WorkspaceAccessPolicy,
} from './types';
import { noopAgentInboxStore, type AgentInboxStore } from './store';
import { shouldWakeAgent, wakeNudgeText } from './wake';

/**
 * AgentInbox broker — the in-memory registry + channels + inboxes powering the
 * local inter-agent messaging network. PURE: no electron, no db, no fs. All
 * durable identity (agent_id, purpose, scope, workspaces, chat_session_id) rides
 * `terminal_specs.meta`; the caller resolves that (+ workspace slug/name) and
 * hands the broker plain {@link AgentInboxJoinInput}s, and rehydrates them at boot.
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
/** Default long-poll window. The real ceiling is the MCP CLIENT's idle timeout
 *  (~5min for HTTP transports); the SSE heartbeat + `notifications/progress` in
 *  server.ts keep the socket alive up to it. We sit just under that so a waiting
 *  agent BLOCKS IN ONE CALL instead of re-polling — a 55s default made agents
 *  look like they were polling in a loop when the mechanism is push-on-delivery.
 *  Raise toward MAX_WAIT_MS only once a client is confirmed to honour progress
 *  as an idle-timeout reset (claude-code#58687 says it may not). */
export const DEFAULT_WAIT_MS = 240_000;
/** Hard cap on a requested long-poll window. */
export const MAX_WAIT_MS = 600_000;
/** How long an urgent (`interrupt`) DM may sit unACKed before it escalates to the
 *  human oversight surface (Track C). ACK = the target's cursor passing the DM. */
export const ESCALATION_MS = 5 * 60_000;

/** A tracked urgent DM awaiting ACK (Track C). */
interface PendingEscalation {
    targetAgentId: string;
    seq: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** Whether the escalation event has already fired to the human. */
    fired: boolean;
    payload: AgentInboxEscalation;
}

interface Waiter {
    resolve: (msgs: AgentInboxMessage[]) => void;
    cursor: number;
    timer: ReturnType<typeof setTimeout> | null;
}

// `reachable` is a per-CALLER verdict computed at read time, never agent state —
// so the stored record deliberately omits it.
interface AgentInboxAgent extends Omit<AgentInboxAgentInfo, 'reachable'> {
    /** Queued messages awaiting `receive` (capped). */
    inbox: AgentInboxMessage[];
    /** The single live long-poll resolver, or null. */
    waiter: Waiter | null;
    /** Highest seq this agent has received (its ACK position). Persisted to the
     *  store so restart-survival + unACKed-urgent escalation (Track C) work. */
    cursor: number;
    /** Opt-in wake-on-DM (issue #9): a DM to an IDLE agent may inject a nudge to
     *  start a turn. Default OFF — a persisted preference (spec meta). */
    wakeOnDm: boolean;
    /** Epoch ms the agent's last turn ended (imDone), or null. Wake-on-DM idle signal. */
    lastTurnEndAt: number | null;
    /** Epoch ms of the agent terminal's last output byte, or null. Wake-on-DM idle signal. */
    lastOutputAt: number | null;
    /** Epoch ms we last woke this agent, or null. One wake per idle period. */
    lastWokenAt: number | null;
}

/** Normalise a DM pair into a stable, order-independent log key. */
function pairKey(a: string, b: string): string {
    return [a, b].sort().join('|');
}

export class AgentInboxBroker {
    private agents = new Map<string, AgentInboxAgent>();
    private byTerminal = new Map<string, string>(); // terminalId → agentId
    private channelMembers = new Map<string, Set<string>>(); // channelKey → agentIds
    /** workspaceId → { slug, name }, learned from every join (for channel labels). */
    private wsInfo = new Map<string, { slug: string; name: string }>();
    private channelLogs = new Map<string, AgentInboxMessage[]>();
    private dmLogs = new Map<string, AgentInboxMessage[]>();
    private seq = 0;
    private emit: (ev: AgentInboxBrokerEvent) => void = () => {};
    /** Durability backstop (genie.db in production, no-op for tests). */
    private store: AgentInboxStore = noopAgentInboxStore;
    /** Urgent DMs awaiting ACK, keyed by messageId (Track C). */
    private escalations = new Map<string, PendingEscalation>();
    /** Escalation delay — overridable in tests so they don't wait 5 minutes. */
    private escalationMs = ESCALATION_MS;

    /** Wire the outbound event sink (presence.ts installs the real one at boot). */
    setEmitter(fn: (ev: AgentInboxBrokerEvent) => void): void {
        this.emit = fn;
    }

    /** Wire the durable store (background.ts installs the genie.db one at boot). */
    setStore(store: AgentInboxStore): void {
        this.store = store;
    }

    /** Deliver a wake nudge to a terminal (injects text + submit). Injected by the
     *  host at boot (writes to the pty); absent in tests → wake is a no-op. Kept a
     *  seam so the broker stays electron-free. */
    private wakeSink: ((terminalId: string, text: string) => void) | null = null;
    /** Clock — injectable so wake-on-DM idle timing is deterministically testable. */
    private now: () => number = () => Date.now();

    setWakeSink(fn: (terminalId: string, text: string) => void): void {
        this.wakeSink = fn;
    }

    /** Resolve a workspace's access policy (the OUTER tier). Injected by the host
     *  at boot from the `workspaces` table; absent in tests / before wiring it
     *  defaults PERMISSIVE (`all`), which is exactly the pre-feature behaviour —
     *  channels were ungoverned — so nothing silently tightens on upgrade. */
    private workspaceAccess: ((workspaceId: string) => WorkspaceAccessPolicy) | null = null;

    setWorkspaceAccessResolver(fn: (workspaceId: string) => WorkspaceAccessPolicy): void {
        this.workspaceAccess = fn;
    }

    /** Test seam for the wake-on-DM clock. */
    setClock(now: () => number): void {
        this.now = now;
    }

    /** Record that an agent's TURN ENDED (its terminal called imDone) — the
     *  wake-on-DM idle signal. No-op for a terminal with no agent. */
    markTurnEnd(terminalId: string): void {
        const a = this.agentForTerminal(terminalId);
        if (a) a.lastTurnEndAt = this.now();
    }

    /** Record that an agent terminal produced OUTPUT — any output SINCE a turn end
     *  means a new turn (or a human typing) started, which fail-closes wake-on-DM.
     *  Called from the terminal output choke point; cheap (a timestamp write). */
    noteOutput(terminalId: string): void {
        const a = this.agentForTerminal(terminalId);
        if (a) a.lastOutputAt = this.now();
    }

    private agentForTerminal(terminalId: string): AgentInboxAgent | null {
        const id = this.byTerminal.get(terminalId);
        return id ? this.agents.get(id) ?? null : null;
    }

    /**
     * Wake-on-DM (issue #9): if `target` opted in AND is PROVABLY idle at its
     * prompt, inject a nudge so a dormant agent actually starts a turn. Fail-safe —
     * {@link shouldWakeAgent} refuses on any output since the last turn ended (a new
     * turn / a human typing), so this can never inject mid-turn. A refused wake is
     * harmless: the sender still sees the DM unseen via `receipts` and can nudge by
     * hand. Best-effort; a failed inject is swallowed.
     */
    private maybeWake(target: AgentInboxAgent): void {
        if (!this.wakeSink || !target.terminalId) return;
        const wake = shouldWakeAgent({
            wakeOnDm: target.wakeOnDm,
            lastTurnEndAt: target.lastTurnEndAt,
            lastOutputAt: target.lastOutputAt,
            lastWokenAt: target.lastWokenAt,
            now: this.now(),
        });
        if (!wake) return;
        const unread = target.inbox.filter((m) => m.seq > target.cursor).length;
        target.lastWokenAt = this.now();
        try {
            this.wakeSink(target.terminalId, wakeNudgeText(unread));
        } catch {
            /* a failed wake just leaves the DM for read-receipts + a manual nudge */
        }
    }

    /**
     * Wake a terminal's agent for a NON-AgentInbox reason (e.g. an IssueWatch ping),
     * reusing the EXACT same fail-safe idle gate + pty injection as wake-on-DM.
     * The caller's OWN opt-in is the gate here (an agent whose `issuewatch_action`
     * is `wake`), so `wakeOnDm` is forced true — but every other safety condition
     * ({@link shouldWakeAgent}: turn ended, quiet window, no output since, one wake
     * per idle period) still applies, so this can never inject mid-turn. Works for
     * any agent terminal, since every agent terminal registers an AgentInbox identity
     * (its idle timestamps are tracked via markTurnEnd/noteOutput). Returns true
     * iff a nudge was actually sent (the agent was provably idle).
     */
    wakeTerminalIfIdle(terminalId: string, text: string): boolean {
        if (!this.wakeSink) return false;
        const a = this.agentForTerminal(terminalId);
        if (!a) return false;
        const wake = shouldWakeAgent({
            wakeOnDm: true,
            lastTurnEndAt: a.lastTurnEndAt,
            lastOutputAt: a.lastOutputAt,
            lastWokenAt: a.lastWokenAt,
            now: this.now(),
        });
        if (!wake) return false;
        a.lastWokenAt = this.now();
        try {
            this.wakeSink(terminalId, text);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Rehydrate the in-memory logs + inboxes from the store at boot — call AFTER
     * {@link rehydrate} (identities) and {@link setStore}. Resumes the global seq
     * (so cursors stay valid), rebuilds the human-panel channel/DM history, and
     * re-queues each known agent's undelivered messages so a message sent while
     * the app was down still lands on the next `receive`.
     */
    rehydrateMessages(limit = 2000): void {
        this.seq = Math.max(this.seq, this.store.maxSeq());
        for (const msg of this.store.loadRecent(limit)) {
            if (msg.kind === 'channel' && msg.channel) {
                this.appendLog(this.channelLogs, msg.channel, msg);
            } else if (msg.kind === 'dm' && msg.to) {
                this.appendLog(this.dmLogs, pairKey(msg.from, msg.to), msg);
            }
        }
        for (const agent of this.agents.values()) {
            agent.cursor = this.store.getCursor(agent.agentId);
            const channelKeys: string[] = [];
            for (const [key, members] of this.channelMembers) {
                if (members.has(agent.agentId)) channelKeys.push(key);
            }
            for (const msg of this.store.undeliveredFor(agent.agentId, channelKeys, agent.cursor)) {
                this.push(agent, msg);
            }
        }
    }

    /** Does the agent have unreceived mail (seq beyond its cursor)? Cheap — no
     *  long-poll. The signal a harness hook checks between turns (Track A). */
    hasMail(agentId: string): boolean {
        const a = this.agents.get(agentId);
        if (!a) return false;
        return a.inbox.some((m) => m.seq > a.cursor);
    }

    /** Unread summary for the agent bound to a TERMINAL — powers the turn-boundary
     *  nudge folded into `imDone` (Track A): surface waiting messages at the exact
     *  point an agent hands back, without ever writing into its pty. Empty when the
     *  terminal isn't an AgentInbox agent or has nothing waiting. */
    unreadForTerminal(terminalId: string): { count: number; fromLabels: string[] } {
        const agentId = this.byTerminal.get(terminalId);
        const a = agentId ? this.agents.get(agentId) : undefined;
        if (!a) return { count: 0, fromLabels: [] };
        const unread = a.inbox.filter((m) => m.seq > a.cursor);
        return { count: unread.length, fromLabels: [...new Set(unread.map((m) => m.fromLabel))] };
    }

    /** Advance + persist an agent's ACK cursor (monotonic), and resolve any urgent
     *  DMs the agent has now received (Track C). */
    private ackCursor(agent: AgentInboxAgent, cursor: number): void {
        if (cursor > agent.cursor) {
            agent.cursor = cursor;
            this.store.setCursor(agent.agentId, cursor);
            this.resolveEscalations(agent.agentId, cursor);
        }
    }

    /** Track an urgent DM: if the target hasn't received it within the escalation
     *  window, surface a "waiting on X" alert to the human (Track C). */
    private registerEscalation(msg: AgentInboxMessage, target: AgentInboxAgent): void {
        const payload: AgentInboxEscalation = {
            messageId: msg.id,
            targetAgentId: target.agentId,
            targetLabel: target.label || `${target.slug}:${target.purpose}`,
            fromLabel: msg.fromLabel,
            preview: previewText(msg.text),
            sinceTs: msg.ts,
        };
        const timer = setTimeout(() => {
            const esc = this.escalations.get(msg.id);
            if (!esc) return; // already acked/cleared
            const a = this.agents.get(esc.targetAgentId);
            if (a && a.cursor >= esc.seq) {
                this.escalations.delete(msg.id); // acked in the meantime
                return;
            }
            esc.fired = true;
            this.emit({ type: 'escalation', escalation: esc.payload });
        }, this.escalationMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }
        this.escalations.set(msg.id, {
            targetAgentId: target.agentId,
            seq: msg.seq,
            timer,
            fired: false,
            payload,
        });
    }

    /** Clear (and, if already surfaced, resolve) the urgent DMs an agent has now
     *  received — its cursor passed their seq. */
    private resolveEscalations(agentId: string, cursor: number): void {
        for (const [id, esc] of this.escalations) {
            if (esc.targetAgentId === agentId && esc.seq <= cursor) {
                if (esc.timer) clearTimeout(esc.timer);
                this.escalations.delete(id);
                if (esc.fired) {
                    this.emit({ type: 'escalation-resolved', messageId: id, targetAgentId: agentId });
                }
            }
        }
    }

    /** Test hook — shorten the escalation window so tests don't wait minutes. */
    _setEscalationMs(ms: number): void {
        this.escalationMs = ms;
    }

    /** The internal channel key for a workspace + purpose. */
    private keyFor(workspaceId: string, purpose: string): string {
        return `${workspaceId}:${normalizePurpose(purpose)}`;
    }

    /**
     * Public view of an agent. `reachable` defaults true — the human panel owns
     * the workstation and an agent always sees itself in full. Agent-facing
     * directory entries pass the composed verdict, and an UNREACHABLE entry has
     * its `scopeWorkspaces` ACL redacted: a caller the agent excluded has no
     * business reading the allow-list that excluded it.
     */
    private toInfo(a: AgentInboxAgent, reachable = true): AgentInboxAgentInfo {
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
            scopeWorkspaces: reachable ? [...a.scopeWorkspaces] : [],
            reachable,
            status: a.status,
            chatSessionId: a.chatSessionId,
        };
    }

    private emitPresence(a: AgentInboxAgent): void {
        this.emit({ type: 'presence', agent: this.toInfo(a) });
    }

    // --- membership --------------------------------------------------------

    /**
     * Register (or re-register) an agent. Idempotent per agentId: a second join
     * with the same id updates the record in place (e.g. rehydrate, or a spec
     * edit). Auto-joins the agent's own `workspaceId:purpose` channel. Returns the
     * public info.
     */
    join(input: AgentInboxJoinInput): AgentInboxAgentInfo {
        this.wsInfo.set(input.workspaceId, {
            slug: input.slug,
            name: input.workspaceName,
        });
        const purpose = normalizePurpose(input.purpose);
        const existing = this.agents.get(input.agentId);
        const agent: AgentInboxAgent = {
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
            cursor: existing?.cursor ?? 0,
            // Wake-on-DM: the opt-in is a persisted preference (from the join input,
            // e.g. spec meta) that survives a re-join; the idle-signal timestamps are
            // runtime state carried across a re-join, never reset by it.
            wakeOnDm: input.wakeOnDm ?? existing?.wakeOnDm ?? false,
            lastTurnEndAt: existing?.lastTurnEndAt ?? null,
            lastOutputAt: existing?.lastOutputAt ?? null,
            lastWokenAt: existing?.lastWokenAt ?? null,
        };
        this.agents.set(agent.agentId, agent);
        this.byTerminal.set(agent.terminalId, agent.agentId);
        // Own channel — its purpose room.
        this.addToChannel(agent.agentId, this.keyFor(agent.workspaceId, purpose));
        this.emitPresence(agent);
        return this.toInfo(agent);
    }

    /** Re-register a set of agents at boot (from persisted specs). */
    rehydrate(inputs: AgentInboxJoinInput[]): void {
        for (const input of inputs) {
            this.join({ ...input, status: input.status ?? 'away' });
        }
    }

    /** Mark an agent's terminal alive again (it's actively calling agentinbox). */
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
        patch: {
            scope?: AgentInboxScope;
            workspaces?: string[];
            purpose?: string;
            wakeOnDm?: boolean;
            label?: string;
        },
    ): AgentInboxAgentInfo | null {
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
        if (patch.wakeOnDm !== undefined) a.wakeOnDm = patch.wakeOnDm;
        // Keep the display label in sync so AgentInbox reflects a renamed purpose
        // (the broker prefers `label` over `slug:purpose` everywhere it renders).
        if (patch.label !== undefined) a.label = patch.label;
        this.emitPresence(a);
        return this.toInfo(a);
    }

    /** The agent's current wake-on-DM opt-in — the host persists this to spec meta
     *  so it survives a restart (restored via the join input). */
    wakeOnDmFor(agentId: string): boolean {
        return this.agents.get(agentId)?.wakeOnDm ?? false;
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

    /** The workspace that owns a channel key (`<workspaceId>:<purpose>`). */
    private workspaceOfKey(key: string): string {
        const idx = key.indexOf(':');
        return idx >= 0 ? key.slice(0, idx) : key;
    }

    /**
     * Opt an agent into an arbitrary channel (beyond its own purpose room).
     * Gated by the OUTER tier: joining another workspace's room requires that
     * workspace to admit yours. Before this gate existed any agent could join —
     * and broadcast into — any workspace's channel.
     */
    joinChannel(agentId: string, channelArg: string): boolean {
        const a = this.agents.get(agentId);
        if (!a) return false;
        const key = this.resolveChannelKey(agentId, channelArg);
        if (!key) return false;
        if (!this.workspaceAllows(a.workspaceId, this.workspaceOfKey(key))) return false;
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

    private channelInfo(key: string): AgentInboxChannelInfo {
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
    channels(): AgentInboxChannelInfo[] {
        const out: AgentInboxChannelInfo[] = [];
        for (const [key, members] of this.channelMembers) {
            if (members.size > 0) out.push(this.channelInfo(key));
        }
        return out.sort((a, b) => a.key.localeCompare(b.key));
    }

    /** The channels an agent is a member of (its agent-facing `list`). */
    channelsForAgent(agentId: string): AgentInboxChannelInfo[] {
        const out: AgentInboxChannelInfo[] = [];
        for (const [key, members] of this.channelMembers) {
            if (members.has(agentId)) out.push(this.channelInfo(key));
        }
        return out.sort((a, b) => a.key.localeCompare(b.key));
    }

    // --- discovery ---------------------------------------------------------

    /**
     * OUTER TIER — may an agent in `callerWorkspaceId` reach into
     * `targetWorkspaceId` at all? Governs channel join/post AND agent discovery.
     * Same-workspace access is always allowed (a workspace never locks itself
     * out). With no resolver wired this is permissive — see `workspaceAccess`.
     */
    workspaceAllows(callerWorkspaceId: string, targetWorkspaceId: string): boolean {
        if (callerWorkspaceId === targetWorkspaceId) return true;
        if (!this.workspaceAccess) return true; // unwired → pre-feature behaviour
        const policy = this.workspaceAccess(targetWorkspaceId);
        switch (policy.access) {
            case 'all':
                return true;
            case 'specific':
                return policy.workspaces.includes(callerWorkspaceId);
            case 'self':
            case 'none':
            default:
                return false;
        }
    }

    /** INNER TIER — does `target`'s own scope admit a DM from `caller`? */
    private scopeAllows(caller: AgentInboxAgent, target: AgentInboxAgent): boolean {
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
            case 'hidden':
            default:
                return false;
        }
    }

    /**
     * Whether `target` appears in `caller`'s directory AT ALL. Denial by the
     * workspace tier, or an explicit `hidden` scope, omits the agent; every other
     * agent is listed (possibly as unreachable) so peers can discover it and ask
     * for access.
     */
    private visible(caller: AgentInboxAgent, target: AgentInboxAgent): boolean {
        if (caller.agentId === target.agentId) return true; // always sees itself
        if (target.scope === 'hidden') return false;
        return this.workspaceAllows(caller.workspaceId, target.workspaceId);
    }

    /** Whether `caller` may actually DM `target` — BOTH tiers must admit it. */
    private reachable(caller: AgentInboxAgent, target: AgentInboxAgent): boolean {
        if (caller.agentId === target.agentId) return true;
        return this.visible(caller, target) && this.scopeAllows(caller, target);
    }

    /** Every agent (the human panel's directory — the human sees all, no scope). */
    directory(): AgentInboxAgentInfo[] {
        return [...this.agents.values()].map((a) => this.toInfo(a));
    }

    /**
     * The peers an agent can DISCOVER (excludes itself). Includes agents it may
     * not message — those carry `reachable: false` so the caller knows they exist
     * and can request access, rather than the peer silently not existing.
     */
    discoverableFor(callerAgentId: string): AgentInboxAgentInfo[] {
        const caller = this.agents.get(callerAgentId);
        if (!caller) return [];
        const out: AgentInboxAgentInfo[] = [];
        for (const target of this.agents.values()) {
            if (target.agentId === callerAgentId) continue;
            if (!this.visible(caller, target)) continue;
            out.push(this.toInfo(target, this.scopeAllows(caller, target)));
        }
        return out;
    }

    /** The public info for one agent (or null). */
    getInfo(agentId: string): AgentInboxAgentInfo | null {
        const a = this.agents.get(agentId);
        return a ? this.toInfo(a) : null;
    }

    // --- delivery ----------------------------------------------------------

    private push(agent: AgentInboxAgent, msg: AgentInboxMessage): void {
        agent.inbox.push(msg);
        if (agent.inbox.length > INBOX_CAP) {
            agent.inbox.splice(0, agent.inbox.length - INBOX_CAP);
        }
        this.settleWaiter(agent);
    }

    private appendLog(map: Map<string, AgentInboxMessage[]>, key: string, msg: AgentInboxMessage): void {
        let log = map.get(key);
        if (!log) {
            log = [];
            map.set(key, log);
        }
        log.push(msg);
        if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    }

    private emitMessage(msg: AgentInboxMessage): void {
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
    }): { ok: true; delivered: number; message: AgentInboxMessage } | { ok: false; error: string } {
        const text = String(input.text ?? '');
        if (!text.trim()) return { ok: false, error: 'A message needs non-empty text.' };

        let from: string;
        let fromLabel: string;
        let sender: AgentInboxAgent | null = null;
        if (input.human) {
            from = AGENTINBOX_HUMAN;
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
            // Agent senders may only DM a peer REACHABLE at send time (workspace
            // tier AND the target's own scope). Re-checked here rather than
            // trusted from a possibly-stale `list`. The human panel owns the
            // workstation, so it can DM anyone.
            if (sender && !this.reachable(sender, target)) {
                return { ok: false, error: 'That agent is not reachable from your workspace.' };
            }
            const msg: AgentInboxMessage = {
                ...base,
                seq: ++this.seq,
                kind: 'dm',
                to: target.agentId,
                text,
                ...(input.interrupt ? { interrupt: true } : {}),
            };
            this.push(target, msg);
            this.appendLog(this.dmLogs, pairKey(from, target.agentId), msg);
            this.store.append(msg);
            this.emitMessage(msg);
            // Wake-on-DM (opt-in, fail-safe): nudge a genuinely-idle target so a
            // dormant agent starts a turn instead of staying deaf.
            this.maybeWake(target);
            if (input.interrupt) {
                if (target.terminalId) {
                    this.emit({ type: 'interrupt', terminalId: target.terminalId });
                }
                // Track C: escalate to the human if the target doesn't drain it.
                this.registerEscalation(msg, target);
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
                // OUTER tier: broadcasting into another workspace's room requires
                // that workspace to admit yours. Checked BEFORE the auto-join so a
                // refused sender doesn't silently become a member.
                if (
                    key &&
                    !this.workspaceAllows(sender!.workspaceId, this.workspaceOfKey(key))
                ) {
                    return {
                        ok: false,
                        error: `Channel "${input.channelArg}" belongs to a workspace that does not accept agents from yours.`,
                    };
                }
                // Convenience: a sending agent auto-joins the channel it posts to.
                if (key) this.addToChannel(sender!.agentId, key);
            }
            if (!key) return { ok: false, error: `Unknown channel "${input.channelArg}".` };
            const msg: AgentInboxMessage = {
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
            this.store.append(msg);
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

    private settleWaiter(agent: AgentInboxAgent): void {
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
    ): Promise<{ messages: AgentInboxMessage[]; cursor: number }> {
        const agent = this.agents.get(agentId);
        const cursor = opts.cursor ?? 0;
        if (!agent) return Promise.resolve({ messages: [], cursor });

        const pending = agent.inbox.filter((m) => m.seq > cursor);
        const nextCursor = (msgs: AgentInboxMessage[]): number =>
            msgs.length ? msgs[msgs.length - 1].seq : cursor;

        if (pending.length > 0 || !opts.wait) {
            const c = nextCursor(pending);
            this.ackCursor(agent, c);
            return Promise.resolve({ messages: pending, cursor: c });
        }

        // Long-poll: supersede any existing waiter, then park a new one.
        if (agent.waiter) this.settleWaiter(agent);
        const waitMs = Math.min(
            Math.max(1, opts.timeoutMs ?? DEFAULT_WAIT_MS),
            MAX_WAIT_MS,
        );
        return new Promise((resolve) => {
            const finish = (msgs: AgentInboxMessage[]): void => {
                const c = nextCursor(msgs);
                this.ackCursor(agent, c);
                resolve({ messages: msgs, cursor: c });
            };
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

    /**
     * Read-receipts for the DMs an agent SENT — each with whether the recipient
     * has SEEN it (their ACK cursor passed the message's seq). Lets a sender tell
     * 'queued' from 'seen' and decide whether to escalate to a nudge (issue #9).
     * Durable-store backed (survives restart); newest first, capped.
     */
    receipts(agentId: string, limit = 20): ReturnType<AgentInboxStore['sentDmReceipts']> {
        const cap = Math.min(Math.max(1, limit), 100);
        return this.store.sentDmReceipts(agentId, cap);
    }

    // --- history (human panel) --------------------------------------------

    /**
     * Resolve a display label for a DM participant, tolerating a departed agent.
     * The human is always `You`; a live agent uses its current label; an agent
     * that has already LEFT is recovered from the label it stamped on a message
     * in `log` (else the raw id, so the thread is never label-less).
     */
    private dmLabelFor(id: string, log: AgentInboxMessage[]): string {
        if (id === AGENTINBOX_HUMAN) return 'You';
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
    dmThreads(): AgentInboxDmThreadInfo[] {
        const out: AgentInboxDmThreadInfo[] = [];
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
                withHuman: a === AGENTINBOX_HUMAN || b === AGENTINBOX_HUMAN,
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
    }): AgentInboxMessage[] {
        let log: AgentInboxMessage[] = [];
        if (opts.channelKey) {
            log = this.channelLogs.get(opts.channelKey) ?? [];
        } else if (opts.dmPair) {
            log = this.dmLogs.get(pairKey(opts.dmPair[0], opts.dmPair[1])) ?? [];
        } else if (opts.agentId) {
            log = this.dmLogs.get(pairKey(AGENTINBOX_HUMAN, opts.agentId)) ?? [];
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
export const agentInboxBroker = new AgentInboxBroker();

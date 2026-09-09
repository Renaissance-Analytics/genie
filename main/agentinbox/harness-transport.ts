import type { WorkspaceAgentTransport } from '../db';
import type { AgentTuiId } from '../agents/registry';

export type HarnessAgentProvider = AgentTuiId;

export function requiredHarnessTransport(
    provider: HarnessAgentProvider | string | null | undefined,
): WorkspaceAgentTransport | null {
    if (provider === 'claude') return 'claude-channel';
    if (provider === 'codex') return 'codex-app-server';
    // Reserved provider names are not readiness claims. They become available
    // only when a real harness-owned adapter is implemented.
    return null;
}

export interface HarnessTransportPayload {
    text: string;
    [key: string]: unknown;
}

export type HarnessTransportDelivery =
    | { ok: true; queued: false }
    | { ok: false; queued: true; error: string };

/**
 * How mail crosses the last hop into the harness.
 *
 *  - `push` — Genie calls the adapter's `send` and learns from its promise
 *    whether the harness took the message (Codex App Server).
 *  - `pull` — the harness holds a blocking `receive` on the durable inbox and
 *    carries the message the last hop itself (the Claude Channel bridge). Genie
 *    has no pipe into that process, so there is nothing to push to: the binding
 *    exists to say the channel is LIVE.
 *
 *    It ACKs nothing, and may not (genie#549). Its last hop is a JSON-RPC
 *    NOTIFICATION with no reply, so it can prove a write and never a delivery —
 *    the read cursor stays the agent's own to commit, and unread mail keeps its
 *    five-minute deadline the way an unattached agent's does.
 *
 * Both are harness-native. Neither is the PTY.
 */
export type HarnessDeliveryMode = 'push' | 'pull';

interface BoundHarnessTransport {
    kind: WorkspaceAgentTransport;
    mode: HarnessDeliveryMode;
    send: ((payload: HarnessTransportPayload) => Promise<void> | void) | null;
    /** PULL only: long-polls parked on this agent's inbox right now. */
    openPolls: number;
    /** PULL only: when this binding last proved it still had a holder. */
    provenAt: number;
}

/**
 * How long a PULL binding stays trusted after its last proof of life.
 *
 * This is a bound on the GAP BETWEEN polls, not on the poll itself — a parked
 * `receive` is proof for as long as it is parked, however long that is. The
 * bridge re-polls the instant one returns, so the real gap is a few
 * milliseconds; the longest legitimate one is its own reconnect backoff, capped
 * at `RETRY_MAX_MS` (5s) in `mcp/agent-config.ts`. A minute is an order of
 * magnitude beyond that, which is the direction to err: reading a live channel
 * as dead costs a duplicate line, and reading a dead one as live costs the
 * message.
 */
export const PULL_LIVENESS_GRACE_MS = 60_000;

/**
 * Live harness connections only. Durable queueing remains AgentInbox's job;
 * this registry deliberately has no PTY/TUI-input fallback.
 */
export class HarnessTransportRegistry {
    private readonly sessions = new Map<string, BoundHarnessTransport>();

    /**
     * Injectable so the liveness deadline can be tested without real time.
     *
     * The default READS `Date.now` per call rather than capturing it: a bound
     * reference taken at construction outlives any later replacement of the
     * global clock, which would leave the singleton — built at module load —
     * measuring against a clock no test can move.
     */
    constructor(private readonly now: () => number = () => Date.now()) {}

    bind(
        agentId: string,
        kind: WorkspaceAgentTransport,
        send: NonNullable<BoundHarnessTransport['send']>,
    ): void {
        this.sessions.set(agentId, {
            kind,
            mode: 'push',
            send,
            openPolls: 0,
            provenAt: this.now(),
        });
    }

    /**
     * Record a live PULL transport — a harness that fetches its own mail.
     *
     * There is no sender to keep, so the binding carries only the fact of the
     * connection. That fact is what stops AgentInbox reaching for the keyboard:
     * an agent whose channel is live already has the message coming.
     *
     * The handshake itself counts as proof: `registerTransport` is the bridge
     * speaking to us, and it lands here BEFORE the first `receive` is parked.
     */
    bindPull(agentId: string, kind: WorkspaceAgentTransport): void {
        this.sessions.set(agentId, {
            kind,
            mode: 'pull',
            send: null,
            openPolls: 0,
            provenAt: this.now(),
        });
    }

    /**
     * A long-poll has been PARKED on this agent's inbox — the Claude Channel
     * bridge holding an HTTP request open against us.
     *
     * This is the proof genie#528 was missing. The bridge is spawned by Claude
     * Code rather than by Genie, so Genie cannot watch the process; what it can
     * see is that something is still asking for this agent's mail.
     *
     * A no-op unless a PULL binding exists. It must never MINT one: a `receive`
     * from an agent with no channel is just an agent reading its own inbox, and
     * treating that as a transport would suppress the very PTY fallback that
     * agent depends on.
     */
    notePullPollOpen(agentId: string): void {
        const session = this.sessions.get(agentId);
        if (session?.mode !== 'pull') return;
        session.openPolls += 1;
        session.provenAt = this.now();
    }

    /**
     * That long-poll has returned — with mail, or empty at its timeout.
     *
     * Stamped as proof as well as decremented, because the bridge re-polls
     * immediately: without it, the 240s the poll spent parked would already
     * exceed the grace and a healthy channel would flicker dead between every
     * pair of polls.
     *
     * The honest limit of that: a bridge KILLED while parked leaves its poll
     * open until our own timer settles it, so it is detected a poll-length later
     * than one that stopped between polls. Both real triggers — a fatal 401/403,
     * and Claude Code closing stdin — stop the bridge with its last poll already
     * returned, which is the case this measures tightly.
     */
    notePullPollClosed(agentId: string): void {
        const session = this.sessions.get(agentId);
        if (session?.mode !== 'pull') return;
        session.openPolls = Math.max(0, session.openPolls - 1);
        session.provenAt = this.now();
    }

    /**
     * The binding behind an agent, or undefined when there is none Genie is
     * entitled to believe in.
     *
     * PUSH bindings are returned unconditionally: Codex owns its own lifecycle
     * and a send that throws unbinds it, so it is silent between turns by design
     * and has nothing to prove liveness with. Only a PULL binding faces the
     * deadline, and only because nothing ever calls into one — it cannot fail
     * its way out the way a push adapter does.
     *
     * Deliberately does NOT delete what it judges stale. Reporting dead is the
     * whole requirement, and leaving the row lets a bridge that was merely slow
     * recover on its next poll instead of needing a fresh handshake.
     */
    private live(agentId: string): BoundHarnessTransport | undefined {
        const session = this.sessions.get(agentId);
        if (!session || session.mode !== 'pull') return session;
        if (session.openPolls > 0) return session;
        return this.now() - session.provenAt <= PULL_LIVENESS_GRACE_MS ? session : undefined;
    }

    unbind(agentId: string): void {
        this.sessions.delete(agentId);
    }

    /**
     * Release a PULL binding whose holder is gone (its pty exited, or the
     * terminal was killed).
     *
     * Push bindings need no such call — a send that throws unbinds them, so a
     * dead adapter self-heals into the PTY fallback on the next message. Nothing
     * ever calls into a pull binding, so a stale one would swallow every message
     * AND suppress the fallback forever. Deliberately a no-op on a push binding,
     * which owns its own lifecycle.
     */
    unbindPull(agentId: string): void {
        if (this.sessions.get(agentId)?.mode === 'pull') this.sessions.delete(agentId);
    }

    /** Which way mail reaches this agent's harness, or null if none is live. */
    deliveryModeFor(agentId: string): HarnessDeliveryMode | null {
        return this.live(agentId)?.mode ?? null;
    }

    isVerified(agentId: string, kind?: WorkspaceAgentTransport): boolean {
        const session = this.live(agentId);
        return !!session && (kind === undefined || session.kind === kind);
    }

    /** Confirm an existing harness-owned binding without changing its sender. */
    confirm(agentId: string, kind: WorkspaceAgentTransport): boolean {
        return this.isVerified(agentId, kind);
    }

    kindFor(agentId: string): WorkspaceAgentTransport | null {
        return this.live(agentId)?.kind ?? null;
    }

    deliver(
        agentId: string,
        payload: HarnessTransportPayload,
    ): HarnessTransportDelivery | Promise<HarnessTransportDelivery> {
        // The SAME liveness the sink reads. A stale pull binding must not answer
        // "there is nothing to push to" — that reply means "attached, hold the
        // keyboard", which is exactly the suppression genie#528 is about.
        const session = this.live(agentId);
        if (!session) {
            return { ok: false, queued: true, error: 'Harness transport is not verified.' };
        }
        if (session.mode === 'pull' || !session.send) {
            // NOT a failure of the transport, so the binding stays: the channel
            // is live and will collect this message itself. Answering `ok` would
            // ACK mail nobody had handed over.
            return {
                ok: false,
                queued: true,
                error: 'This harness pulls from the durable inbox; there is nothing to push to.',
            };
        }
        return Promise.resolve(session.send(payload))
            .then(() => ({ ok: true as const, queued: false as const }))
            .catch((error: unknown) => {
                this.sessions.delete(agentId);
                return {
                    ok: false as const,
                    queued: true as const,
                    error: error instanceof Error ? error.message : String(error),
                };
            });
    }
}

export const harnessTransportRegistry = new HarnessTransportRegistry();

/**
 * Complete a harness's `registerTransport` handshake — the agent-side half of
 * "my native channel is up".
 *
 * The two adapters prove liveness in opposite directions, so the handshake
 * means something different for each:
 *
 *  - **Codex App Server** is connected by Genie, in `terminal/ipc`, before the
 *    agent can say anything. The handshake may CONFIRM that binding; minting one
 *    here would claim a session the adapter never opened.
 *  - **Claude Channel** is connected by the agent's own side: the bridge answers
 *    `initialize`, calls this, and parks its blocking `receive`. Nothing else
 *    will ever report that channel, so this call IS the binding.
 *
 * That asymmetry is why genie#344 went unnoticed: Claude's handshake recorded
 * the DB state and left the registry empty, so a live channel was invisible to
 * every question about whether the agent was attached.
 */
export function completeTransportHandshake(
    registry: HarnessTransportRegistry,
    agentId: string,
    required: WorkspaceAgentTransport,
): { ok: true } | { ok: false; error: string } {
    if (required === 'codex-app-server') {
        return registry.confirm(agentId, required)
            ? { ok: true }
            : { ok: false, error: 'The Codex app-server adapter is not connected.' };
    }
    if (required === 'claude-channel') {
        registry.bindPull(agentId, required);
        return { ok: true };
    }
    // A transport name the DB accepts but no adapter implements. Reserved names
    // are not readiness claims — see `requiredHarnessTransport`.
    return { ok: false, error: `No native adapter implements ${required}.` };
}

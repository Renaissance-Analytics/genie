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
 *    ACKs itself once its own output has accepted the notification (the Claude
 *    Channel bridge). Genie has no pipe into that process, so there is nothing
 *    to push to: the binding exists to say the channel is LIVE.
 *
 * Both are harness-native. Neither is the PTY.
 */
export type HarnessDeliveryMode = 'push' | 'pull';

interface BoundHarnessTransport {
    kind: WorkspaceAgentTransport;
    mode: HarnessDeliveryMode;
    send: ((payload: HarnessTransportPayload) => Promise<void> | void) | null;
}

/**
 * Live harness connections only. Durable queueing remains AgentInbox's job;
 * this registry deliberately has no PTY/TUI-input fallback.
 */
export class HarnessTransportRegistry {
    private readonly sessions = new Map<string, BoundHarnessTransport>();

    bind(
        agentId: string,
        kind: WorkspaceAgentTransport,
        send: NonNullable<BoundHarnessTransport['send']>,
    ): void {
        this.sessions.set(agentId, { kind, mode: 'push', send });
    }

    /**
     * Record a live PULL transport — a harness that fetches its own mail.
     *
     * There is no sender to keep, so the binding carries only the fact of the
     * connection. That fact is what stops AgentInbox reaching for the keyboard:
     * an agent whose channel is live already has the message coming.
     */
    bindPull(agentId: string, kind: WorkspaceAgentTransport): void {
        this.sessions.set(agentId, { kind, mode: 'pull', send: null });
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
        return this.sessions.get(agentId)?.mode ?? null;
    }

    isVerified(agentId: string, kind?: WorkspaceAgentTransport): boolean {
        const session = this.sessions.get(agentId);
        return !!session && (kind === undefined || session.kind === kind);
    }

    /** Confirm an existing harness-owned binding without changing its sender. */
    confirm(agentId: string, kind: WorkspaceAgentTransport): boolean {
        return this.isVerified(agentId, kind);
    }

    kindFor(agentId: string): WorkspaceAgentTransport | null {
        return this.sessions.get(agentId)?.kind ?? null;
    }

    deliver(
        agentId: string,
        payload: HarnessTransportPayload,
    ): HarnessTransportDelivery | Promise<HarnessTransportDelivery> {
        const session = this.sessions.get(agentId);
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

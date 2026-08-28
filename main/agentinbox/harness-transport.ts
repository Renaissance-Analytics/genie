import type { WorkspaceAgentTransport } from '../db';

export type HarnessAgentProvider = 'claude' | 'codex' | 'kiwi' | 'genie' | 'custom';

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

interface BoundHarnessTransport {
    kind: WorkspaceAgentTransport;
    send: (payload: HarnessTransportPayload) => Promise<void> | void;
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
        send: BoundHarnessTransport['send'],
    ): void {
        this.sessions.set(agentId, { kind, send });
    }

    unbind(agentId: string): void {
        this.sessions.delete(agentId);
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

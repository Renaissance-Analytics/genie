import type { WorkspaceAgentTransport } from '../db';

export type HarnessAgentProvider = 'claude' | 'codex' | 'custom';

export function requiredHarnessTransport(
    provider: HarnessAgentProvider | string | null | undefined,
): WorkspaceAgentTransport | null {
    if (provider === 'claude') return 'claude-channel';
    if (provider === 'codex') return 'codex-app-server';
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

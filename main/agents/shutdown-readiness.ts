import { agentInboxBroker } from '../agentinbox/broker';

export interface ShutdownAgentTarget {
    agentId: string;
    inboxAgentId: string;
    terminalId: string;
}

export interface ShutdownReadinessResult {
    ready: string[];
    timedOut: string[];
}

const SHUTDOWN_MESSAGE =
    'Genie is preparing for a full shutdown. Finish or checkpoint current work, then call thumbsUp with reason "shutdown" when it is safe to stop this agent.';

/** Bounded, one-flight readiness barrier for a real full shutdown. */
export class AgentShutdownReadiness {
    private pending = new Set<string>();
    private ready = new Set<string>();
    private finish: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly send: (agentId: string, text: string) => boolean | void) {}

    begin(targets: ShutdownAgentTarget[], timeoutMs: number): Promise<ShutdownReadinessResult> {
        if (this.finish) throw new Error('An agent shutdown readiness check is already running.');
        this.pending = new Set(targets.map((target) => target.agentId));
        this.ready.clear();
        for (const target of targets) this.send(target.inboxAgentId, SHUTDOWN_MESSAGE);
        if (this.pending.size === 0) return Promise.resolve({ ready: [], timedOut: [] });

        return new Promise((resolve) => {
            const settle = () => {
                if (this.timer) clearTimeout(this.timer);
                this.timer = null;
                this.finish = null;
                resolve({
                    ready: [...this.ready].sort(),
                    timedOut: [...this.pending].sort(),
                });
            };
            this.finish = settle;
            this.timer = setTimeout(settle, Math.max(0, timeoutMs));
        });
    }

    acknowledge(agentId: string, reason: 'boot' | 'ack' | 'shutdown'): void {
        if (reason !== 'shutdown' || !this.pending.delete(agentId)) return;
        this.ready.add(agentId);
        if (this.pending.size === 0) this.finish?.();
    }

    pendingAgentIds(): string[] {
        return [...this.pending].sort();
    }
}

export const agentShutdownReadiness = new AgentShutdownReadiness((agentId, text) =>
    agentInboxBroker.send({ system: true, toAgentId: agentId, text }).ok,
);

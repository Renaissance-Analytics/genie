/** Graceful shutdown contract (Tynn #616). Stub for the test-first checkpoint. */
export type ShutdownReason = 'upgrade' | 'quit';
export interface ShutdownAgent { readonly id: string; readonly name: string; readonly running: boolean; readonly inTurn: boolean; }
export interface AgentDrainProgress { readonly waiting: readonly { id: string; name: string }[]; readonly deadline: number; }
export interface AgentDrainOutcome { readonly interrupted: readonly { id: string; name: string }[]; readonly forced: boolean; readonly timedOut: boolean; }
export interface AgentDrainDeps {
    readonly agents: () => readonly ShutdownAgent[];
    readonly notify: (id: string, text: string) => void;
    readonly hold?: () => void;
    readonly now?: () => number;
}
export const AGENT_DRAIN_WAIT_MS = 120_000;
export class AgentShutdownDrain {
    constructor(_deps: AgentDrainDeps) {}
    begin(_reason: ShutdownReason, _progress: (state: AgentDrainProgress) => void): Promise<AgentDrainOutcome> {
        return Promise.resolve({ interrupted: [], forced: false, timedOut: false });
    }
    acknowledge(_id: string): boolean { return false; }
    force(): boolean { return false; }
}

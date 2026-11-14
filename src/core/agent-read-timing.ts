/** Opt-in tracing for separate measurement opens only (Tynn #564). Ordinary operations never read a clock. */
export const AGENT_READ_TRACE = Symbol.for('genie.measure.agent-read-stages');
export type AgentReadStage = 'producer' | 'send' | 'blob' | 'decode' | 'rebuild';
export interface AgentReadTrace {
    readonly agentId: string;
    readonly events: { stage: AgentReadStage; ms: number }[];
}
function activeTrace(agentId: string): AgentReadTrace | undefined {
    try {
        const value = (globalThis as unknown as Record<symbol, AgentReadTrace | undefined>)[AGENT_READ_TRACE];
        return value?.agentId === agentId && Array.isArray(value.events) ? value : undefined;
    } catch { return undefined; }
}

function now(): number | undefined {
    try { return performance.now(); } catch { return undefined; }
}

function record(trace: AgentReadTrace, stage: AgentReadStage, started: number | undefined): void {
    try {
        const ended = now();
        if (started !== undefined && ended !== undefined && Number.isFinite(ended - started) && ended >= started) {
            trace.events.push({ stage, ms: ended - started });
        }
    } catch { /* A diagnostic cannot replace the result or exception of real work. */ }
}

export function measureAgentRead<T>(agentId: string, stage: AgentReadStage, operation: () => T): T {
    const trace = activeTrace(agentId);
    if (!trace) return operation();
    const started = now();
    try { return operation(); } finally { record(trace, stage, started); }
}
export async function measureAgentReadAsync<T>(agentId: string, stage: AgentReadStage, operation: () => Promise<T>): Promise<T> {
    const trace = activeTrace(agentId);
    if (!trace) return operation();
    const started = now();
    try { return await operation(); } finally { record(trace, stage, started); }
}

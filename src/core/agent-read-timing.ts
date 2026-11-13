/** Opt-in tracing for separate measurement opens only (Tynn #564). RED seams; ordinary operations remain untouched. */
export const AGENT_READ_TRACE = Symbol.for('genie.measure.agent-read-stages');
export type AgentReadStage = 'producer' | 'send' | 'blob' | 'decode' | 'rebuild';
export interface AgentReadTrace {
    readonly agentId: string;
    readonly events: { stage: AgentReadStage; ms: number }[];
}
export function measureAgentRead<T>(_agentId: string, _stage: AgentReadStage, operation: () => T): T {
    return operation();
}
export async function measureAgentReadAsync<T>(_agentId: string, _stage: AgentReadStage, operation: () => Promise<T>): Promise<T> {
    return operation();
}

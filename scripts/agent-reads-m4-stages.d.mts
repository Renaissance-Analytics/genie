import type { M4StageDurations, OrdinaryM4Open } from './agent-reads-m4-block.mjs';
export interface StagePort { evaluate(expression: string, timeoutMs: number): Promise<unknown> }
export function measureM4Stages(ports: {
    readonly agentId: string; readonly mode: 'ipc' | 'door' | 'door-revision';
    readonly inspector: StagePort; readonly cdp: StagePort;
    readonly openExtra: () => Promise<OrdinaryM4Open>;
}): Promise<M4StageDurations>;

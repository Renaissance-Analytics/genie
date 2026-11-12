import type { Registration } from './mcp-tools.js';

/** RED stand-in (Tynn #702). */
export const INTERRUPTED_WORDS = { interrupt: '', stop: '' } as const;

/** RED stand-in (Tynn #702). */
export class AgentToolCalls {
    end(_agentId: string, _intent: 'stop' | 'interrupt'): number {
        return 0;
    }
    running(_agentId: string): number {
        return 0;
    }
}

/** RED stand-in (Tynn #702). */
export function withInterruptibleCalls(registrations: readonly Registration[], _resolve: (session: string) => { readonly agentId: string } | null, _calls: AgentToolCalls): Registration[] {
    return [...registrations];
}

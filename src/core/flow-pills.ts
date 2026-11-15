/**
 * RUNNING FLOWS AS PILLS IN THE HEADER (Tynn #707). The host says which flows are running and which just ended failed or
 * held (core/deck.ts SignalState); this decides what the header draws: a pill per running flow, a failed or held end for
 * a few seconds, and the rest behind "+N". A window scoped to one workspace sees only that workspace's flows.
 */
export interface LiveFlow {
    readonly flowId: string;
    readonly name: string;
    readonly workspaceId: string;
    /** When the run started (ISO). */
    readonly at: string;
}

export interface EndedFlow {
    readonly flowId: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly outcome: 'failed' | 'held';
    /** When the run ended (ISO). */
    readonly endedAt: string;
}

export interface FlowPill {
    readonly flowId: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly state: 'running' | 'failed' | 'held';
}

/** How long a failed or held end stays in the header. */
export const PILL_LINGER_MS = 6000;
/** Pills drawn before the rest collapse to "+N". */
export const PILLS_SHOWN = 2;

export function flowPills(input: { live: readonly LiveFlow[]; ended: readonly EndedFlow[]; now: number; workspaceId: string | null }): { shown: FlowPill[]; more: FlowPill[] } {
    const mine = (w: { workspaceId: string }): boolean => input.workspaceId === null || w.workspaceId === input.workspaceId;
    const running = input.live.filter(mine).map((f): FlowPill => ({ flowId: f.flowId, name: f.name, workspaceId: f.workspaceId, state: 'running' }));
    const runningIds = new Set(running.map((p) => p.flowId));
    const recent = input.ended
        .filter((e) => mine(e) && !runningIds.has(e.flowId) && input.now - Date.parse(e.endedAt) <= PILL_LINGER_MS)
        .map((e): FlowPill => ({ flowId: e.flowId, name: e.name, workspaceId: e.workspaceId, state: e.outcome }));
    const all = [...running, ...recent];
    return { shown: all.slice(0, PILLS_SHOWN), more: all.slice(PILLS_SHOWN) };
}

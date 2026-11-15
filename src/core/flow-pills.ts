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
    /** The run is PAUSED at its agent's provider limit (Tynn #749): when it resumes (`null` = no time is stated). */
    readonly pause?: { readonly resumesAtMs: number | null; readonly agent: string } | undefined;
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
    /** What the pill says: the flow's own name, or "Unnamed flow" — never its id. */
    readonly name: string;
    readonly workspaceId: string;
    readonly state: 'running' | 'paused' | 'failed' | 'held';
    /** A `paused` pill: when its limit resumes (`null` = no time is stated). */
    readonly resumesAtMs?: number | null;
}

/**
 * WHAT A LIMIT-PAUSED RUN SAYS (Tynn #749): never Failed or Broken. `clock` formats a time of day (HH:MM) the way the
 * surface shows times.
 */
export function pausedWords(resumesAtMs: number | null | undefined, clock: (ms: number) => string): string {
    return resumesAtMs === null || resumesAtMs === undefined ? 'Paused · limit, resume time not stated' : `Paused · limit, resumes ${clock(resumesAtMs)}`;
}

/** The words for a flow with no name of its own, or one whose name is only its id. */
export const UNNAMED_FLOW = 'Unnamed flow';

function label(flowId: string, name: string): string {
    const n = name.trim();
    return n === '' || (flowId.length >= 8 && n.includes(flowId)) ? UNNAMED_FLOW : n;
}

/** How long a failed or held end stays in the header. */
export const PILL_LINGER_MS = 6000;
/** Pills drawn before the rest collapse to "+N". */
export const PILLS_SHOWN = 2;

export function flowPills(input: { live: readonly LiveFlow[]; ended: readonly EndedFlow[]; now: number; workspaceId?: string | null | undefined }): { shown: FlowPill[]; more: FlowPill[] } {
    const mine = (w: { workspaceId: string }): boolean => input.workspaceId == null || w.workspaceId === input.workspaceId;
    const running = input.live.filter(mine).map((f): FlowPill => ({ flowId: f.flowId, name: label(f.flowId, f.name), workspaceId: f.workspaceId, ...(f.pause ? { state: 'paused' as const, resumesAtMs: f.pause.resumesAtMs } : { state: 'running' as const }) }));
    const runningIds = new Set(running.map((p) => p.flowId));
    const recent = input.ended
        .filter((e) => mine(e) && !runningIds.has(e.flowId) && input.now - Date.parse(e.endedAt) <= PILL_LINGER_MS)
        .map((e): FlowPill => ({ flowId: e.flowId, name: label(e.flowId, e.name), workspaceId: e.workspaceId, state: e.outcome }));
    const all = [...running, ...recent];
    return { shown: all.slice(0, PILLS_SHOWN), more: all.slice(PILLS_SHOWN) };
}

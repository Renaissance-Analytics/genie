import type { EndedFlow, LiveFlow } from './flow-pills.js';

/** The slice of a flow the header's pills read (structurally main/flow-store.ts FlowRecord). */
export interface PillFlow {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly inFlight?: { readonly at: string; readonly pause?: { readonly resumesAtMs: number | null; readonly agent: string } | undefined } | undefined;
    readonly runs: readonly { readonly outcome: string; readonly endedAt: string }[];
}

/** How long after it ends a failed or held run is still reported; the window's own linger (core/flow-pills.ts) is shorter. */
const ENDED_REPORT_MS = 30_000;

/**
 * WHAT THE HOST REPORTS FOR THE HEADER'S FLOW PILLS (Tynn #707): the flows with a run in flight, and the ones whose latest
 * run just ended failed or held. The names are the person's own; no flow id is ever shown as text.
 */
export function flowPillSignals(flows: readonly PillFlow[], now: number): { flowsLive: LiveFlow[]; flowsEnded: EndedFlow[] } {
    const flowsLive = flows.filter((f) => f.inFlight).map((f): LiveFlow => ({ flowId: f.id, name: f.name, workspaceId: f.workspaceId, at: f.inFlight!.at, ...(f.inFlight!.pause ? { pause: { resumesAtMs: f.inFlight!.pause.resumesAtMs, agent: f.inFlight!.pause.agent } } : {}) }));
    const flowsEnded = flows.flatMap((f): EndedFlow[] => {
        const last = f.runs.at(-1);
        if (!last || (last.outcome !== 'failed' && last.outcome !== 'held')) return [];
        if (now - Date.parse(last.endedAt) > ENDED_REPORT_MS) return [];
        return [{ flowId: f.id, name: f.name, workspaceId: f.workspaceId, outcome: last.outcome, endedAt: last.endedAt }];
    });
    return { flowsLive, flowsEnded };
}

/**
 * WHAT GENIE-HOST RUNS, AS THIS MACHINE'S TRAY AND QUIT READ IT (Tynn #953, client/host split step 2g-2). The tray's
 * activity, its Restart/Shut-down list and the quit plan read synchronously, so main keeps ONE summary that genie-host
 * pushes when it changes (`summary.watch`, `local-summary`): the live terminals (by workspace, with the pid the tray marks
 * busy), the armed flows and the scheduled tasks, by name. It replaces main's terminals and process-book replicas.
 */
export interface HostSummary {
    readonly terminals: readonly { readonly workspaceId: string; readonly pid: number | null }[];
    readonly armedFlows: readonly string[];
    readonly scheduledTasks: readonly string[];
}

export const EMPTY_HOST_SUMMARY: HostSummary = { terminals: [], armedFlows: [], scheduledTasks: [] };

/** The summary of the host's own lists, by the same rule as core/tray-only.ts `onTheClock`. */
export function hostSummaryOf(
    terminals: ReadonlyArray<{ readonly workspaceId: string; readonly pid?: number | null | undefined }>,
    flows: ReadonlyArray<{ readonly name: string; readonly armed: boolean }>,
    kept: ReadonlyArray<{ readonly name: string; readonly wanted: boolean; readonly schedule?: unknown }>,
): HostSummary {
    return {
        terminals: terminals.map((t) => ({ workspaceId: t.workspaceId, pid: typeof t.pid === 'number' ? t.pid : null })),
        armedFlows: flows.filter((f) => f.armed).map((f) => f.name),
        scheduledTasks: kept.filter((p) => p.wanted && p.schedule).map((p) => p.name),
    };
}

const names = (raw: unknown): string[] | null => (Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? [...raw] : null);

/** A summary as it came over the wire; anything malformed is the empty one, never a throw. */
export function readHostSummary(raw: unknown): HostSummary {
    const r = raw as { terminals?: unknown; armedFlows?: unknown; scheduledTasks?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.terminals)) return EMPTY_HOST_SUMMARY;
    const armedFlows = names(r.armedFlows);
    const scheduledTasks = names(r.scheduledTasks);
    if (armedFlows === null || scheduledTasks === null) return EMPTY_HOST_SUMMARY;
    const terminals: { workspaceId: string; pid: number | null }[] = [];
    for (const t of r.terminals as unknown[]) {
        const v = t as { workspaceId?: unknown; pid?: unknown } | null;
        if (!v || typeof v.workspaceId !== 'string') return EMPTY_HOST_SUMMARY;
        terminals.push({ workspaceId: v.workspaceId, pid: typeof v.pid === 'number' ? v.pid : null });
    }
    return { terminals, armedFlows, scheduledTasks };
}

/** The summary as it is now, said to its listeners only when it changed. */
export function hostSummaryFeed(ports: { read(): HostSummary; onChange(listener: () => void): () => void }): { now(): HostSummary; subscribe(listener: (summary: HostSummary) => void): () => void } {
    const listeners = new Set<(summary: HostSummary) => void>();
    let last = ports.read();
    let key = JSON.stringify(last);
    ports.onChange(() => {
        const next = ports.read();
        const nextKey = JSON.stringify(next);
        if (nextKey === key) return;
        last = next;
        key = nextKey;
        for (const l of [...listeners]) l(next);
    });
    return {
        now: () => last,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}

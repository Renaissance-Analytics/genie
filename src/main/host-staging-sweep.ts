/**
 * GENIE-HOST SWEEPS OLD LOCAL STAGING (Tynn #955, client/host split step 2g-4d E). Staging areas are made in genie-host,
 * but the sweep of old ones ran only in the window's composition (compose.ts), so with main composing nothing it would
 * run nowhere. genie-host runs it once after boot, and stops it at shutdown.
 */
export interface StagingSweepPorts {
    /** LocalStagingArea.sweepOld: what is left by processes that are gone, under this home's runtime. */
    readonly sweep: (home: string, deps: { signal?: AbortSignal }) => Promise<void>;
    /** When to run it: after boot, not inline (default: the next turn of the loop, unref'd). Returns the cancel. */
    readonly schedule?: (work: () => Promise<void>) => () => void;
    readonly warn?: (line: string) => void;
}

/** Schedules the sweep once; the returned stop unschedules it and tells a sweep under way to stop. */
export function scheduleStagingSweep(home: string, ports: StagingSweepPorts): () => void {
    const stopping = new AbortController();
    let sweeping: Promise<void> | null = null;
    const warn = ports.warn ?? ((line: string) => { console.warn(line); });
    const work = (): Promise<void> => sweeping ??= ports.sweep(home, { signal: stopping.signal })
        .catch(() => { if (!stopping.signal.aborted) warn('[genie] old local staging could not be swept'); });
    const unschedule = ports.schedule ? ports.schedule(work) : (() => {
        const timer = setTimeout(() => { void work(); }, 0);
        timer.unref?.();
        return () => clearTimeout(timer);
    })();
    return () => { stopping.abort(); unschedule(); };
}

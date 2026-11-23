/**
 * GENIE-HOST SWEEPS OLD LOCAL STAGING (Tynn #955, client/host split step 2g-4d E). Staging areas are made in genie-host,
 * but the sweep of old ones ran only in the window's composition (compose.ts), so with main composing nothing it would
 * run nowhere. genie-host runs it once after boot, and stops it at shutdown.
 */
export interface StagingSweepPorts {
    readonly sweep: (home: string, deps: { signal?: AbortSignal }) => Promise<void>;
    readonly schedule?: (work: () => Promise<void>) => () => void;
    readonly warn?: (line: string) => void;
}

export function scheduleStagingSweep(_home: string, _ports: StagingSweepPorts): () => void {
    throw new Error('2g-4d E: not built yet');
}

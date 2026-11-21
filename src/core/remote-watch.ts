import type { HereConnection } from './connected-here.js';
import type { PairRequest } from './pair-confirm.js';

/**
 * WHO IS AT THIS MACHINE, AS MAIN'S OWN CLIENT WATCHES IT (Tynn #997, client/host split step 2g-4a): genie-host's host name,
 * the connections on it and the pair requests waiting, said on `remote.watch` / `local-remote` to main's own client only, so
 * its desktop notifications (a guest asking to come in, someone connecting) need no engine replica.
 */
export interface RemoteWatchView {
    readonly hostName: string;
    readonly connections: readonly HereConnection[];
    readonly pairRequests: readonly PairRequest[];
}

export const EMPTY_REMOTE_WATCH: RemoteWatchView = Object.freeze({ hostName: '', connections: [], pairRequests: [] });

/** What came over the wire, as a view; anything that does not read is nobody (fail closed). */
export function readRemoteWatch(_raw: unknown): RemoteWatchView { throw new Error('2g-4a: not built yet'); }

/** The view as it is now, said to its listeners only when it changed. */
export function remoteWatchFeed(_ports: { read(): RemoteWatchView; onChange(listener: () => void): () => void }): { now(): RemoteWatchView; subscribe(listener: (view: RemoteWatchView) => void): () => void } {
    throw new Error('2g-4a: not built yet');
}

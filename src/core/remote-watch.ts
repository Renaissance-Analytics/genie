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

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function connectionOf(raw: unknown): HereConnection | null {
    if (!rec(raw) || !str(raw.id) || !str(raw.label) || typeof raw.driving !== 'boolean') return null;
    return { id: raw.id, label: raw.label, driving: raw.driving, ...(raw.mode === 'view' || raw.mode === 'control' ? { mode: raw.mode } : {}) };
}

function requestOf(raw: unknown): PairRequest | null {
    if (!rec(raw) || !str(raw.id) || !str(raw.label) || !str(raw.from) || !str(raw.host) || !num(raw.raisedAt) || !num(raw.expiresAt)) return null;
    const replaces = rec(raw.replaces) && str(raw.replaces.id) && str(raw.replaces.label) ? { id: raw.replaces.id, label: raw.replaces.label } : null;
    const guest = rec(raw.guest) && (raw.guest.workspace === null || str(raw.guest.workspace)) && typeof raw.guest.readonly === 'boolean'
        ? { workspace: raw.guest.workspace as string | null, readonly: raw.guest.readonly } : undefined;
    return { id: raw.id, label: raw.label, from: raw.from, host: raw.host, replaces, raisedAt: raw.raisedAt, expiresAt: raw.expiresAt, ...(guest ? { guest } : {}) };
}

/** What came over the wire, as a view; anything that does not read is nobody (fail closed), and a row that does not read is dropped. */
export function readRemoteWatch(raw: unknown): RemoteWatchView {
    if (!rec(raw) || !str(raw.hostName) || !Array.isArray(raw.connections) || !Array.isArray(raw.pairRequests)) return EMPTY_REMOTE_WATCH;
    return {
        hostName: raw.hostName,
        connections: raw.connections.map(connectionOf).filter((c): c is HereConnection => c !== null),
        pairRequests: raw.pairRequests.map(requestOf).filter((r): r is PairRequest => r !== null),
    };
}

/** genie-host's remote-access status, as the watch says it: who is here and who asks, and nothing of its pin or devices. */
export function remoteWatchOf(status: { readonly host: string; readonly connections: readonly { readonly id: string; readonly label: string; readonly driving: boolean; readonly mode?: 'view' | 'control' }[]; readonly pairRequests: readonly PairRequest[] }): RemoteWatchView {
    return {
        hostName: status.host,
        connections: status.connections.map((c) => ({ id: c.id, label: c.label, driving: c.driving, ...(c.mode ? { mode: c.mode } : {}) })),
        pairRequests: [...status.pairRequests],
    };
}

/** The view as it is now, said to its listeners only when it changed. */
export function remoteWatchFeed(ports: { read(): RemoteWatchView; onChange(listener: () => void): () => void }): { now(): RemoteWatchView; subscribe(listener: (view: RemoteWatchView) => void): () => void } {
    const listeners = new Set<(view: RemoteWatchView) => void>();
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

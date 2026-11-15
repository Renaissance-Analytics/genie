import { useCallback, useSyncExternalStore } from 'react';

/**
 * THE DASHBOARD'S STATUS FILTER, ONE SOURCE OF TRUTH (Tynn #733): which of the Sleeping and Stopped agents are shown.
 * The Dashboard and the sidebar's agent list both read and write it here — a change in one is in the other at once, in
 * this window by the listeners below and in another window by the `storage` event, and it is remembered across a restart
 * under the key the Dashboard has always used.
 */
export type ShowKind = 'sleeping' | 'stopped';
export interface DashboardFilter { readonly sleeping: boolean; readonly stopped: boolean }

const keyOf = (kind: ShowKind): string => `genie.dashboard.show.${kind}`;
const listeners = new Set<() => void>();

function read(kind: ShowKind): boolean {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(keyOf(kind)) === '1'; }
    catch { return false; }
}

/** The two flags as one string, so `useSyncExternalStore` compares a stable value. */
const snapshot = (): string => `${read('sleeping') ? 1 : 0}${read('stopped') ? 1 : 0}`;
const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent): void => { if (event.key === null || event.key === keyOf('sleeping') || event.key === keyOf('stopped')) listener(); };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => { listeners.delete(listener); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
};

export function setDashboardFilter(kind: ShowKind, shown: boolean): void {
    try { window.localStorage.setItem(keyOf(kind), shown ? '1' : '0'); } catch { /* Applies in this window even when storage is unavailable. */ }
    for (const listener of [...listeners]) listener();
}

export function useDashboardFilter(): { filter: DashboardFilter; toggle: (kind: ShowKind) => void } {
    const state = useSyncExternalStore(subscribe, snapshot, () => '00');
    const filter: DashboardFilter = { sleeping: state[0] === '1', stopped: state[1] === '1' };
    const toggle = useCallback((kind: ShowKind) => setDashboardFilter(kind, !read(kind)), []);
    return { filter, toggle };
}

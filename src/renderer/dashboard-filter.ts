import { useCallback, useSyncExternalStore } from 'react';

/**
 * THE DASHBOARD'S STATUS FILTER, ONE SOURCE OF TRUTH (Tynn #733): which of the Sleeping and Stopped agents are shown.
 * The Dashboard and the sidebar's agent list both read and write it here — a change in one is in the other at once, in
 * this window by the listeners below and in another window by the `storage` event, and it is remembered across a restart
 * under the key the Dashboard has always used.
 *
 * NEEDS YOU (Tynn #730): the third filter, beside them — only the agents with something waiting on the person (the Deck's
 * items, attached to the agent rows). It lives in the same store: the same listeners, the same `storage` event, the same
 * remembered-across-a-restart. It is NOT part of `DashboardFilter` (the sidebar's agent list follows Sleeping / Stopped only).
 */
export type ShowKind = 'sleeping' | 'stopped';
export interface DashboardFilter { readonly sleeping: boolean; readonly stopped: boolean }

type FlagKind = ShowKind | 'needsYou';
const keyOf = (kind: FlagKind): string => (kind === 'needsYou' ? 'genie.dashboard.needsYou' : `genie.dashboard.show.${kind}`);
const KINDS: readonly FlagKind[] = ['sleeping', 'stopped', 'needsYou'];
const listeners = new Set<() => void>();

function read(kind: FlagKind): boolean {
    try { return typeof window !== 'undefined' && window.localStorage.getItem(keyOf(kind)) === '1'; }
    catch { return false; }
}

/** The flags as one string, so `useSyncExternalStore` compares a stable value. */
const snapshot = (): string => KINDS.map((kind) => (read(kind) ? 1 : 0)).join('');
const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const onStorage = (event: StorageEvent): void => { if (event.key === null || KINDS.some((kind) => event.key === keyOf(kind))) listener(); };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => { listeners.delete(listener); if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
};

export function setDashboardFilter(kind: FlagKind, shown: boolean): void {
    try { window.localStorage.setItem(keyOf(kind), shown ? '1' : '0'); } catch { /* Applies in this window even when storage is unavailable. */ }
    for (const listener of [...listeners]) listener();
}

export function useDashboardFilter(): { filter: DashboardFilter; toggle: (kind: ShowKind) => void } {
    const state = useSyncExternalStore(subscribe, snapshot, () => '000');
    const filter: DashboardFilter = { sleeping: state[0] === '1', stopped: state[1] === '1' };
    const toggle = useCallback((kind: ShowKind) => setDashboardFilter(kind, !read(kind)), []);
    return { filter, toggle };
}

/** The "Needs you" filter: on = only the agents with something waiting. Shared by the Dashboard and the command palette. */
export function useNeedsYouFilter(): { on: boolean; toggle: () => void } {
    const state = useSyncExternalStore(subscribe, snapshot, () => '000');
    const toggle = useCallback(() => setDashboardFilter('needsYou', !read('needsYou')), []);
    return { on: state[2] === '1', toggle };
}

/**
 * FOLLOWING THE TYNN TAB, BY SUBSCRIPTION (host split P4 family 12, Tynn #561). A tab that shows a workspace's board, its
 * issues or its Features page follows it live: the window asks to watch (`tynn.watch`, its kind and workspace), the
 * host's watch port opens one view for it, and the signals for that kind and workspace come back on the local event
 * `local-tynn` — to the connection that watches it and no other. `tynn.unwatch`, or the connection closing, releases it.
 * Local windows only: the live tab is this machine's window's.
 */
export const TYNN_WATCH_METHODS = ['tynn.watch', 'tynn.unwatch'] as const;
export type TynnWatchMethod = (typeof TYNN_WATCH_METHODS)[number];

export type TynnWatchKind = 'board' | 'issues' | 'features';
export const TYNN_WATCH_KINDS: readonly TynnWatchKind[] = ['board', 'issues', 'features'];

export interface TynnWatchEvent {
    readonly kind: TynnWatchKind;
    readonly workspaceId: string;
    readonly signal: unknown;
}

/** The host's side: one view per watch, its signals for every view, by kind and workspace. */
export interface TynnWatchPort {
    watch(kind: TynnWatchKind, viewId: string, workspaceId: string): Promise<boolean>;
    unwatch(kind: TynnWatchKind, viewId: string): void;
    subscribe(listener: (event: TynnWatchEvent) => void): () => void;
}

export const isTynnWatchKind = (v: unknown): v is TynnWatchKind => typeof v === 'string' && (TYNN_WATCH_KINDS as readonly string[]).includes(v);

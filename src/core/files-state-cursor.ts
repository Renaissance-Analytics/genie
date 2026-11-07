import type { Activity, ChangedGroup, FileAttribution } from './files-panel.js';

/**
 * FILES STATE BY CURSOR (Tynn #522, UI lag L2). A view reads `files.state` once per batch of disk changes, and the answer
 * held every path changed this session: during a build, about 66 metadata pages per read on window main, growing with the
 * session (genie#1677's row). Now the caller passes the cursor of its last read and the host sends only what changed
 * since: the disk changes recorded after it, and the paths that left the disk list (the person wrote them). The window's
 * client keeps the rest here and answers each view with the whole state, as a full read would.
 *
 * What is NOT sent by cursor: the agents' attribution, their activity and the Changed groups other than `?` — they come
 * from the agents' own events, not from the disk list. The `?` group and the unreported list are rebuilt here from the
 * kept disk list, so they are never resent whole.
 */
export interface FilesStateSince {
    /** Give this back on the next read. */
    readonly cursor: string;
    /** The cursor this answer is relative to; `null` = the whole disk list (a first read, or a cursor this host did not give). */
    readonly since: string | null;
    readonly files: readonly FileAttribution[];
    readonly activity: readonly Activity[];
    /** The Changed groups WITHOUT `?`: that one is the unreported list, rebuilt by the reader. */
    readonly changed: readonly ChangedGroup[] | null;
    /** Disk changes recorded since `since`, in the order Genie first saw each path (a path seen before keeps its place). */
    readonly disk: readonly { readonly path: string; readonly at: number }[];
    /** Paths that left the disk list since `since` (the person wrote them: theirs, not a change on disk). */
    readonly gone: readonly string[];
}

/** The state a full read answers with (main/files-host.ts `FilesState`). */
export interface FilesStateWhole {
    readonly files: readonly FileAttribution[];
    readonly activity: readonly Activity[];
    readonly unreported: readonly string[];
    readonly changed: readonly ChangedGroup[] | null;
    readonly diskChanges: readonly { path: string; at: number }[];
}

export interface FilesStateKept {
    readonly epoch: string;
    readonly seq: number;
    readonly cursor: string;
    /** Path → when Genie saw it, in the order it was first seen. */
    readonly disk: Map<string, number>;
    readonly latest: FilesStateSince;
}

/** `<epoch>.<seq>`: the host instance that gave it, and how far it had counted. */
export function cursorParts(cursor: unknown): { epoch: string; seq: number } | null {
    if (typeof cursor !== 'string') return null;
    const m = /^([A-Za-z0-9]{1,32})\.(\d{1,15})$/.exec(cursor);
    return m ? { epoch: m[1]!, seq: Number(m[2]) } : null;
}

export const makeCursor = (epoch: string, seq: number): string => `${epoch}.${seq}`;

/** Is `reply` a cursor answer (a host that knows cursors), rather than a full state (one that does not)? */
export function isFilesStateSince(reply: unknown): reply is FilesStateSince {
    return typeof reply === 'object' && reply !== null && typeof (reply as { cursor?: unknown }).cursor === 'string' && Array.isArray((reply as { disk?: unknown }).disk);
}

/**
 * The kept state after `reply`. An answer older than what is kept (two reads in flight, the later one answered first)
 * changes nothing; a whole answer starts over; an answer since a cursor is laid over what is kept.
 */
export function applyFilesState(kept: FilesStateKept | undefined, reply: FilesStateSince): FilesStateKept {
    const parts = cursorParts(reply.cursor);
    if (!parts) throw new Error('the Files state answer has no valid cursor');
    if (kept && kept.epoch === parts.epoch && parts.seq < kept.seq) return kept;
    const disk = reply.since === null || !kept || kept.epoch !== parts.epoch ? new Map<string, number>() : kept.disk;
    for (const path of reply.gone) disk.delete(path);
    for (const { path, at } of reply.disk) disk.set(path, at);
    return { epoch: parts.epoch, seq: parts.seq, cursor: reply.cursor, disk, latest: reply };
}

/** The whole state, as a full read answers it: the unreported list and its `?` group rebuilt from the kept disk list. */
export function projectFilesState(kept: FilesStateKept): FilesStateWhole {
    const { files, activity, changed } = kept.latest;
    const attributed = new Set(files.map((f) => f.path));
    const mine = new Set(changed?.find((g) => g.who === 'you')?.files ?? []);
    const unreported = [...kept.disk.keys()].filter((p) => p !== '' && !mine.has(p) && !attributed.has(p));
    const groups = [...(changed ?? []).filter((g) => g.who !== '?'), ...(unreported.length > 0 ? [{ who: '?', files: [...unreported].sort((a, b) => a.localeCompare(b, 'en')) }] : [])];
    return {
        files,
        activity,
        unreported,
        changed: groups.length === 0 ? null : groups,
        diskChanges: [...kept.disk].map(([path, at]) => ({ path, at })).sort((a, b) => b.at - a.at),
    };
}

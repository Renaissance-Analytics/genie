/**
 * GENIE-HOST'S REGISTRY, AS MAIN'S OWN CLIENT READS AND WRITES IT (Tynn #1007, client/host split step 2g-4e). The registry's
 * files are genie-host's (P3.2). main's window registry reads them with `registry.read` and re-reads them when
 * `registry.watch` says they were written (`local-registry`). Both are controls only main's own client may say. It writes
 * them with `registry.write`, a local method only main's own client may call. What crosses is read strictly here: a
 * method the registry does not have is refused, and so is an argument of the wrong shape.
 */

type Refusal = { ok: false; reason: string };

/** What main reads of the registry: its files, and what the host's store dropped reading them. */
export const REGISTRY_READS = ['readWorkspaces', 'readAgents', 'readRunningAtQuit', 'readInterruptedAtQuit', 'dropped'] as const;
export type RegistryRead = (typeof REGISTRY_READS)[number];

/**
 * What main writes: the registry's lists ONE RECORD AT A TIME (Tynn #1007: a whole list from a stale window clobbered the
 * field genie-host had just written), the saved lists, and the restore's two steps (which write them).
 */
export const REGISTRY_WRITES = ['changeWorkspaces', 'changeAgents', 'writeRunningAtQuit', 'writeInterruptedAtQuit', 'beginRestore', 'restoreStarted'] as const;
export type RegistryWrite = (typeof REGISTRY_WRITES)[number];

const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const records = (v: unknown): boolean => Array.isArray(v) && v.every(rec);
const ids = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const refuse = (reason: string): Refusal => ({ ok: false, reason });
/** Field names a patch may not name: the record's id, and what reaches a prototype (store.ts UNPATCHABLE_FIELDS). */
const UNPATCHABLE = new Set(['id', '__proto__', 'constructor', 'prototype']);
const fieldName = (v: unknown): boolean => typeof v === 'string' && v !== '' && !UNPATCHABLE.has(v);
const patchOf = (v: unknown): boolean => {
    if (!rec(v) || typeof v.id !== 'string' || v.id === '') return false;
    if (Object.keys(v).some((k) => k !== 'id' && k !== 'set' && k !== 'unset')) return false;
    if (v.set !== undefined && (!rec(v.set) || !Object.keys(v.set).every(fieldName))) return false;
    if (v.unset !== undefined && (!Array.isArray(v.unset) || !v.unset.every(fieldName))) return false;
    return true;
};
/** A per-record change (store.ts RecordChange): records to add, patches by id, ids to remove; nothing else. */
const recordChange = (v: unknown): boolean => {
    if (!rec(v) || Object.keys(v).some((k) => k !== 'add' && k !== 'patch' && k !== 'remove')) return false;
    if (v.add !== undefined && !(records(v.add) && (v.add as Record<string, unknown>[]).every((r) => typeof r.id === 'string' && r.id !== ''))) return false;
    if (v.patch !== undefined && !(Array.isArray(v.patch) && v.patch.every(patchOf))) return false;
    if (v.remove !== undefined && !ids(v.remove)) return false;
    return true;
};

/** `registry.read`'s arguments: one read, alone. */
export function readRegistryRead(args: unknown[]): RegistryRead | Refusal {
    if (args.length !== 1 || typeof args[0] !== 'string' || !(REGISTRY_READS as readonly string[]).includes(args[0])) return refuse('that is not a read of the registry');
    return args[0] as RegistryRead;
}

/** Each write's own arguments. */
const WRITE_ARGS: Readonly<Record<RegistryWrite, (args: unknown[]) => boolean>> = {
    changeWorkspaces: (a) => a.length === 1 && recordChange(a[0]),
    changeAgents: (a) => a.length === 1 && recordChange(a[0]),
    writeRunningAtQuit: (a) => a.length === 1 && ids(a[0]),
    writeInterruptedAtQuit: (a) => a.length === 1 && ids(a[0]),
    beginRestore: (a) => a.length === 0,
    restoreStarted: (a) => a.length === 1 && typeof a[0] === 'string',
};

/** `registry.write`'s arguments: `[method, args]`, the method one of the registry's writes, its args as that write takes. */
export function readRegistryWrite(args: unknown[]): { method: RegistryWrite; args: unknown[] } | Refusal {
    const [method, rest] = args;
    if (args.length !== 2 || typeof method !== 'string' || !(REGISTRY_WRITES as readonly string[]).includes(method) || !Array.isArray(rest)) return refuse('that is not a write of the registry');
    if (!WRITE_ARGS[method as RegistryWrite](rest)) return refuse(`the registry's ${method} was not given what it takes`);
    return { method: method as RegistryWrite, args: rest };
}

/** What `registry.watch` answers and `local-registry` says: how many writes so far, and what the host's store dropped. */
export interface RegistryWatchView {
    readonly revision: number;
    readonly dropped: readonly string[];
}

export const EMPTY_REGISTRY_WATCH: RegistryWatchView = Object.freeze({ revision: 0, dropped: Object.freeze([]) as readonly string[] });

export function readRegistryWatch(raw: unknown): RegistryWatchView {
    if (!rec(raw) || typeof raw.revision !== 'number' || !Number.isFinite(raw.revision) || !ids(raw.dropped)) return EMPTY_REGISTRY_WATCH;
    return { revision: raw.revision, dropped: [...(raw.dropped as string[])] };
}

/** genie-host's registry files: its store's calls (agent-stores-host.ts `registry`), and what the store dropped reading them. */
export interface RegistryFiles {
    call(method: string, args: unknown[]): Promise<unknown>;
    dropped(): readonly string[];
}

export interface RegistryFeed {
    now(): RegistryWatchView;
    subscribe(listener: (view: RegistryWatchView) => void): () => void;
}

/** `registry.write` as genie-host answers it, on either path: main's own client only, the write read strictly. */
export async function answerRegistryWrite(files: RegistryFiles | undefined, args: unknown[], context: { readonly own?: true } | undefined): Promise<unknown> {
    if (!files) return refuse('this host keeps no registry');
    if (context?.own !== true) return refuse('the registry is written by Genie itself, never by a window');
    const write = readRegistryWrite(args);
    if ('ok' in write) return write;
    return files.call(write.method, write.args);
}

/**
 * WHAT GENIE-HOST ANSWERS OF ITS REGISTRY, FROM THE START (Tynn #1007; gate 1123-021408-46f518). main's registry loads
 * early in its boot, before genie-host has built its own answers (host-alone-api.ts), so these are hostRemoteApi's own
 * ports: `registry.write` among its own methods, `registry.read` and `registry.watch` as its registry port. The same
 * store calls the engine link carried, which were there from genie-host's start too.
 */
export function hostRegistryAnswers(files: RegistryFiles, feed: RegistryFeed): {
    readonly files: RegistryFiles;
    readonly own: { readonly 'registry.write': (args: unknown[], context?: { readonly own?: true }) => Promise<unknown> };
    readonly registry: { read(method: RegistryRead): Promise<unknown>; readonly watch: RegistryFeed };
} {
    return {
        files,
        own: { 'registry.write': (args, context) => answerRegistryWrite(files, args, context) },
        registry: { read: async (method) => (method === 'dropped' ? [...files.dropped()] : files.call(method, [])), watch: feed },
    };
}

/** genie-host's registry as a feed: revision 0 now, then a new revision each time its files are written. */
export function registryWatchFeed(ports: { dropped(): readonly string[]; onWritten(listener: () => void): () => void }): { now(): RegistryWatchView; subscribe(listener: (view: RegistryWatchView) => void): () => void } {
    const listeners = new Set<(view: RegistryWatchView) => void>();
    let revision = 0;
    ports.onWritten(() => {
        revision += 1;
        const view: RegistryWatchView = { revision, dropped: [...ports.dropped()] };
        for (const l of [...listeners]) l(view);
    });
    return {
        now: () => ({ revision, dropped: [...ports.dropped()] }),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}

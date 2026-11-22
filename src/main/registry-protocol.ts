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

/** What main writes: the files, and the restore's two steps (which write the saved lists). */
export const REGISTRY_WRITES = ['writeWorkspaces', 'writeAgents', 'writeRunningAtQuit', 'writeInterruptedAtQuit', 'beginRestore', 'restoreStarted'] as const;
export type RegistryWrite = (typeof REGISTRY_WRITES)[number];

const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const records = (v: unknown): boolean => Array.isArray(v) && v.every(rec);
const ids = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const refuse = (reason: string): Refusal => ({ ok: false, reason });

/** `registry.read`'s arguments: one read, alone. */
export function readRegistryRead(args: unknown[]): RegistryRead | Refusal {
    if (args.length !== 1 || typeof args[0] !== 'string' || !(REGISTRY_READS as readonly string[]).includes(args[0])) return refuse('that is not a read of the registry');
    return args[0] as RegistryRead;
}

/** Each write's own arguments. */
const WRITE_ARGS: Readonly<Record<RegistryWrite, (args: unknown[]) => boolean>> = {
    writeWorkspaces: (a) => a.length === 1 && records(a[0]),
    writeAgents: (a) => a.length === 1 && records(a[0]),
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

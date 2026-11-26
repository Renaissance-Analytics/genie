import type { WorkstationRole } from './workstation-role.js';

/**
 * WHAT GENIE-HOST RUNS, AS THIS MACHINE'S TRAY AND QUIT READ IT (Tynn #953, client/host split step 2g-2). The tray's
 * activity, its Restart/Shut-down list and the quit plan read synchronously, so main keeps ONE summary that genie-host
 * pushes when it changes (`summary.watch`, `local-summary`): the live terminals (by workspace, with the pid the tray marks
 * busy), the armed flows and the scheduled tasks, by name. It replaces main's terminals and process-book replicas.
 * Since Tynn #1045 (2g-4d-C) it says the processes, the services and the sites too, so the tray and the quit read none of
 * the window's supervisor and hosting replicas.
 */
export interface HostSummary {
    readonly terminals: readonly { readonly workspaceId: string; readonly pid: number | null }[];
    readonly armedFlows: readonly string[];
    readonly scheduledTasks: readonly string[];
    /** The processes genie-host's supervisor runs now (running or restarting), by name: the tray's count, the quit's kept processes. */
    readonly processes: readonly string[];
    /** The active service engines, as the Restart/Shut-down list names them (`postgres 17`). */
    readonly services: readonly string[];
    /** The hosts genie-host's front door routes: the sites that list names. */
    readonly sites: readonly string[];
    /**
     * This machine's Pilot/Drone role as genie-host read it from Tynn (Tynn #954, 2g-3a): what main's dial refusals and its
     * WebSocket gate read. `null` = not on the Tynn network (signed out). Not heard yet = `drone` (fail closed).
     */
    readonly workstationRole: WorkstationRole | null;
    /** The Tynn account genie-host is signed in to (remote-window-policy.ts accountKeyOf); `null` = signed out. */
    readonly tynnAccountKey: string | null;
    /**
     * genie-host's keychain answers and can keep secrets (Tynn #959, 2g-3b): when this turns true, main's one-time unsealer
     * (legacy-unsealer.ts) hands over what an older Genie sealed. Not heard yet = `false` (fail closed).
     */
    readonly keychainReady: boolean;
    /** GitHub blocks features, as genie-host's GitHub account read GitHub (github-account.ts `signal`): the Deck's strip. */
    readonly githubBlocked: boolean;
}

export const EMPTY_HOST_SUMMARY: HostSummary = { terminals: [], armedFlows: [], scheduledTasks: [], processes: [], services: [], sites: [], workstationRole: 'drone', tynnAccountKey: null, keychainReady: false, githubBlocked: false };

/** What the host's accounts and keychain say, beside its lists. Absent members read fail closed. */
export interface HostSummaryAccount {
    readonly workstationRole: WorkstationRole | null;
    readonly tynnAccountKey: string | null;
    readonly keychainReady?: boolean;
    readonly githubBlocked?: boolean;
}

/** What the host's supervisor and hosting run, as their own lists say it. */
export interface HostSummaryRuns {
    readonly processes: ReadonlyArray<{ readonly name: string; readonly state: string }>;
    readonly services: ReadonlyArray<{ readonly engine: string; readonly version: string; readonly active: boolean }>;
    readonly routes: ReadonlyArray<{ readonly host: string }>;
}

/** The summary of the host's own lists, by the same rule as core/tray-only.ts `onTheClock`. */
export function hostSummaryOf(
    terminals: ReadonlyArray<{ readonly workspaceId: string; readonly pid?: number | null | undefined }>,
    flows: ReadonlyArray<{ readonly name: string; readonly armed: boolean }>,
    kept: ReadonlyArray<{ readonly name: string; readonly wanted: boolean; readonly schedule?: unknown }>,
    account: HostSummaryAccount = { workstationRole: 'drone', tynnAccountKey: null },
    runs: HostSummaryRuns = { processes: [], services: [], routes: [] },
): HostSummary {
    return {
        terminals: terminals.map((t) => ({ workspaceId: t.workspaceId, pid: typeof t.pid === 'number' ? t.pid : null })),
        armedFlows: flows.filter((f) => f.armed).map((f) => f.name),
        scheduledTasks: kept.filter((p) => p.wanted && p.schedule).map((p) => p.name),
        processes: runs.processes.filter((p) => p.state === 'running' || p.state === 'restarting').map((p) => p.name),
        services: runs.services.filter((e) => e.active).map((e) => `${e.engine} ${e.version}`),
        sites: runs.routes.map((r) => r.host),
        workstationRole: account.workstationRole,
        tynnAccountKey: account.tynnAccountKey,
        keychainReady: account.keychainReady === true,
        githubBlocked: account.githubBlocked === true,
    };
}

/** A role as it came over the wire: one Tynn says, `null` for none; anything else is a drone (fail closed). */
const roleOf = (raw: unknown): WorkstationRole | null => (raw === null ? null : raw === 'pilot' || raw === 'drone' ? raw : 'drone');

const names = (raw: unknown): string[] | null => (Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? [...raw] : null);

/** A summary as it came over the wire; anything malformed is the empty one, never a throw. */
export function readHostSummary(raw: unknown): HostSummary {
    const r = raw as { terminals?: unknown; armedFlows?: unknown; scheduledTasks?: unknown; processes?: unknown; services?: unknown; sites?: unknown; workstationRole?: unknown; tynnAccountKey?: unknown; keychainReady?: unknown; githubBlocked?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.terminals)) return EMPTY_HOST_SUMMARY;
    const armedFlows = names(r.armedFlows);
    const scheduledTasks = names(r.scheduledTasks);
    if (armedFlows === null || scheduledTasks === null) return EMPTY_HOST_SUMMARY;
    // The three lists of Tynn #1045: each a list of names, or the whole summary does not read (fail closed).
    const processes = names(r.processes);
    const services = names(r.services);
    const sites = names(r.sites);
    if (processes === null || services === null || sites === null) return EMPTY_HOST_SUMMARY;
    const terminals: { workspaceId: string; pid: number | null }[] = [];
    for (const t of r.terminals as unknown[]) {
        const v = t as { workspaceId?: unknown; pid?: unknown } | null;
        if (!v || typeof v.workspaceId !== 'string') return EMPTY_HOST_SUMMARY;
        terminals.push({ workspaceId: v.workspaceId, pid: typeof v.pid === 'number' ? v.pid : null });
    }
    return {
        terminals, armedFlows, scheduledTasks, processes, services, sites, workstationRole: roleOf(r.workstationRole), tynnAccountKey: typeof r.tynnAccountKey === 'string' ? r.tynnAccountKey : null,
        // Only a literal `true` is ready: anything else (absent, an older host) is not (fail closed).
        keychainReady: r.keychainReady === true,
        githubBlocked: r.githubBlocked === true,
    };
}

/** The keychain became able to keep secrets between two summaries: what runs main's unsealer again (Tynn #959). */
export function keychainBecameReady(before: HostSummary, after: HostSummary): boolean {
    return after.keychainReady && !before.keychainReady;
}

/** The summary as it is now, said to its listeners only when it changed. */
export function hostSummaryFeed(ports: { read(): HostSummary; onChange(listener: () => void): () => void }): { now(): HostSummary; subscribe(listener: (summary: HostSummary) => void): () => void } {
    const listeners = new Set<(summary: HostSummary) => void>();
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

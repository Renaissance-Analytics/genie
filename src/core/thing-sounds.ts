import type { AlertKind } from './alerts.js';

/**
 * A SOUND FOR WHAT AGENTS RUN (Tynn #766 row C2b). Genie's processes, sites, services and flows report what they ARE;
 * this turns the changes a person would want to hear into alert kinds. It remembers only the last state it saw of each
 * thing, so a state reported twice is not a second change, and the first sight of a thing is a baseline: nobody hears a
 * site come up because Genie restarted (Genie 1's rule).
 */
export type ThingKind = Extract<AlertKind, 'exits' | 'siteup' | 'sitedown' | 'serviceup' | 'flowdone'>;

const ENDED = new Set(['exited', 'failed']);

export class ThingSounds {
    readonly #processes = new Map<string, string>();
    #sites: Map<string, string> | null = null;

    /**
     * A process's new state: `exits` when one that was running exited or failed. A stop you asked for is not an exit,
     * and a site's own server (`ownedBySite`) is the site's row, not this one.
     */
    process(status: { readonly id: string; readonly state: string }, ownedBySite: boolean): ThingKind | null {
        const before = this.#processes.get(status.id);
        this.#processes.set(status.id, status.state);
        return !ownedBySite && before === 'running' && ENDED.has(status.state) ? 'exits' : null;
    }

    /**
     * The sites as they are now: `sitedown` for each running one that exited or failed, `siteup` for each that is running
     * AGAIN after going down. Only a recovery is "up": Genie starts every site at boot, and a site you start is the start
     * you asked for — neither is news. The first list is the baseline; a site first seen after it is new, and its first
     * state is its baseline too.
     */
    sites(list: readonly { readonly id: string; readonly state: string }[]): ThingKind[] {
        return this.sitesWithIds(list).map((h) => h.kind);
    }

    /** {@link sites}, each with the site it was. */
    sitesWithIds(list: readonly { readonly id: string; readonly state: string }[]): Array<{ kind: ThingKind; id: string }> {
        const before = this.#sites;
        this.#sites = new Map(list.map((s) => [s.id, s.state]));
        if (before === null) return [];
        const heard: Array<{ kind: ThingKind; id: string }> = [];
        for (const s of list) {
            const was = before.get(s.id);
            if (was === undefined || was === s.state) continue;
            if (s.state === 'running' && ENDED.has(was)) heard.push({ kind: 'siteup', id: s.id });
            else if (was === 'running' && ENDED.has(s.state)) heard.push({ kind: 'sitedown', id: s.id });
        }
        return heard;
    }
}

/** A flow's run as it ended: it ran or it failed — it finished. A run held back never ran. */
export function flowRunSound(run: { readonly outcome: 'ran' | 'failed' | 'held' | 'stopped' }): ThingKind | null {
    // A run stopped by a quit is recorded at the next launch (genie#1204): nothing just finished, so nothing sounds.
    return run.outcome === 'held' || run.outcome === 'stopped' ? null : 'flowdone';
}

/**
 * THE SOUNDS, AS GENIE-HOST SAYS THEM (Tynn #1045, 2g-4d-C). genie-host runs the processes, the sites, the services and the
 * flows, so it hears their changes and says each sound to every window: an agentless `genie:action`, sent as a `thing` tool
 * signal the way the mail sounds are (core/mail-actions.ts). main only checks what it was sent and passes it on.
 */
export interface ThingActionSignal {
    readonly agentId: null;
    readonly kind: ThingKind;
    /** The workspace it happened in (Tynn #1057: its sidebar row shows it); absent = none known (a shared service). */
    readonly workspaceId?: string;
}

/** What genie-host hears the changes from. A host whose hosting could not start has no sites and no engines. */
export interface ThingSources {
    readonly supervisor: { onChange(listener: (status: { readonly id: string; readonly state: string; readonly workspaceId?: string }) => void): unknown };
    readonly sites: { list(): readonly { readonly id: string; readonly state: string; readonly processIds: readonly string[]; readonly workspaceId?: string }[]; onChange(listener: () => void): unknown } | null;
    readonly engines: { onStarted(listener: (id: string) => void): unknown } | null;
    readonly flows: {
        onRun(listener: (flowId: string, run: { readonly outcome: 'ran' | 'failed' | 'held' | 'stopped' }) => void): unknown;
        /** The flow's workspace; absent or `null` = not known. */
        workspaceOf?(flowId: string): string | null;
    };
}

/** Each change a person would want to hear, said once: ONE ThingSounds, whose baseline is the sites as they are now. */
export function sayThings(sources: ThingSources, say: (signal: ThingActionSignal) => void): void {
    const things = new ThingSounds();
    const heard = (kind: ThingKind | null, workspaceId?: string | null): void => { if (kind) say({ agentId: null, kind, ...(workspaceId ? { workspaceId } : {}) }); };
    const sites = sources.sites;
    if (sites) {
        things.sites(sites.list());
        // Which site changed is read from the change itself: the sites whose state is not what it was.
        sites.onChange(() => {
            const list = sites.list();
            const workspaceOf = new Map(list.map((s) => [s.id, s.workspaceId]));
            for (const { kind, id } of things.sitesWithIds(list)) heard(kind, workspaceOf.get(id));
        });
    }
    // A site's own server is the site's row, not a process's.
    sources.supervisor.onChange((status) => heard(things.process(status, sites?.list().some((s) => s.processIds.includes(status.id)) ?? false), status.workspaceId));
    sources.engines?.onStarted(() => heard('serviceup'));
    sources.flows.onRun((id, run) => heard(flowRunSound(run), sources.flows.workspaceOf?.(id)));
}

const THING_KINDS: readonly string[] = ['exits', 'siteup', 'sitedown', 'serviceup', 'flowdone'] satisfies readonly ThingKind[];

/** What genie-host sent, or null when it does not read as one: agentless, one of the five kinds, and the workspace when it names one. Nothing else goes on. */
export function readThingSignal(raw: unknown): ThingActionSignal | null {
    const r = raw as { agentId?: unknown; kind?: unknown; workspaceId?: unknown } | null;
    if (!r || typeof r !== 'object' || r.agentId !== null || typeof r.kind !== 'string' || !THING_KINDS.includes(r.kind)) return null;
    return { agentId: null, kind: r.kind as ThingKind, ...(typeof r.workspaceId === 'string' && r.workspaceId !== '' ? { workspaceId: r.workspaceId } : {}) };
}

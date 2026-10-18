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
        const before = this.#sites;
        this.#sites = new Map(list.map((s) => [s.id, s.state]));
        if (before === null) return [];
        const heard: ThingKind[] = [];
        for (const s of list) {
            const was = before.get(s.id);
            if (was === undefined || was === s.state) continue;
            if (s.state === 'running' && ENDED.has(was)) heard.push('siteup');
            else if (was === 'running' && ENDED.has(s.state)) heard.push('sitedown');
        }
        return heard;
    }
}

/** A flow's run as it ended: it ran or it failed — it finished. A run held back never ran. */
export function flowRunSound(run: { readonly outcome: 'ran' | 'failed' | 'held' }): ThingKind | null {
    return run.outcome === 'held' ? null : 'flowdone';
}

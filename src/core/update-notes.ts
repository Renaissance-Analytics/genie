import { whatsNewSection } from './whats-new.js';

/**
 * WHAT IS IN THIS UPDATE (the owner, 2026-10-19: "make sure that in this update we are actually showing the release
 * notes in the update ux like it did for genie 1"). Genie 1's upgrade window listed every version between the running
 * one and the offered one, grouped by version, newest first, fetched from GitHub's releases.
 *
 * The source is GitHub's releases API, whose `body` is the release's own Markdown (docs/releases/v<version>.md). Not
 * electron-updater's `releaseNotes`: for a GitHub feed that is the body as HTML, in which no Markdown "What's new" section
 * can be found — why #954's popover never showed anything for a real update (measured 2026-10-19).
 */

/** The slice of a GitHub release this reads. */
export interface ReleaseLike {
    readonly tag_name: string;
    readonly body?: string | null;
    readonly draft?: boolean;
}

export interface UpdateNotesGroup {
    readonly version: string;
    /** That version's "What's new", as Markdown. */
    readonly notes: string;
}

export interface UpdateChangelog {
    /** Newest first: the offered version, then each one before it, down to (not including) the running one. */
    readonly groups: readonly UpdateNotesGroup[];
    /** Some notes could not be read — the offered version was not among the releases fetched. Said, never hidden. */
    readonly partial: boolean;
}

/** `2.0.0-beta.31` → numbers then the pre-release parts; a release sorts after its own pre-releases. */
export function compareGenieVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [core = '', pre] = v.replace(/^v/, '').split('-', 2) as [string, string | undefined];
        return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre === undefined ? null : pre.split('.') };
    };
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
        const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
        if (d !== 0) return d;
    }
    if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i];
        const q = y.pre[i];
        if (p === undefined) return -1;
        if (q === undefined) return 1;
        const pn = /^\d+$/.test(p) ? Number(p) : null;
        const qn = /^\d+$/.test(q) ? Number(q) : null;
        if (pn !== null && qn !== null) { if (pn !== qn) return pn - qn; continue; }
        if (pn !== null) return -1;
        if (qn !== null) return 1;
        if (p !== q) return p < q ? -1 : 1;
    }
    return 0;
}

/** The notes between the version running and the one on offer: (running, offered], newest first. */
export function changelogBetween(releases: readonly ReleaseLike[], running: string, offered: string): UpdateChangelog {
    const inRange = releases
        .filter((r) => !r.draft)
        .map((r) => ({ version: r.tag_name.replace(/^v/, ''), body: r.body ?? '' }))
        .filter((r) => compareGenieVersions(r.version, running) > 0 && compareGenieVersions(r.version, offered) <= 0)
        .sort((a, b) => compareGenieVersions(b.version, a.version));
    const groups = inRange.flatMap((r) => {
        const notes = whatsNewSection(r.body);
        return notes ? [{ version: r.version, notes }] : [];
    });
    const offeredRead = inRange.some((r) => compareGenieVersions(r.version, offered) === 0);
    return { groups, partial: !offeredRead };
}

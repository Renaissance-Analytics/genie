/**
 * WHAT THE REPO NOW SAYS THAT THIS MACHINE DOES NOT (Tynn #756, PR9c). A teammate pushes a flow, a process or a tab layout, and the
 * files under `.flows/`, `.processes/` and `.genie/tabs.json` differ from what Genie would save from this workspace now. Each difference
 * is an OFFER: what the repo says (`incoming`) beside what this machine has (`local`). A file the repo no longer has is told in
 * `removed`; nothing is ever offered for removal. Pure: a watcher reads the files and Genie's own state, this only compares.
 */

export interface RepoFile {
    readonly path: string;
    /** The file parsed; `undefined` when it could not be read as JSON. */
    readonly value: unknown;
}

export interface CloneOffer {
    /** `<kind>:<file>`: one per file. */
    readonly id: string;
    readonly kind: 'flow' | 'process' | 'tabs';
    readonly file: string;
    /** `new`: nothing here for it. `changed`: here, and different. */
    readonly change: 'new' | 'changed';
    readonly summary: string;
    readonly incoming: unknown;
    readonly local: unknown | null;
}

interface Place {
    readonly kind: CloneOffer['kind'];
    readonly pattern: RegExp;
    readonly noun: string;
}

/** The three places, in the order offers are listed. */
const PLACES: readonly Place[] = [
    { kind: 'flow', pattern: /^\.flows\/([^/]+)\.json$/, noun: 'flow' },
    { kind: 'process', pattern: /^\.processes\/([^/]+)\.json$/, noun: 'process' },
    { kind: 'tabs', pattern: /^\.genie\/tabs\.json$/, noun: 'workspace tabs' },
];

const placeOf = (path: string): { place: Place; stem: string } | null => {
    for (const place of PLACES) {
        const m = place.pattern.exec(path);
        if (m) return { place, stem: m[1] ?? '' };
    }
    return null;
};

/** Key order must not decide whether two files say the same. */
function canon(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const o = value as Record<string, unknown>;
        return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

export function cloneOffers(repo: readonly RepoFile[], live: readonly RepoFile[]): { offers: CloneOffer[]; removed: string[] } {
    const here = new Map(live.map((f) => [f.path, f.value]));
    const there = new Set(repo.map((f) => f.path));
    const offers: CloneOffer[] = [];
    for (const place of PLACES) {
        const files = repo.filter((f) => placeOf(f.path)?.place === place && f.value !== undefined).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (const file of files) {
            const known = here.has(file.path);
            if (known && canon(here.get(file.path)) === canon(file.value)) continue;
            const stem = placeOf(file.path)!.stem;
            const named = place.kind === 'tabs' ? place.noun : `${place.noun}: ${stem}`;
            offers.push({
                id: `${place.kind}:${file.path}`,
                kind: place.kind,
                file: file.path,
                change: known ? 'changed' : 'new',
                summary: `${known ? 'Changed' : 'New'} ${named}`,
                incoming: file.value,
                local: known ? here.get(file.path) : null,
            });
        }
    }
    const removed = live.filter((f) => placeOf(f.path) !== null && !there.has(f.path)).map((f) => f.path);
    return { offers, removed };
}

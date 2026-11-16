/** Inert stub (RED): what the repo now says that this machine does not (Tynn #756, PR9c). The implementation lands after the tests are seen failing. */

export interface RepoFile {
    readonly path: string;
    /** The file parsed; `undefined` when it could not be read as JSON. */
    readonly value: unknown;
}

export interface CloneOffer {
    readonly id: string;
    readonly kind: 'flow' | 'process' | 'tabs';
    readonly file: string;
    readonly change: 'new' | 'changed';
    readonly summary: string;
    readonly incoming: unknown;
    readonly local: unknown | null;
}

export function cloneOffers(_repo: readonly RepoFile[], _live: readonly RepoFile[]): { offers: CloneOffer[]; removed: string[] } {
    return { offers: [], removed: [] };
}

/**
 * STUB (Tynn #651, tests-first commit): the names the tests import, with no behaviour, so every test fails on its
 * assertion rather than on a missing module. The implementation is the next commit.
 */
export const DRONE_MIN_BUILD = '';

export interface DroneSkew {
    readonly build: string | null;
    readonly method?: string;
}

export function shownBuild(build: string): string {
    return build;
}

export function compareVersions(_a: string, _b: string): number {
    return 0;
}

/** Wrong for every case on purpose: an always-null stub would pass the "not older" tests without the fix. */
export function welcomeSkew(_welcome: { readonly protocol?: unknown; readonly build?: unknown }, _min: string = DRONE_MIN_BUILD): DroneSkew | null {
    return { build: 'stub' };
}

export function refusalSkew(_reason: string): { method: string } | null {
    return null;
}

export function skewSentence(_name: string | null, _skew: { readonly drone: string | null; readonly pilot: string | null }): string {
    return '';
}

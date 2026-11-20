/** PM G-4 (Tynn #937): stub for the red run; the judge is not built yet. */

export type ReleaseGate =
    | { readonly ok: true; readonly versionNumber: string | null; readonly recordId: string | null; readonly signedBy: string | null }
    | { readonly ok: false; readonly reason: string };

export interface TagVersion { readonly id: string; readonly number: string | null; readonly title: string; readonly status: string }
export interface TagOptions { readonly linked: boolean; readonly head: string | null; readonly versions: readonly TagVersion[]; readonly reason: string | null }

const notBuilt = (): never => { throw new Error('PM G-4 not built yet'); };

export function releaseDecisionPath(_projectId: string, _versionId: string, _commit: string): string { return notBuilt(); }
export function commitMatches(_a: string | null, _b: string | null): boolean { return notBuilt(); }
export function judgeReleaseDecision(_answer: unknown, _ask: { versionId: string; commit: string }): ReleaseGate { return notBuilt(); }
export function defaultTagFor(_number: string | null): string { return notBuilt(); }
export function repoCallNeedsOwner(_method: string, _args: readonly unknown[]): boolean { return notBuilt(); }

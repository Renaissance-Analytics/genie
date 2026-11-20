/**
 * PM G-4 (Tynn #937; spec pm-model.md row G-4, §17 answer 2): THE TAG STEP'S RELEASE DECISION. For a workspace linked to
 * Tynn, the Repository panel's Tag release asks Tynn's read-only door (PM-3, tynn#929)
 *   GET /api/v1/projects/{projectId}/versions/{versionId}/release-decision?commit={sha}
 * and tags only when the answer is a decision that is SIGNED, still VALID, not already USED by a release, for the version
 * that was asked about, and signed for the EXACT commit being tagged. Anything else is a refusal in words, Tynn's own where
 * Tynn gave them. Strict on purpose: the spec asks for "a valid signed release decision matching the version and the exact
 * commit", so Tynn's `required: false` (its rules off for that repository) does not open the tag step.
 *
 * Genie compares the commit itself as well as reading Tynn's `commit_matches`: a tag is only ever made on a commit Genie
 * has seen named in the signed decision. Pure: main/release-tag-gate.ts asks Tynn, main/repo-git.ts makes the tag.
 */

export type ReleaseGate =
    | { readonly ok: true; readonly versionNumber: string | null; readonly recordId: string | null; readonly signedBy: string | null }
    | { readonly ok: false; readonly reason: string };

/** A Tynn version the panel offers to tag against. */
export interface TagVersion { readonly id: string; readonly number: string | null; readonly title: string; readonly status: string }
/** What the Tag release form needs: whether Tynn gates it, the commit it would tag, and (linked) the versions to pick. */
export interface TagOptions { readonly linked: boolean; readonly head: string | null; readonly versions: readonly TagVersion[]; readonly reason: string | null }

/** The repository panel's ops that only the host's owner may call: tagging a release, and what its form reads from Tynn. */
export const OWNER_ONLY_REPO_OPS: readonly string[] = ['tag', 'tagOptions'];

/** Whether a protocol call is one of those (the op is `repo.call`'s first argument, once its staged arguments are read). */
export function repoCallNeedsOwner(method: string, args: readonly unknown[]): boolean {
    return method === 'repo.call' && typeof args[0] === 'string' && OWNER_ONLY_REPO_OPS.includes(args[0]);
}

export function releaseDecisionPath(projectId: string, versionId: string, commit: string): string {
    return `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/release-decision?commit=${encodeURIComponent(commit)}`;
}

const normal = (commit: string | null | undefined): string | null => {
    const c = typeof commit === 'string' ? commit.trim().toLowerCase() : '';
    return c === '' ? null : c;
};

/** Tynn's own rule (ReleaseDecisions::commitMatches): case-insensitive, and a short SHA (7+) matches the full one it begins. */
export function commitMatches(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = normal(a), y = normal(b);
    if (x === null || y === null || Math.min(x.length, y.length) < 7) return false;
    return x.startsWith(y) || y.startsWith(x);
}

const short = (commit: string): string => commit.slice(0, 7);
const record = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const NOT_A_DECISION: ReleaseGate = { ok: false, reason: 'Tynn answered with something that is not a release decision, so Genie will not tag.' };

export function judgeReleaseDecision(answer: unknown, ask: { versionId: string; commit: string }): ReleaseGate {
    const top = record(answer);
    const version = record(top?.version);
    const d = record(top?.decision);
    if (!top || !version || !d) return NOT_A_DECISION;
    if (version.id !== ask.versionId) return { ok: false, reason: 'Tynn answered about a different version than the one chosen, so Genie will not tag.' };
    const number = str(version.number);
    const named = number ?? str(version.title) ?? ask.versionId;
    if (d.signed !== true) {
        return { ok: false, reason: `Tynn has no signed release decision for version ${named}. The release signer signs it on Tynn's Releases page; then tag again.` };
    }
    if (d.consumed === true) return { ok: false, reason: `Tynn's release decision for version ${named} was already used by a release. It cannot tag another.` };
    if (d.valid !== true) {
        const problem = str(record(d.problem)?.message);
        return { ok: false, reason: `Tynn's release decision for version ${named} no longer holds${problem ? `: ${problem}` : '.'}` };
    }
    const signedFor = str(d.release_commit);
    if (d.commit_matches !== true || !commitMatches(signedFor, ask.commit)) {
        return { ok: false, reason: signedFor
            ? `Tynn's release decision for version ${named} was signed for commit ${short(signedFor)}, not ${short(ask.commit)} (HEAD). Tag the signed commit, or have the decision signed for this one.`
            : `Tynn's release decision for version ${named} names no commit, so it cannot be matched to ${short(ask.commit)} (HEAD).` };
    }
    return { ok: true, versionNumber: number, recordId: str(d.record_id), signedBy: str(record(d.signed_by)?.name) };
}

/** The tag a version is offered under: its number, with git's usual `v`. */
export function defaultTagFor(number: string | null): string {
    if (number === null || number.trim() === '') return '';
    const n = number.trim();
    return /^v/i.test(n) ? n : `v${n}`;
}

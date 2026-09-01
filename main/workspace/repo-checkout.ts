import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * Local-only checkout snapshot for one repo (genie#317): current branch,
 * whether it IS the repo's default branch, and how far it has drifted from
 * `origin/<defaultBranch>` — all read from refs ALREADY on disk. This NEVER
 * fetches, so it's cheap enough to compute for every repo at boot, but the
 * comparison can be stale if the workspace hasn't fetched recently; callers
 * should say so once for the whole report, not repeat it per repo.
 */
export interface RepoCheckoutInfo {
    /** Current branch name, or null when HEAD is detached. */
    branch: string | null;
    /** True when HEAD is detached (no branch checked out). */
    detached: boolean;
    /**
     * The repo's default branch, resolved from the LOCAL `origin/HEAD` symref
     * (what a real `git clone` sets), falling back to `main`/`master` if that
     * ref exists locally but the symref doesn't. Null when neither is
     * determinable without a network round trip.
     */
    defaultBranch: string | null;
    /** True when `branch` IS `defaultBranch`. */
    isDefaultBranch: boolean;
    /** Commits `branch` is ahead of `comparedTo`, from local refs only. */
    ahead: number | null;
    /** Commits `branch` is behind `comparedTo`, from local refs only. */
    behind: number | null;
    /** The local ref ahead/behind was computed against, e.g. "origin/main". Null when not computable. */
    comparedTo: string | null;
    /** The `version` field from the repo's own package.json at HEAD, if present. */
    packageVersion: string | null;
}

async function tryRaw(git: ReturnType<typeof simpleGit>, args: string[]): Promise<string | null> {
    try {
        const out = await git.raw(args);
        return out.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Compute `repoPath`'s checkout state from refs already on disk. Deliberately
 * does NOT run `git fetch` — this is meant to be cheap enough to call once per
 * repo at every agent boot, and a fetch would both cost time and quietly
 * change the workspace's git state during pure orientation.
 */
export async function repoCheckoutInfo(repoPath: string): Promise<RepoCheckoutInfo> {
    const git = simpleGit({ baseDir: repoPath });

    const branch = await tryRaw(git, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const detached = branch === null;

    let defaultBranch = await tryRaw(git, [
        'symbolic-ref',
        '--short',
        '-q',
        'refs/remotes/origin/HEAD',
    ]);
    if (defaultBranch) {
        defaultBranch = defaultBranch.replace(/^origin\//, '');
    } else {
        for (const candidate of ['main', 'master']) {
            const ref = await tryRaw(git, [
                'rev-parse',
                '--verify',
                '-q',
                `refs/remotes/origin/${candidate}`,
            ]);
            if (ref) {
                defaultBranch = candidate;
                break;
            }
        }
    }

    let ahead: number | null = null;
    let behind: number | null = null;
    let comparedTo: string | null = null;
    if (defaultBranch) {
        const ref = `origin/${defaultBranch}`;
        const counts = await tryRaw(git, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]);
        if (counts) {
            const [behindStr, aheadStr] = counts.split(/\s+/);
            const b = Number.parseInt(behindStr, 10);
            const a = Number.parseInt(aheadStr, 10);
            if (Number.isFinite(a) && Number.isFinite(b)) {
                ahead = a;
                behind = b;
                comparedTo = ref;
            }
        }
    }

    let packageVersion: string | null = null;
    try {
        const raw = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8');
        const pkg = JSON.parse(raw) as { version?: unknown };
        if (typeof pkg.version === 'string') packageVersion = pkg.version;
    } catch {
        /* no package.json, or unparsable — leave null */
    }

    return {
        branch,
        detached,
        defaultBranch,
        isDefaultBranch: branch !== null && defaultBranch !== null && branch === defaultBranch,
        ahead,
        behind,
        comparedTo,
        packageVersion,
    };
}

/**
 * One human-readable line summarizing a repo's checkout state (genie#317), e.g.
 * `genie — feat/gapp-agents-and-self-update, 178 behind origin/main (v0.7.0-beta.265; running build is v0.7.0-beta.289)`
 *
 * Pure formatting, no I/O. `runningBuildVersion` is only meaningful for the
 * repo that IS the currently-running Genie build, so pass it for that repo
 * alone — every other repo's line omits the "running build is" note even when
 * a version is present.
 */
export function formatRepoCheckoutLine(
    name: string,
    checkout: RepoCheckoutInfo,
    runningBuildVersion?: string | null,
): string {
    const bits: string[] = [];
    if (checkout.detached) {
        bits.push('detached HEAD');
    } else if (checkout.branch) {
        bits.push(checkout.isDefaultBranch ? `${checkout.branch} (default)` : checkout.branch);
    } else {
        bits.push('no branch (empty repo)');
    }

    if (checkout.comparedTo && (checkout.ahead !== null || checkout.behind !== null)) {
        const ahead = checkout.ahead ?? 0;
        const behind = checkout.behind ?? 0;
        if (ahead === 0 && behind === 0) {
            bits.push(`up to date with ${checkout.comparedTo}`);
        } else {
            const drift: string[] = [];
            if (ahead > 0) drift.push(`${ahead} ahead`);
            if (behind > 0) drift.push(`${behind} behind`);
            bits.push(`${drift.join(', ')} ${checkout.comparedTo}`);
        }
    } else {
        bits.push("can't compare to origin's default branch locally");
    }

    let line = `${name} — ${bits.join(', ')}`;
    if (checkout.packageVersion) {
        const mismatch = runningBuildVersion && runningBuildVersion !== checkout.packageVersion;
        line += mismatch
            ? ` (v${checkout.packageVersion}; running build is v${runningBuildVersion})`
            : ` (v${checkout.packageVersion})`;
    }
    return line;
}

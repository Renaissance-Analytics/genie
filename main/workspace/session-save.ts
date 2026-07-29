import path from 'node:path';
import { simpleGit } from 'simple-git';
import { listWorkspaces } from '../db';
import { parseGitPorcelain } from '../files/ipc';
import { detectFolder } from './detect';
import { githubCloneAuth, isHostGithubGhConfigured, redactSecrets } from './git-auth';

/**
 * Git-save before teardown — the data-safety gate for session-based (ephemeral)
 * workstations. Phase 1a of Tynn story #229.
 *
 * A session workstation is transient compute: when the session ends the box is
 * destroyed and only what reached a REMOTE survives. Before that happens this
 * operation walks every workspace the host has provisioned, finds every git repo
 * inside it, and lands anything not already on a remote onto a fresh
 * `genie-session/<timestamp>` branch that it pushes.
 *
 * Three properties matter more than convenience here:
 *
 *  1. **The working branch is never touched.** We `checkout -b` a new session
 *     branch and commit THERE; `main` (or whatever the user was on) keeps
 *     pointing exactly where it did. The autosave branch is a safe landing the
 *     user can cherry-pick from — never a rewrite of their work.
 *  2. **Failures are per-repo and never lie.** One repo's push failure must not
 *     abort the others, and a repo whose work did NOT reach the remote is
 *     reported `failed` — never `saved`. The caller (teardown) is expected to
 *     read {@link SessionSaveReport.ok} and BLOCK the teardown, or require an
 *     explicit override, when it is false.
 *  3. **What git cannot save is said out loud.** `.gitignore`-d files are NOT
 *     force-added (that could push secrets to a remote) — they are listed in
 *     {@link SessionSaveReport.cannotSave} so the loss warning is honest.
 *
 * Everything impure (workspace list, repo discovery, git, auth, clock) is
 * injected so the operation is unit-testable with no network and no real git;
 * {@link hostSessionSaveDeps} builds the real host-side wiring.
 */

/** Every autosave branch lives under this prefix. */
export const SESSION_BRANCH_PREFIX = 'genie-session/';

/** Identity used ONLY when the host has no `user.name`/`user.email` configured
 *  — without it `git commit` would fail on a fresh headless box and the save
 *  would be lost. A configured identity is always preferred (never overridden). */
const FALLBACK_COMMIT_IDENTITY = ['user.name=Genie', 'user.email=genie@localhost'];

/** Default cap on the per-repo ignored-path list, so a `node_modules`-shaped
 *  answer can't turn the loss warning into an unreadable wall. */
const DEFAULT_MAX_IGNORED_PATHS = 200;

export type SessionSaveResult = 'saved' | 'clean' | 'failed';

export interface SessionSaveRepoReport {
    /** Absolute path of the repo on disk. */
    path: string;
    /** The workspace this repo belongs to. */
    workspaceId: string;
    workspaceName: string;
    /**
     * `saved`  — the work is on the remote (push succeeded).
     * `clean`  — nothing to save; no branch was created.
     * `failed` — work exists that did NOT reach the remote. Teardown is unsafe.
     */
    result: SessionSaveResult;
    /** Session branch the work was committed to (absent when `clean`). */
    branch?: string;
    /** Tip commit of the session branch (absent when `clean` or the branch
     *  could not be created). */
    commit?: string;
    /** True ONLY when the push succeeded — the single fact `saved` rests on. */
    pushed?: boolean;
    /** Why the save failed. Never set on a `saved` repo. */
    reason?: string;
    /** Branch the repo was on when the save ran. Left exactly where it was. */
    workingBranch?: string;
    /** Uncommitted entries (`git status --porcelain`), excluding ignored files. */
    dirtyFiles: number;
    /** Commits ahead of the upstream (or `1` when the branch is unpublished). */
    unpushedCommits: number;
}

/** `.gitignore`-d entries present in one repo — git will not carry these. */
export interface SessionSaveIgnoredPaths {
    /** Absolute repo path. */
    path: string;
    /** Repo-relative ignored entries (git collapses whole ignored dirs). */
    ignored: string[];
    /** True when the list hit the cap and was cut short. */
    truncated: boolean;
}

export interface SessionSaveReport {
    /** The instant the save ran, ISO-8601. */
    timestamp: string;
    /** The one session branch name used across every repo in this run. */
    branch: string;
    repos: SessionSaveRepoReport[];
    /** No repo failed. The caller MUST refuse to tear down when this is false
     *  unless the operator explicitly overrides with the loss warning shown. */
    ok: boolean;
    counts: { saved: number; clean: number; failed: number };
    /** What a git save fundamentally cannot carry across a teardown. */
    cannotSave: {
        ignoredPaths: SessionSaveIgnoredPaths[];
        notes: string[];
    };
}

/** A workspace to walk. Narrower than the db row on purpose. */
export interface SessionSaveWorkspace {
    id: string;
    name: string;
    path: string;
}

export interface SessionSaveDeps {
    /** Every workspace this host has provisioned. */
    listWorkspaces: () => SessionSaveWorkspace[];
    /** Absolute git-repo paths inside a workspace (envelope root + members). */
    discoverRepos: (workspacePath: string) => string[];
    /**
     * Run git in `repoPath` and resolve stdout; REJECT on a non-zero exit.
     * `config` entries become leading `-c <entry>` args (simple-git's `config`).
     */
    git: (repoPath: string, args: string[], config?: string[]) => Promise<string>;
    /**
     * Global `-c` entries that authenticate a push of `repoPath`'s `origin`,
     * plus any secret substrings to scrub from a surfaced error.
     */
    auth: (repoPath: string, remoteUrl: string) => { config: string[]; secrets: string[] };
    now: () => Date;
    /** Cap on the ignored-path list per repo. Defaults to 200. */
    maxIgnoredPaths?: number;
}

/**
 * The session branch name for `now`. A raw ISO timestamp is NOT a legal git ref
 * (`:` is forbidden, and a trailing `.` / `..` are too), so the instant is
 * flattened to `YYYY-MM-DDTHH-MM-SSZ` — sortable, readable, and ref-safe.
 */
export function sessionBranchName(now: Date): string {
    const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
    return SESSION_BRANCH_PREFIX + stamp;
}

/**
 * Every git repo inside a workspace folder. An `.agi` envelope is itself a repo
 * AND contains one per member under `repos/<name>` — both hold work, so both are
 * saved. A simple workspace is its own single repo. Mirrors the repo discovery
 * IssueWatch does (`detectFolder(...).repos`), so the two agree on what a
 * workspace's repos are.
 */
export function discoverWorkspaceRepos(workspacePath: string): string[] {
    const detected = detectFolder(workspacePath);
    if (detected.state === 'EMPTY') return [];
    const out: string[] = [];
    if (detected.has_root_git) out.push(workspacePath);
    for (const name of detected.repos) out.push(path.join(workspacePath, 'repos', name));
    return out;
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** Uncommitted entries and ignored entries for one repo. */
async function readStatus(
    deps: SessionSaveDeps,
    repoPath: string,
): Promise<{ dirty: string[]; ignored: string[] }> {
    // `-uall` lists untracked files individually so the dirty count is real.
    const dirtyOut = await deps.git(repoPath, ['status', '--porcelain=v1', '-uall']);
    const dirty = Object.keys(parseGitPorcelain(dirtyOut));

    // Ignored entries are a REPORTING concern, not a save concern — a failure to
    // list them must never fail the save, so this is best-effort. No `-uall`
    // here: git collapses whole ignored directories (`node_modules/`), which is
    // what an operator actually wants to read.
    let ignored: string[] = [];
    try {
        const ignoredOut = await deps.git(repoPath, ['status', '--porcelain=v1', '--ignored']);
        ignored = Object.entries(parseGitPorcelain(ignoredOut))
            .filter(([, status]) => status === 'ignored')
            .map(([p]) => p);
    } catch {
        /* best-effort: the warning list degrades, the save does not. */
    }
    return { dirty, ignored };
}

/**
 * How many commits would be lost if this repo vanished right now.
 *
 * The upstream comparison is the normal answer. With NO upstream configured
 * `@{upstream}` errors, and the branch may exist nowhere on a remote — so we ask
 * whether any remote-tracking ref already contains HEAD. If none does, the
 * commits die with the box, so we report `1` ("at least one unpublished commit")
 * and the repo gets saved. Erring toward saving is the whole point.
 */
async function countUnpushed(deps: SessionSaveDeps, repoPath: string): Promise<number> {
    try {
        const out = await deps.git(repoPath, ['rev-list', '--count', '@{upstream}..HEAD']);
        const n = Number.parseInt(out.trim(), 10);
        return Number.isFinite(n) ? n : 0;
    } catch {
        try {
            const contains = await deps.git(repoPath, ['branch', '-r', '--contains', 'HEAD']);
            return contains.trim() ? 0 : 1;
        } catch {
            // No commits at all (a freshly `git init`-ed repo) — nothing to push.
            return 0;
        }
    }
}

/** Working branch, or null when detached / unreadable. */
async function readWorkingBranch(
    deps: SessionSaveDeps,
    repoPath: string,
): Promise<string | undefined> {
    try {
        const out = (await deps.git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        return out && out !== 'HEAD' ? out : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extra `-c` config needed for `git commit` to succeed. Empty when the host has
 * a usable identity — we never override the owner's. `git var
 * GIT_COMMITTER_IDENT` is exactly the "can git commit right now?" probe.
 */
async function commitIdentityConfig(
    deps: SessionSaveDeps,
    repoPath: string,
): Promise<string[]> {
    try {
        const ident = (await deps.git(repoPath, ['var', 'GIT_COMMITTER_IDENT'])).trim();
        if (ident) return [];
    } catch {
        /* identity unset — fall through to the synthetic one. */
    }
    return FALLBACK_COMMIT_IDENTITY;
}

/** Tip commit of HEAD, or undefined when it can't be read. */
async function readHeadCommit(
    deps: SessionSaveDeps,
    repoPath: string,
): Promise<string | undefined> {
    try {
        const out = (await deps.git(repoPath, ['log', '-1', '--format=%H'])).trim();
        return out || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Save ONE repo. Never throws for an expected git failure — it returns a
 * `failed` report carrying the reason, so the caller keeps walking. The one
 * thing it must never do is report `saved` for work that did not reach the
 * remote.
 */
async function saveRepo(
    deps: SessionSaveDeps,
    workspace: SessionSaveWorkspace,
    repoPath: string,
    branch: string,
    timestamp: string,
    ignoredSink: SessionSaveIgnoredPaths[],
): Promise<SessionSaveRepoReport> {
    const { dirty, ignored } = await readStatus(deps, repoPath);

    // Ignored files are lost whether or not this repo has work to save, so they
    // are collected before we decide anything else.
    if (ignored.length) {
        const cap = deps.maxIgnoredPaths ?? DEFAULT_MAX_IGNORED_PATHS;
        ignoredSink.push({
            path: repoPath,
            ignored: ignored.slice(0, cap),
            truncated: ignored.length > cap,
        });
    }

    const workingBranch = await readWorkingBranch(deps, repoPath);
    const unpushedCommits = await countUnpushed(deps, repoPath);
    const base = {
        path: repoPath,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workingBranch,
        dirtyFiles: dirty.length,
        unpushedCommits,
    };

    if (dirty.length === 0 && unpushedCommits === 0) {
        return { ...base, result: 'clean' };
    }

    // Carve the session branch off HEAD. This moves HEAD only — the working
    // branch ref stays exactly where it was, and the uncommitted changes come
    // along to be committed here instead of on the user's branch.
    try {
        await deps.git(repoPath, ['checkout', '-b', branch]);
    } catch (e) {
        return { ...base, result: 'failed', reason: `create ${branch}: ${errorMessage(e)}` };
    }

    if (dirty.length > 0) {
        try {
            // `add -A` respects .gitignore. NEVER `-f`: force-adding ignored
            // files could push secrets (.env, keys) to a remote.
            await deps.git(repoPath, ['add', '-A']);
            const identity = await commitIdentityConfig(deps, repoPath);
            await deps.git(
                repoPath,
                ['commit', '-m', `Genie session autosave — ${timestamp}`],
                identity,
            );
        } catch (e) {
            return { ...base, result: 'failed', branch, reason: `commit: ${errorMessage(e)}` };
        }
    }

    const commit = await readHeadCommit(deps, repoPath);

    let remoteUrl: string;
    try {
        remoteUrl = (await deps.git(repoPath, ['remote', 'get-url', 'origin'])).trim();
    } catch (e) {
        return {
            ...base,
            result: 'failed',
            branch,
            commit,
            pushed: false,
            reason:
                `no 'origin' remote to push to — the work is committed locally on ` +
                `${branch} but will NOT survive teardown (${errorMessage(e)})`,
        };
    }

    const { config, secrets } = deps.auth(repoPath, remoteUrl);
    try {
        await deps.git(repoPath, ['push', 'origin', branch], config);
    } catch (e) {
        return {
            ...base,
            result: 'failed',
            branch,
            commit,
            pushed: false,
            // simple-git echoes the spawned argv, which can carry an auth
            // header — scrub before this reaches a log or the operator.
            reason: `push: ${redactSecrets(errorMessage(e), secrets)}`,
        };
    }

    return { ...base, result: 'saved', branch, commit, pushed: true };
}

/** Loss modes a git save cannot cover, stated plainly for the operator warning. */
function cannotSaveNotes(): string[] {
    return [
        'Files excluded by .gitignore are deliberately NOT committed (committing them could push secrets to the remote) — copy anything you need off the host first.',
        'Running processes, terminals and background jobs do not survive teardown; anything they hold in memory or in a temp dir is lost.',
        'Agent logins and CLI sessions on this host are not preserved — they are re-injected when the next session starts.',
    ];
}

/**
 * Walk every workspace on the host and save whatever is not already on a
 * remote. See the module header for the guarantees. Returns a structured report;
 * the caller decides whether teardown may proceed (`report.ok`).
 */
export async function saveWorkspacesForTeardown(
    deps: SessionSaveDeps,
): Promise<SessionSaveReport> {
    const now = deps.now();
    const timestamp = now.toISOString();
    const branch = sessionBranchName(now);

    const repos: SessionSaveRepoReport[] = [];
    const ignoredPaths: SessionSaveIgnoredPaths[] = [];
    const seen = new Set<string>();

    for (const workspace of deps.listWorkspaces()) {
        let repoPaths: string[];
        try {
            repoPaths = deps.discoverRepos(workspace.path);
        } catch {
            // An unreadable workspace folder is not a reason to skip the rest.
            continue;
        }
        for (const repoPath of repoPaths) {
            // The same repo can be reachable from two workspaces; save it once.
            const key = path.resolve(repoPath).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            try {
                repos.push(
                    await saveRepo(deps, workspace, repoPath, branch, timestamp, ignoredPaths),
                );
            } catch (e) {
                // Belt-and-braces: an UNEXPECTED throw is contained to this repo
                // and surfaced as a failure — never swallowed into a false save.
                repos.push({
                    path: repoPath,
                    workspaceId: workspace.id,
                    workspaceName: workspace.name,
                    result: 'failed',
                    reason: errorMessage(e),
                    dirtyFiles: 0,
                    unpushedCommits: 0,
                });
            }
        }
    }

    const counts = {
        saved: repos.filter((r) => r.result === 'saved').length,
        clean: repos.filter((r) => r.result === 'clean').length,
        failed: repos.filter((r) => r.result === 'failed').length,
    };

    return {
        timestamp,
        branch,
        repos,
        ok: counts.failed === 0,
        counts,
        cannotSave: { ignoredPaths, notes: cannotSaveNotes() },
    };
}

/**
 * Push auth for the session save: the OWNER's `gh` credential helper, never the
 * GitHub App token. A single-owner installation token cannot push a cross-owner
 * repo, and we must not persist or log a token onto a box that is about to be
 * destroyed — so we pass NO token and let `gh` (set up by the workstation
 * bootstrap) authenticate, keeping only the SSH→HTTPS rewrites so an SSH-pinned
 * remote still routes through the helper. With no `gh` set up this degrades to
 * ambient git auth exactly as a manual `git push` would.
 */
function hostPushAuth(_repoPath: string, remoteUrl: string): {
    config: string[];
    secrets: string[];
} {
    const auth = githubCloneAuth(remoteUrl, null, {
        ghConfigured: isHostGithubGhConfigured(),
    });
    return { config: auth.config, secrets: auth.secrets };
}

/** Real host wiring for {@link saveWorkspacesForTeardown}. */
export function hostSessionSaveDeps(): SessionSaveDeps {
    return {
        listWorkspaces: () =>
            listWorkspaces().map((w) => ({
                id: w.id,
                name: w.project_name,
                path: w.path,
            })),
        discoverRepos: discoverWorkspaceRepos,
        git: (repoPath, args, config = []) =>
            simpleGit({ baseDir: repoPath, config }).raw(args),
        auth: hostPushAuth,
        now: () => new Date(),
    };
}

/** The save currently walking this host, if any. See {@link runHostSessionSave}. */
let inFlightHostSave: Promise<SessionSaveReport> | null = null;

/**
 * Run the session save on THIS host — what `POST /api/desktop/session-save` calls.
 *
 * Single-flight, because teardown can plausibly ask twice (an operator's "End
 * session" racing the idle-timeout, or a caller retrying a slow request). Two
 * concurrent walks would fight over the same git indexes and the second
 * `checkout -b` would find the branch already there — turning a good save into a
 * `failed` report that blocks a teardown which should have been allowed. A second
 * caller therefore joins the run already in progress and reads the SAME report.
 *
 * The slot is released once the run settles — including on a throw — so a failed
 * attempt never wedges the host into refusing every later save.
 */
export function runHostSessionSave(
    deps: SessionSaveDeps = hostSessionSaveDeps(),
): Promise<SessionSaveReport> {
    if (inFlightHostSave) return inFlightHostSave;
    const run = saveWorkspacesForTeardown(deps).finally(() => {
        if (inFlightHostSave === run) inFlightHostSave = null;
    });
    inFlightHostSave = run;
    return run;
}

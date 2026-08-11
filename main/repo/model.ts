/**
 * PURE git-model helpers for the Repository panel (no I/O, no Electron) — the
 * unit-testable core the thin `simple-git` binding in `index.ts` wraps.
 *
 * Mirrors the `parseGitPorcelain` discipline in `main/files/ipc.ts`: the parse
 * is a pure function so it can be tested in isolation, and the process spawn is
 * a thin, never-throwing shell around it.
 */
import path from 'path';

/** A one-word classification for a changed file, for the panel's status pill. */
export type RepoChangeLabel =
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'typechange'
    | 'untracked'
    | 'conflicted';

/** One changed file, split across the staged (index, X) and unstaged (worktree, Y) sides. */
export interface RepoChange {
    /** Workspace-relative path (the NEW path for a rename/copy). */
    path: string;
    /** The porcelain index (staged) status char, e.g. 'M', 'A', 'D', ' '. */
    index: string;
    /** The porcelain worktree (unstaged) status char. */
    worktree: string;
    /** Has staged content (X is a real change, not ' ' or '?'). */
    staged: boolean;
    /** Has unstaged content (Y is a real change, or the file is untracked). */
    unstaged: boolean;
    /** Untracked (`??`). */
    untracked: boolean;
    /** One-word label for the pill. */
    label: RepoChangeLabel;
}

/** Branch header info from `git status --branch`. */
export interface RepoBranchInfo {
    /** Current branch name, or null when detached / unknown. */
    branch: string | null;
    /** Tracking branch (e.g. 'origin/main'), or null when none. */
    upstream: string | null;
    ahead: number;
    behind: number;
    detached: boolean;
}

/** The whole panel view model for one repo. */
export interface RepoStatus extends RepoBranchInfo {
    changes: RepoChange[];
}

/** One selectable repo in the panel's repo picker (the root and each member repo). */
export interface RepoRef {
    /** Workspace-relative folder ('' = the workspace root itself). */
    rel: string;
    /** Display name. */
    name: string;
}

/**
 * PURE: the selectable repos for a workspace — the workspace root itself (when it
 * is a git work tree) plus each `project.json` member repo that is one. `isRepo`
 * is injected (a `.git` existence probe) so this stays testable without fs. The
 * root comes first; duplicates by `rel` are dropped.
 */
export function repoRefsFromProjectJson(
    rootName: string,
    repos: Array<{ name: string; path?: string }> | undefined,
    isRepo: (rel: string) => boolean,
): RepoRef[] {
    const out: RepoRef[] = [];
    const seen = new Set<string>();
    const add = (rel: string, name: string) => {
        if (seen.has(rel)) return;
        seen.add(rel);
        out.push({ rel, name });
    };
    if (isRepo('')) add('', rootName);
    for (const repo of repos ?? []) {
        const rel = (repo.path ?? '').trim();
        if (!rel) continue;
        if (isRepo(rel)) add(rel, repo.name);
    }
    return out;
}

/** Map a porcelain XY pair to a one-word label. Conflicts and untracked win first. */
export function classifyChange(x: string, y: string): RepoChangeLabel {
    if (x === '?' || y === '?') return 'untracked';
    // Unmerged (conflict): any of DD/AU/UD/UA/DU/AA/UU (a 'U' on either side, or AA/DD).
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'))
        return 'conflicted';
    const c = x !== ' ' ? x : y; // prefer the staged side, else the worktree side
    switch (c) {
        case 'A':
            return 'added';
        case 'D':
            return 'deleted';
        case 'R':
            return 'renamed';
        case 'C':
            return 'copied';
        case 'T':
            return 'typechange';
        case 'M':
        default:
            return 'modified';
    }
}

/**
 * Parse the porcelain `## …` branch header line. Handles:
 *   `## main...origin/main [ahead 2, behind 1]`
 *   `## main...origin/main`
 *   `## solo`                       (no upstream)
 *   `## No commits yet on main`     (fresh repo)
 *   `## HEAD (no branch)`           (detached)
 */
export function parseBranchLine(line: string): RepoBranchInfo {
    const base: RepoBranchInfo = {
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        detached: false,
    };
    const body = line.replace(/^##\s*/, '').trim();

    if (/^HEAD \(no branch\)/.test(body)) {
        return { ...base, detached: true };
    }

    const noCommits = /^No commits yet on (.+)$/.exec(body);
    if (noCommits) {
        return { ...base, branch: noCommits[1].trim() };
    }

    // Split off the [ahead x, behind y] suffix.
    const div = /\[([^\]]+)\]\s*$/.exec(body);
    let names = body;
    if (div) {
        names = body.slice(0, div.index).trim();
        const ahead = /ahead (\d+)/.exec(div[1]);
        const behind = /behind (\d+)/.exec(div[1]);
        base.ahead = ahead ? Number(ahead[1]) : 0;
        base.behind = behind ? Number(behind[1]) : 0;
    }

    // `branch...upstream` or just `branch`.
    const sep = names.indexOf('...');
    if (sep !== -1) {
        base.branch = names.slice(0, sep).trim() || null;
        base.upstream = names.slice(sep + 3).trim() || null;
    } else {
        base.branch = names.trim() || null;
    }
    return base;
}

/** Strip git's C-style quoting from a porcelain path (spaces / specials). */
function unquotePath(p: string): string {
    let s = p;
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        s = s.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    return s.replace(/\\/g, '/');
}

/**
 * Parse `git status --porcelain=v1 --branch -uall` into the panel view model.
 * The first `## …` line is the branch header; each following `XY <path>` line is
 * a changed file (rename/copy lines carry `old -> new`, and the NEW path is the
 * one on disk). Never throws.
 */
export function parseRepoStatus(stdout: string): RepoStatus {
    let header: RepoBranchInfo = {
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        detached: false,
    };
    const changes: RepoChange[] = [];

    for (const rawLine of stdout.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line) continue;
        if (line.startsWith('##')) {
            header = parseBranchLine(line);
            continue;
        }
        if (line.length < 3) continue;
        const x = line[0];
        const y = line[1];
        const rest = line.slice(3);
        const untracked = x === '?' && y === '?';
        let filePath = rest;
        const arrow = rest.indexOf(' -> ');
        if (arrow !== -1 && (x === 'R' || x === 'C')) {
            filePath = rest.slice(arrow + 4);
        }
        changes.push({
            path: unquotePath(filePath),
            index: x,
            worktree: y,
            staged: x !== ' ' && x !== '?',
            unstaged: untracked || y !== ' ',
            untracked,
            label: classifyChange(x, y),
        });
    }

    return { ...header, changes };
}

/**
 * Contain a repo path within its workspace root. `repoRel` is a workspace-
 * relative folder (a submodule / member repo, or '' / '.' for the workspace
 * root itself). Returns the ABSOLUTE path, or throws if the path escapes the
 * root or is absolute — the `guardedResolve` discipline before any path reaches
 * git (s217 §3.3). Case/separator-robust via `path.relative`.
 */
export function guardRepoPath(workspaceRoot: string, repoRel: string): string {
    const root = path.resolve(workspaceRoot);
    const rel = (repoRel ?? '').trim();
    if (rel === '' || rel === '.') return root;
    if (path.isAbsolute(rel)) {
        throw new Error(`Repo path must be workspace-relative, got an absolute path: ${rel}`);
    }
    const abs = path.resolve(root, rel);
    const back = path.relative(root, abs);
    if (back === '' ) return root;
    if (back.startsWith('..') || path.isAbsolute(back)) {
        throw new Error(`Repo path "${rel}" escapes the workspace root.`);
    }
    return abs;
}

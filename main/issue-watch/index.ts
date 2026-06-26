import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import simpleGit from 'simple-git';
import {
    getWorkspace,
    listIssueWatches,
    listWorkspaces,
    setIssueWatch,
    markIssueWatchSeen,
} from '../db';
import { detectFolder } from '../workspace/detect';
import {
    fetchRepoWatchItemsResult,
    isSecurityKind,
    parseGitHubRemote,
    worseError,
    type WatchItem,
    type WatchFetchError,
    type WatchErrorDetail,
} from '../github/api';
import { getToken, needsReauth } from '../github/storage';

/**
 * Issue Watch — per-workspace watching of GitHub Issues, PRs, and Dependabot
 * alerts on the workspace's repos.
 *
 *   - Repos are AUTO-DETECTED from each repo subfolder's `origin` remote
 *     (owner/repo); the user toggles which to actually watch (default ON).
 *   - A background poller fetches each enabled watch's open items; the feed is
 *     cached in memory. "Unread" = an item updated after the watch's seen_at
 *     high-water mark; opening the flyout marks the workspace seen.
 *   - Alerts are quiet + in-app: a per-workspace rail dot + an in-flyout feed +
 *     a titlebar badge (no OS toast). Reuses the existing `repo` OAuth token.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Cached feed per `<owner>/<repo>` (the last poll's open items). */
const feedCache = new Map<string, WatchItem[]>();
/**
 * Cached per-`<owner>/<repo>` fetch detail from the last poll (null/absent =
 * the last read succeeded). This is what lets the flyout explain a silent-empty
 * repo — a 403/404/unauthenticated read leaves [] in feedCache but its REASON
 * here (bucket + raw HTTP status + GitHub message), so the UI can show the
 * EXACT error ("GitHub returned 401: Bad credentials") instead of "no issues".
 */
const errorCache = new Map<string, WatchErrorDetail | null>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

export interface ResolvedRepo {
    owner: string;
    repo: string;
    /** Absolute path of the local checkout the remote was read from. */
    path: string;
}

/**
 * Per-bucket tallies for the workspace 3-dot pill. The three security-alert
 * kinds (dependabot / code-scanning / secret-scanning) collapse into one
 * `security` bucket — the pill shows one security dot, not three — while the
 * per-kind detail lives on each WatchItem in the feed.
 */
export interface TypeCounts {
    issue: number;
    pr: number;
    /** dependabot + code-scanning + secret-scanning (the security dot). */
    security: number;
}

/** The bucket a WatchItem kind tallies into (security kinds → `security`). */
function bucketOf(kind: WatchItem['kind']): keyof TypeCounts {
    if (isSecurityKind(kind)) return 'security';
    return kind; // 'issue' | 'pr'
}

/** Pure: count items updated strictly after the seen-at high-water mark. */
export function unreadCount(items: WatchItem[], seenAt: string): number {
    return items.filter((i) => i.updatedAt > seenAt).length;
}

/** Pure: bucket unread (updated after seenAt) by bucket (security aggregated). */
export function unreadByKind(items: WatchItem[], seenAt: string): TypeCounts {
    const out: TypeCounts = { issue: 0, pr: 0, security: 0 };
    for (const i of items) if (i.updatedAt > seenAt) out[bucketOf(i.kind)] += 1;
    return out;
}

/**
 * Pure: bucket ALL items (no seen_at filter), security kinds aggregated. This
 * drives the workspace 3-dot pill / rail dot, which signal PRESENCE — "is there
 * anything to act on?" — not unread-since-last-seen. A repo with ≥1 open issue
 * keeps a green issue-dot until that issue closes; opening the flyout (which
 * marks seen) must NOT grey the dot. The seen-based `unreadByKind` still drives
 * the feed's per-item "new since you looked" highlight.
 */
export function countByKind(items: WatchItem[]): TypeCounts {
    const out: TypeCounts = { issue: 0, pr: 0, security: 0 };
    for (const i of items) out[bucketOf(i.kind)] += 1;
    return out;
}

const cacheKey = (owner: string, repo: string) => `${owner}/${repo}`;

/**
 * Resolve a workspace's GitHub repos from its repo subfolders' origin remotes.
 * An .agi envelope has repos/<name>; a simple workspace is its own single repo.
 */
export async function resolveWorkspaceRepos(workspaceId: string): Promise<ResolvedRepo[]> {
    const ws = getWorkspace(workspaceId);
    if (!ws) return [];
    let names: string[] = [];
    try {
        names = detectFolder(ws.path).repos ?? [];
    } catch {
        names = [];
    }
    const candidates = names.length
        ? names.map((n) => path.join(ws.path, 'repos', n))
        : [ws.path];
    const out: ResolvedRepo[] = [];
    const seen = new Set<string>();
    for (const p of candidates) {
        try {
            const remotes = await simpleGit(p).getRemotes(true);
            const origin =
                remotes.find((r) => r.name === 'origin') ?? remotes[0];
            const url = origin?.refs?.fetch || origin?.refs?.push;
            if (!url) continue;
            const parsed = parseGitHubRemote(url);
            if (!parsed) continue;
            const k = cacheKey(parsed.owner, parsed.repo);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ owner: parsed.owner, repo: parsed.repo, path: p });
        } catch {
            /* not a git repo / git missing — skip */
        }
    }
    return out;
}

/** A repo row for the flyout: detected repo + its watch + unread state. */
export interface WatchRepoView {
    owner: string;
    repo: string;
    enabled: boolean;
    unread: number;
    /** Why this repo's last read came back empty (null = read succeeded, or it
     *  was never polled). The flyout keys off this to explain a silent-empty
     *  repo instead of implying it has no items. */
    error: WatchFetchError | null;
    /** The raw detail (HTTP status + GitHub message) behind {@link error}, so
     *  the flyout can show the precise cause; null when the read succeeded. */
    detail: WatchErrorDetail | null;
}

/**
 * The watch rows for a workspace: every auto-detected repo joined with its
 * persisted enabled flag (default ON) + current unread count from the cache +
 * its last-read error (so the flyout can explain a silent-empty repo).
 */
export async function getWorkspaceRepoViews(
    workspaceId: string,
): Promise<WatchRepoView[]> {
    const repos = await resolveWorkspaceRepos(workspaceId);
    const watches = listIssueWatches(workspaceId);
    const byKey = new Map(watches.map((w) => [cacheKey(w.owner, w.repo), w]));
    return repos.map((r) => {
        const w = byKey.get(cacheKey(r.owner, r.repo));
        const enabled = w ? w.enabled === 1 : true; // default ON
        const items = feedCache.get(cacheKey(r.owner, r.repo)) ?? [];
        const detail = enabled ? errorCache.get(cacheKey(r.owner, r.repo)) ?? null : null;
        return {
            owner: r.owner,
            repo: r.repo,
            enabled,
            unread: enabled ? unreadCount(items, w?.seen_at ?? '1970-01-01T00:00:00.000Z') : 0,
            error: detail?.error ?? null,
            detail,
        };
    });
}

/**
 * The per-workspace surfaced Issue Watch status: WHY the feed is what it is.
 *   - `connected: false` ⇒ no GitHub token (the flyout routes to Settings).
 *   - `error` ⇒ the worst read failure across the workspace's enabled repos
 *     (forbidden / not_found / rate_limited / unknown), so an empty feed
 *     explains itself instead of implying "nothing open".
 *   - `detail` ⇒ the raw HTTP status + GitHub message behind `error`, so the
 *     flyout shows the EXACT cause ("GitHub returned 401: Bad credentials").
 *   - `needsReauth` ⇒ the stored GitHub session is dead (an auth failure /
 *     second-401 flagged it). The flyout shows a one-click Reconnect CTA.
 *   - all falsy with items ⇒ a genuine success; the flyout shows the feed or
 *     an honest "nothing open".
 */
export interface WorkspaceWatchStatus {
    connected: boolean;
    /** Worst read error across enabled repos, or null when all reads were ok. */
    error: WatchFetchError | null;
    /** Raw detail (HTTP status + message) behind {@link error}, or null. */
    detail: WatchErrorDetail | null;
    /** True when the stored GitHub session is dead and must be reconnected.
     *  Drives the flyout's "GitHub session expired — Reconnect" banner. */
    needsReauth: boolean;
}

/** Pure: the worst read error across a set of repo views (null = all ok). */
export function worstViewError(views: WatchRepoView[]): WatchFetchError | null {
    let worst: WatchFetchError | null = null;
    for (const v of views) if (v.enabled) worst = worseError(worst, v.error);
    return worst;
}

/**
 * Pure: the full detail (bucket + raw HTTP status/message) of the WORST read
 * across a set of repo views, or null when every enabled read succeeded. Picks
 * the detail whose bucket {@link worstViewError} chose, so the surfaced status's
 * `error` and `detail` always describe the same failure.
 */
export function worstViewDetail(views: WatchRepoView[]): WatchErrorDetail | null {
    let worst: WatchErrorDetail | null = null;
    for (const v of views) {
        if (!v.enabled || !v.detail) continue;
        if (worst === null || worseError(v.detail.error, worst.error) === v.detail.error) {
            worst = v.detail;
        }
    }
    return worst;
}

/**
 * Poll one repo and cache its open items AND its fetch outcome. Best-effort —
 * a failed read caches [] items + the failure class (so the flyout can explain
 * the empty feed) rather than throwing.
 */
async function pollRepo(owner: string, repo: string): Promise<WatchItem[]> {
    const { items, detail } = await fetchRepoWatchItemsResult(owner, repo);
    feedCache.set(cacheKey(owner, repo), items);
    errorCache.set(cacheKey(owner, repo), detail);
    return items;
}

/** Poll every enabled watch in a workspace (skips when GitHub isn't connected). */
export async function pollWorkspace(workspaceId: string): Promise<void> {
    if (!getToken()) return;
    const views = await getWorkspaceRepoViews(workspaceId);
    await Promise.all(
        views.filter((v) => v.enabled).map((v) => pollRepo(v.owner, v.repo).catch(() => [])),
    );
}

/**
 * Poll every workspace's enabled/default-on repos (the interval tick + the
 * startup kick). Goes through `pollWorkspace`, which resolves repos via
 * `getWorkspaceRepoViews` — so it covers auto-detected, default-on repos that
 * have no persisted `issue_watches` row yet. Without this, a workspace whose
 * repos were never toggled would have no rows for `listEnabledIssueWatches`,
 * leaving its feed cache empty and its 3-dot pill grey until the flyout was
 * opened. Per-workspace failures are swallowed so one bad workspace doesn't
 * sink the rest; a single `broadcastUpdate()` fires at the end.
 */
async function pollAll(): Promise<void> {
    if (!getToken()) return;
    for (const ws of listWorkspaces()) {
        try {
            await pollWorkspace(ws.id);
        } catch {
            /* best-effort — one workspace's failure shouldn't sink the rest */
        }
    }
    await broadcastUpdate();
}

/** The flattened, unread-flagged feed for a workspace (newest first). */
export async function getWorkspaceFeed(
    workspaceId: string,
): Promise<Array<WatchItem & { repo: string; owner: string; unread: boolean }>> {
    const watches = listIssueWatches(workspaceId);
    const seenByKey = new Map(watches.map((w) => [cacheKey(w.owner, w.repo), w.seen_at]));
    const views = await getWorkspaceRepoViews(workspaceId);
    const out: Array<WatchItem & { repo: string; owner: string; unread: boolean }> = [];
    for (const v of views) {
        if (!v.enabled) continue;
        const seenAt = seenByKey.get(cacheKey(v.owner, v.repo)) ?? '1970-01-01T00:00:00.000Z';
        for (const it of feedCache.get(cacheKey(v.owner, v.repo)) ?? []) {
            out.push({ ...it, owner: v.owner, repo: v.repo, unread: it.updatedAt > seenAt });
        }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
}

/**
 * Per-workspace OPEN-item tallies by type — the source for the workspace
 * 3-dot pill / rail dot, which signal PRESENCE ("is there anything to act
 * on?"), NOT unread-since-last-seen.
 *
 * Counts the workspace's AUTO-DETECTED repos (default-on), not just persisted
 * `issue_watches` rows — mirroring getWorkspaceRepoViews; a repo with no row is
 * treated as enabled. Each enabled repo's open items are bucketed by kind with
 * `countByKind` (NO seen_at filter), so a dot stays green as long as items of
 * that type are open and opening the flyout (which mark-seens) does NOT grey
 * it. The seen-based unread highlight lives in the feed, not here. Async
 * because resolving a workspace's repos reads git remotes.
 */
export async function getOpenCounts(): Promise<Record<string, TypeCounts>> {
    const out: Record<string, TypeCounts> = {};
    for (const ws of listWorkspaces()) {
        let repos: ResolvedRepo[];
        try {
            repos = await resolveWorkspaceRepos(ws.id);
        } catch {
            continue; // best-effort — a bad workspace shouldn't sink the rest
        }
        if (repos.length === 0) continue;
        const watches = listIssueWatches(ws.id);
        const byKey = new Map(watches.map((w) => [cacheKey(w.owner, w.repo), w]));
        const acc: TypeCounts = { issue: 0, pr: 0, security: 0 };
        for (const r of repos) {
            const w = byKey.get(cacheKey(r.owner, r.repo));
            const enabled = w ? w.enabled === 1 : true; // default ON
            if (!enabled) continue;
            const k = countByKind(feedCache.get(cacheKey(r.owner, r.repo)) ?? []);
            acc.issue += k.issue;
            acc.pr += k.pr;
            acc.security += k.security;
        }
        if (acc.issue || acc.pr || acc.security) out[ws.id] = acc;
    }
    return out;
}

/**
 * The surfaced status for one workspace: connected + worst read error across
 * its enabled repos. Drives the flyout's empty-state copy so a silent-empty
 * feed explains WHY (not connected / can't read / 404 / rate limited) rather
 * than implying "nothing open".
 */
export async function getWorkspaceStatus(
    workspaceId: string,
): Promise<WorkspaceWatchStatus> {
    if (!getToken()) {
        // No token at all. A dead session (revoked / refresh exhausted) still
        // leaves the reauth flag set, so report it: the flyout shows Reconnect
        // rather than the plain "connect in Settings" copy.
        return { connected: false, error: null, detail: null, needsReauth: needsReauth() };
    }
    const views = await getWorkspaceRepoViews(workspaceId).catch(() => []);
    const detail = worstViewDetail(views);
    // An auth failure surfaces a Reconnect CTA: either a read came back
    // unauthenticated (a live 401), or gh() already flagged the stored session
    // dead on an earlier call.
    const reauth = needsReauth() || detail?.error === 'unauthenticated';
    return {
        connected: true,
        error: detail?.error ?? null,
        detail,
        needsReauth: reauth,
    };
}

/**
 * Worst read DETAIL per workspace across all workspaces (null entries omitted) —
 * piggybacks on the broadcast so the renderer knows WHY a workspace pill is
 * empty (bucket + raw HTTP status/message), and whether it's an auth failure,
 * without a round-trip. Skips the token check intentionally: an unconnected
 * GitHub surfaces via the per-workspace `connected` flag the flyout fetches on
 * open, not here.
 */
async function getWorkspaceErrors(): Promise<Record<string, WatchErrorDetail>> {
    const out: Record<string, WatchErrorDetail> = {};
    for (const ws of listWorkspaces()) {
        const views = await getWorkspaceRepoViews(ws.id).catch(() => []);
        const worst = worstViewDetail(views);
        if (worst) out[ws.id] = worst;
    }
    return out;
}

async function broadcastUpdate(): Promise<void> {
    const counts = await getOpenCounts();
    const errors = await getWorkspaceErrors();
    // A dead session (an auth-failure read, or a flag gh() set on an earlier
    // call) drives the flyout's Reconnect CTA the moment the next poll lands —
    // no need to reopen the flyout. Carry the flag on the broadcast.
    const reauth =
        needsReauth() ||
        Object.values(errors).some((d) => d.error === 'unauthenticated');
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
            win.webContents.send('issue-watch:update', { counts, errors, needsReauth: reauth });
    }
}

/** Register IPC + start the background poller. Idempotent. */
export function registerIssueWatchIpc(): void {
    ipcMain.handle('issue-watch:repos', async (_e, workspaceId: string) => {
        await pollWorkspace(workspaceId); // refresh on view
        return getWorkspaceRepoViews(workspaceId);
    });
    ipcMain.handle(
        'issue-watch:set',
        async (_e, workspaceId: string, owner: string, repo: string, enabled: boolean) => {
            setIssueWatch(workspaceId, owner, repo, enabled);
            if (enabled) await pollRepo(owner, repo).catch(() => []);
            await broadcastUpdate();
            return { ok: true };
        },
    );
    ipcMain.handle('issue-watch:feed', async (_e, workspaceId: string) =>
        getWorkspaceFeed(workspaceId),
    );
    ipcMain.handle('issue-watch:mark-seen', (_e, workspaceId: string) => {
        const now = new Date().toISOString();
        for (const r of listIssueWatches(workspaceId)) {
            markIssueWatchSeen(workspaceId, r.owner, r.repo, now);
        }
        // Also seed seen_at for auto-detected repos with no row yet, so opening
        // the flyout doesn't leave them perpetually "unread".
        void (async () => {
            for (const v of await getWorkspaceRepoViews(workspaceId)) {
                markIssueWatchSeen(workspaceId, v.owner, v.repo, now);
            }
            await broadcastUpdate();
        })();
        return { ok: true };
    });
    ipcMain.handle('issue-watch:counts', () => getOpenCounts());
    ipcMain.handle('issue-watch:status', async (_e, workspaceId: string) =>
        getWorkspaceStatus(workspaceId),
    );

    if (!pollTimer) {
        pollTimer = setInterval(() => void pollAll(), POLL_INTERVAL_MS);
        // Kick an initial poll shortly after startup (token may settle first).
        setTimeout(() => void pollAll(), 8000);
    }
}

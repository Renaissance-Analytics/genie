import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import simpleGit from 'simple-git';
import {
    getWorkspace,
    listIssueWatches,
    listEnabledIssueWatches,
    listWorkspaces,
    setIssueWatch,
    markIssueWatchSeen,
} from '../db';
import { detectFolder } from '../workspace/detect';
import { fetchRepoWatchItems, parseGitHubRemote, type WatchItem } from '../github/api';
import { getToken } from '../github/storage';

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
let pollTimer: ReturnType<typeof setInterval> | null = null;

export interface ResolvedRepo {
    owner: string;
    repo: string;
    /** Absolute path of the local checkout the remote was read from. */
    path: string;
}

/** Pure: count items updated strictly after the seen-at high-water mark. */
export function unreadCount(items: WatchItem[], seenAt: string): number {
    return items.filter((i) => i.updatedAt > seenAt).length;
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
}

/**
 * The watch rows for a workspace: every auto-detected repo joined with its
 * persisted enabled flag (default ON) + current unread count from the cache.
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
        return {
            owner: r.owner,
            repo: r.repo,
            enabled,
            unread: enabled ? unreadCount(items, w?.seen_at ?? '1970-01-01T00:00:00.000Z') : 0,
        };
    });
}

/** Poll one repo and cache its open items. Best-effort (errors → []). */
async function pollRepo(owner: string, repo: string): Promise<WatchItem[]> {
    const items = await fetchRepoWatchItems(owner, repo);
    feedCache.set(cacheKey(owner, repo), items);
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

/** Poll every enabled watch across all workspaces (the interval tick). */
async function pollAll(): Promise<void> {
    if (!getToken()) return;
    const rows = listEnabledIssueWatches();
    // Dedupe repos shared across workspaces.
    const uniq = new Map<string, { owner: string; repo: string }>();
    for (const r of rows) uniq.set(cacheKey(r.owner, r.repo), { owner: r.owner, repo: r.repo });
    await Promise.all(
        [...uniq.values()].map((r) => pollRepo(r.owner, r.repo).catch(() => [])),
    );
    broadcastUpdate();
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

/** Per-workspace unread totals (for the rail dots + titlebar badge). */
export function getUnreadCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const ws of listWorkspaces()) {
        let n = 0;
        for (const w of listIssueWatches(ws.id)) {
            if (w.enabled !== 1) continue;
            n += unreadCount(feedCache.get(cacheKey(w.owner, w.repo)) ?? [], w.seen_at);
        }
        if (n > 0) out[ws.id] = n;
    }
    return out;
}

function broadcastUpdate(): void {
    const counts = getUnreadCounts();
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('issue-watch:update', { counts });
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
            broadcastUpdate();
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
            broadcastUpdate();
        })();
        return { ok: true };
    });
    ipcMain.handle('issue-watch:counts', () => getUnreadCounts());

    if (!pollTimer) {
        pollTimer = setInterval(() => void pollAll(), POLL_INTERVAL_MS);
        // Kick an initial poll shortly after startup (token may settle first).
        setTimeout(() => void pollAll(), 8000);
    }
}

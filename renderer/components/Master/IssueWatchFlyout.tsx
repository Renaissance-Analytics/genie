import { useEffect, useState } from 'react';
import { IconX } from './icons';
import {
    api,
    hasGenieBridge,
    type WatchFeedItem,
    type WatchRepoView,
} from '../../lib/genie';

/**
 * Issue Watch flyout. Right-side slide-in (reuses the Docs flyout chrome, so it
 * inherits the titlebar offset + slide animation). For the active workspace it
 * lists the auto-detected GitHub repos with a per-repo watch toggle + unread
 * count, and a unified feed of open Issues / PRs / Dependabot alerts (newest
 * first), unread items highlighted. Opening marks the workspace seen, which
 * clears the per-item "new since you looked" highlights on the next view — it
 * does NOT clear the rail dot / 3-dot pill: those signal PRESENCE of open items
 * (getOpenCounts), so they stay lit until the items themselves are closed.
 */
const KIND_LABEL: Record<WatchFeedItem['kind'], string> = {
    issue: 'Issue',
    pr: 'PR',
    dependabot: 'Dependabot',
};

export default function IssueWatchFlyout({
    open,
    workspaceId,
    onClose,
}: {
    open: boolean;
    workspaceId: string | null;
    onClose: () => void;
}) {
    const [repos, setRepos] = useState<WatchRepoView[]>([]);
    const [feed, setFeed] = useState<WatchFeedItem[]>([]);
    const [connected, setConnected] = useState(true);
    const [loading, setLoading] = useState(false);

    const refresh = async () => {
        if (!workspaceId || !hasGenieBridge()) return;
        setLoading(true);
        try {
            const st = await api().github.status().catch(() => ({ connected: false }));
            setConnected(!!st.connected);
            const [r, f] = await Promise.all([
                api().issueWatch.repos(workspaceId),
                api().issueWatch.feed(workspaceId),
            ]);
            setRepos(r);
            setFeed(f);
        } finally {
            setLoading(false);
        }
    };

    // On open: load + mark the workspace seen (clears rail dot/badge). The feed
    // we just captured keeps its unread highlights for this viewing.
    useEffect(() => {
        if (!open || !workspaceId) return;
        void (async () => {
            await refresh();
            await api().issueWatch.markSeen(workspaceId).catch(() => {});
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, workspaceId]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const toggleRepo = async (r: WatchRepoView) => {
        if (!workspaceId) return;
        setRepos((prev) =>
            prev.map((x) =>
                x.owner === r.owner && x.repo === r.repo
                    ? { ...x, enabled: !x.enabled }
                    : x,
            ),
        );
        await api().issueWatch.set(workspaceId, r.owner, r.repo, !r.enabled).catch(() => {});
        await refresh();
    };

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout iw-flyout"
                role="dialog"
                aria-label="Issue Watch"
                aria-modal="false"
            >
                <div className="docs-head">
                    <span className="docs-title">Issue Watch</span>
                    <span className="grow" />
                    <button
                        type="button"
                        className="gicon"
                        onClick={onClose}
                        title="Close Issue Watch"
                        aria-label="Close Issue Watch"
                    >
                        <IconX />
                    </button>
                </div>

                <div className="iw-body">
                    {!hasGenieBridge() ? (
                        <div className="iw-muted">Issue Watch runs inside Genie.</div>
                    ) : !connected ? (
                        <div className="iw-muted">
                            Connect GitHub in Settings → Connections to watch issues,
                            PRs, and Dependabot alerts.
                        </div>
                    ) : (
                        <>
                            <div className="iw-section-head">
                                Repos {loading && <span className="iw-muted">· refreshing…</span>}
                            </div>
                            {repos.length === 0 ? (
                                <div className="iw-muted">
                                    No GitHub repos detected in this workspace (no
                                    git remote pointing at github.com).
                                </div>
                            ) : (
                                <div className="iw-repos">
                                    {repos.map((r) => (
                                        <label
                                            key={`${r.owner}/${r.repo}`}
                                            className="iw-repo"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={r.enabled}
                                                onChange={() => void toggleRepo(r)}
                                            />
                                            <span className="iw-repo-name">
                                                {r.owner}/{r.repo}
                                            </span>
                                            {r.enabled && r.unread > 0 && (
                                                <span className="iw-count">{r.unread}</span>
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}

                            <div className="iw-section-head">Activity</div>
                            {feed.length === 0 ? (
                                <div className="iw-muted">
                                    Nothing open on the watched repos.
                                </div>
                            ) : (
                                <ul className="iw-feed">
                                    {feed.map((it) => (
                                        <li
                                            key={it.key}
                                            className={`iw-item${it.unread ? ' unread' : ''}`}
                                        >
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void api().tynn.openInBrowser(it.url)
                                                }
                                                title={it.url}
                                            >
                                                <span className={`iw-kind iw-kind-${it.kind}`}>
                                                    {KIND_LABEL[it.kind]}
                                                </span>
                                                <span className="iw-item-title">
                                                    {it.title}
                                                </span>
                                                <span className="iw-item-meta">
                                                    {it.repo}
                                                    {it.number != null ? ` #${it.number}` : ''}
                                                    {it.severity ? ` · ${it.severity}` : ''}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}

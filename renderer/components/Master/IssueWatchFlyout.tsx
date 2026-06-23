import { useEffect, useState } from 'react';
import { IconX, IconAlert } from './icons';
import {
    api,
    hasGenieBridge,
    type WatchFeedItem,
    type WatchFetchError,
    type WatchRepoView,
} from '../../lib/genie';
import {
    useGithubCapabilities,
    CAPABILITY_LABEL,
} from '../../lib/githubCapabilities';

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

/**
 * Workspace-level reason copy for an empty feed. `unauthenticated` is handled
 * separately (the whole flyout routes to Settings), so it's not here. `slug` is
 * an owner/repo when a single repo is the culprit, else a generic phrase.
 */
function workspaceReason(error: WatchFetchError, slug: string): string {
    switch (error) {
        case 'forbidden':
            return `Genie can't read issues on ${slug} — the GitHub App needs Issues access (403).`;
        case 'not_found':
            return `No access to ${slug} (404) — the GitHub App isn't installed there, or the repo is private/renamed.`;
        case 'rate_limited':
            return `GitHub rate limit hit — issues will reappear once it resets.`;
        default:
            return `Couldn't read issues on ${slug} — GitHub returned an unexpected error.`;
    }
}

/** Short per-repo reason badge text for a repo whose read failed. */
function repoReason(error: WatchFetchError): string {
    switch (error) {
        case 'forbidden':
            return 'no Issues access (403)';
        case 'not_found':
            return 'no access (404)';
        case 'rate_limited':
            return 'rate limited';
        case 'unauthenticated':
            return 'not connected';
        default:
            return "couldn't read";
    }
}

/** The Issue Watch capabilities, in the order shown in the gate banner. */
const IW_CAPABILITIES = [
    'issue-watch.issues',
    'issue-watch.pulls',
    'issue-watch.dependabot',
] as const;

export default function IssueWatchFlyout({
    open,
    workspaceId,
    onClose,
    onResolveGithub,
}: {
    open: boolean;
    workspaceId: string | null;
    onClose: () => void;
    /** Open the GitHub permissions resolve flyout (from the gate banner). */
    onResolveGithub?: () => void;
}) {
    // Proactive gate: when the GitHub App is missing Issues/PR/Dependabot
    // permissions, those reads are guaranteed to fail — surface a needs-
    // permission banner with a Resolve affordance instead of polling blind.
    const { caps } = useGithubCapabilities();
    const gatedIw = caps.connected
        ? IW_CAPABILITIES.filter((k) => caps.missing.includes(k))
        : [];
    const [repos, setRepos] = useState<WatchRepoView[]>([]);
    const [feed, setFeed] = useState<WatchFeedItem[]>([]);
    const [connected, setConnected] = useState(true);
    /** Worst read error across the workspace's enabled repos (null = all ok). */
    const [error, setError] = useState<WatchFetchError | null>(null);
    const [loading, setLoading] = useState(false);

    const refresh = async () => {
        if (!workspaceId || !hasGenieBridge()) return;
        setLoading(true);
        try {
            // The per-workspace status is the source of truth for WHY the feed
            // is what it is: not connected vs a read failure (403/404/…) vs a
            // genuine success. `issue-watch:status` reuses the GitHub token
            // check so a single call covers both "connected" and the error.
            const st = await api()
                .issueWatch.status(workspaceId)
                .catch(() => ({ connected: false, error: null }));
            setConnected(!!st.connected);
            setError(st.error ?? null);
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
                            {gatedIw.length > 0 && (
                                <div className="iw-gate" role="status">
                                    <div className="iw-gate-head">
                                        <IconAlert size={13} />
                                        <span>
                                            Genie's GitHub App is missing
                                            permissions, so some watching is
                                            disabled:
                                        </span>
                                    </div>
                                    <ul className="iw-gate-list">
                                        {gatedIw.map((k) => (
                                            <li key={k}>{CAPABILITY_LABEL[k] ?? k}</li>
                                        ))}
                                    </ul>
                                    {onResolveGithub && (
                                        <button
                                            type="button"
                                            className="ghcap-btn ghcap-btn-primary"
                                            onClick={onResolveGithub}
                                        >
                                            Resolve…
                                        </button>
                                    )}
                                </div>
                            )}
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
                                            {r.enabled && r.error && (
                                                <span
                                                    className="iw-repo-error"
                                                    title={workspaceReason(
                                                        r.error,
                                                        `${r.owner}/${r.repo}`,
                                                    )}
                                                >
                                                    {repoReason(r.error)}
                                                </span>
                                            )}
                                            {r.enabled && !r.error && r.unread > 0 && (
                                                <span className="iw-count">{r.unread}</span>
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}

                            <div className="iw-section-head">Activity</div>
                            {feed.length === 0 ? (
                                error ? (
                                    // The feed is empty because a read FAILED, not
                                    // because the repos are quiet — say why.
                                    <div className="iw-warn">
                                        {workspaceReason(
                                            error,
                                            repos.length === 1
                                                ? `${repos[0].owner}/${repos[0].repo}`
                                                : 'the watched repos',
                                        )}
                                    </div>
                                ) : (
                                    <div className="iw-muted">
                                        Nothing open on the watched repos.
                                    </div>
                                )
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

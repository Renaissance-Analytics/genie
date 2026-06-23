import { useEffect, useState } from 'react';
import { IconX, IconAlert } from './icons';
import {
    api,
    hasGenieBridge,
    type WatchErrorDetail,
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
 * "GitHub returned <status>: <message>" from a fetch detail — the EXACT cause,
 * not a vague "unexpected error". Returns null when there's no usable
 * status/message to show (so callers can fall back to bucket copy).
 */
function preciseError(detail: WatchErrorDetail | null | undefined): string | null {
    if (!detail) return null;
    const { status, message } = detail;
    if (status && message) return `GitHub returned ${status}: ${message}`;
    if (status) return `GitHub returned ${status}.`;
    if (message) return message;
    return null;
}

/**
 * Workspace-level reason copy for an empty feed. `unauthenticated` is handled
 * separately (the whole flyout shows the Reconnect banner), so it's not here.
 * `slug` is an owner/repo when a single repo is the culprit, else a generic
 * phrase. When `detail` carries a precise status/message we append it (and it's
 * the WHOLE message for the `unknown` bucket, where the bucket says nothing).
 */
function workspaceReason(
    error: WatchFetchError,
    slug: string,
    detail?: WatchErrorDetail | null,
): string {
    const precise = preciseError(detail);
    switch (error) {
        case 'forbidden':
            return `Genie can't read issues on ${slug} — the GitHub App needs Issues access${precise ? ` (${precise})` : ' (403)'}.`;
        case 'not_found':
            return `No access to ${slug} (404) — the GitHub App isn't installed there, or the repo is private/renamed.`;
        case 'rate_limited':
            return `GitHub rate limit hit — issues will reappear once it resets.`;
        default:
            // The `unknown` bucket carries no actionable label of its own, so the
            // precise status/message IS the explanation when we have it.
            return precise
                ? `Couldn't read issues on ${slug} — ${precise}.`
                : `Couldn't read issues on ${slug} — GitHub returned an unexpected error.`;
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

/**
 * The Reconnect device-flow state. Mirrors GithubCapabilitiesFlyout's
 * ReconnectState exactly — same shape, so the device flow is reused, not
 * reinvented (start → pending while the user enters the code → idle/error).
 */
type ReconnectState =
    | { kind: 'idle' }
    | { kind: 'starting' }
    | { kind: 'pending'; userCode: string; verificationUri: string }
    | { kind: 'error'; message: string };

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
    /** Raw detail (HTTP status + message) behind `error`, for the precise copy. */
    const [detail, setDetail] = useState<WatchErrorDetail | null>(null);
    /** The stored GitHub session is dead — show the Reconnect banner + CTA. */
    const [needsReauth, setNeedsReauth] = useState(false);
    const [loading, setLoading] = useState(false);
    const [reconnect, setReconnect] = useState<ReconnectState>({ kind: 'idle' });

    // An auth failure (dead session / a 401 read) is its own state: the App
    // permissions are fine, so the fix is a reconnect, not Settings. It takes
    // priority over both the not-connected copy and the per-repo error copy.
    const authFailed = needsReauth || error === 'unauthenticated';

    const refresh = async () => {
        if (!workspaceId || !hasGenieBridge()) return;
        setLoading(true);
        try {
            // Re-poll FIRST (issue-watch:repos refreshes the cache on view), then
            // read status — so the surfaced status/error/needsReauth reflect the
            // FRESH read, not the stale cache. This is what makes the feed recover
            // live after a reconnect: a fresh successful poll clears the dead
            // session, and the status we read next sees it.
            const [r, f] = await Promise.all([
                api().issueWatch.repos(workspaceId),
                api().issueWatch.feed(workspaceId),
            ]);
            setRepos(r);
            setFeed(f);
            // The per-workspace status is the source of truth for WHY the feed
            // is what it is: not connected vs a dead session (reconnect) vs a
            // read failure (403/404/…) vs a genuine success. `issue-watch:status`
            // reuses the GitHub token + reauth check so a single call covers
            // "connected", the precise error, and whether to offer Reconnect.
            const st = await api()
                .issueWatch.status(workspaceId)
                .catch(() => ({
                    connected: false,
                    error: null,
                    detail: null,
                    needsReauth: false,
                }));
            setConnected(!!st.connected);
            setError(st.error ?? null);
            setDetail(st.detail ?? null);
            setNeedsReauth(!!st.needsReauth);
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

    // Live: when a background poll lands a fresh status (e.g. the token died
    // mid-session), pick up the new needs-reconnect flag without reopening the
    // flyout. Only react while open and for this workspace.
    useEffect(() => {
        if (!open || !hasGenieBridge()) return;
        return api().on.issueWatchUpdate?.(({ errors, needsReauth: reauth }) => {
            if (workspaceId && errors?.[workspaceId]) {
                const d = errors[workspaceId];
                setError(d.error);
                setDetail(d);
            }
            if (reauth) setNeedsReauth(true);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, workspaceId]);

    // Cancel any in-flight device flow when the flyout closes, so a half-started
    // reconnect doesn't keep polling in the background. Mirrors the
    // GithubCapabilitiesFlyout cleanup.
    useEffect(() => {
        if (open) return;
        if (reconnect.kind === 'pending' || reconnect.kind === 'starting') {
            api().github.cancelDevice().catch(() => {});
            setReconnect({ kind: 'idle' });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // While a reconnect device flow is pending, poll github:status until the
    // token lands, then refresh Issue Watch — a fresh grant re-polls the repos
    // (issue-watch:repos refreshes on view) so the feed recovers live, no app
    // restart. Reuses the EXISTING github device methods + status poll, same as
    // the capabilities flyout.
    useEffect(() => {
        if (reconnect.kind !== 'pending') return;
        const t = setInterval(async () => {
            const st = await api().github.status().catch(() => null);
            if (!st) return;
            if (st.connected || st.flow.kind === 'error') {
                clearInterval(t);
                if (st.connected) {
                    setReconnect({ kind: 'idle' });
                    // Re-check capabilities (clears the header warning if the
                    // fresh grant resolved everything) AND re-poll Issue Watch so
                    // the feed updates without a restart.
                    await api().github.recheckCapabilities().catch(() => {});
                    await refresh();
                } else if (st.flow.kind === 'error') {
                    setReconnect({ kind: 'error', message: st.flow.message });
                }
            }
        }, 1500);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reconnect.kind]);

    /** Kick off the existing GitHub reconnect (device) flow. */
    const startReconnect = async () => {
        try {
            setReconnect({ kind: 'starting' });
            const code = await api().github.startDevice();
            setReconnect({
                kind: 'pending',
                userCode: code.user_code,
                verificationUri: code.verification_uri,
            });
            api().tynn.openInBrowser(code.verification_uri).catch(() => {});
        } catch (e) {
            setReconnect({
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

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
                    ) : authFailed ? (
                        // The stored session is dead (expired/revoked token) —
                        // the App permissions are FINE; the fix is a one-click
                        // reconnect. Show the precise error + a Reconnect CTA
                        // instead of the generic "connect in Settings" copy.
                        <ReconnectBanner
                            detail={detail}
                            reconnect={reconnect}
                            onReconnect={() => void startReconnect()}
                            onCancel={() =>
                                api()
                                    .github.cancelDevice()
                                    .catch(() => {})
                                    .finally(() => setReconnect({ kind: 'idle' }))
                            }
                        />
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
                                                        r.detail,
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
                                    // because the repos are quiet — say why, with
                                    // the precise GitHub status/message.
                                    <div className="iw-warn">
                                        {workspaceReason(
                                            error,
                                            repos.length === 1
                                                ? `${repos[0].owner}/${repos[0].repo}`
                                                : 'the watched repos',
                                            detail,
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

/**
 * "GitHub session expired — Reconnect" banner. Shown when the stored token is
 * rejected (an auth failure / dead session): the App permissions are fine, so
 * the only fix is to re-mint the token via the EXISTING device flow. Carries the
 * precise GitHub error so the user sees the real cause, and a Reconnect button
 * that drives `startReconnect` (device flow), then the parent re-polls on
 * success. Same device-flow UX as GithubCapabilitiesFlyout's reconnect step.
 */
function ReconnectBanner({
    detail,
    reconnect,
    onReconnect,
    onCancel,
}: {
    detail: WatchErrorDetail | null;
    reconnect: ReconnectState;
    onReconnect: () => void;
    onCancel: () => void;
}) {
    const precise = preciseError(detail);
    return (
        <div className="iw-reauth" role="alert">
            <div className="iw-reauth-head">
                <IconAlert size={14} />
                <span>GitHub session expired — reconnect to restore Issue Watch.</span>
            </div>
            {precise && <div className="iw-reauth-detail">{precise}</div>}
            {reconnect.kind === 'pending' ? (
                <div className="ghcap-device">
                    <span className="iw-muted">
                        A browser opened at{' '}
                        <code>{reconnect.verificationUri}</code>. Enter this code:
                    </span>
                    <CodeChip code={reconnect.userCode} />
                    <button type="button" className="ghcap-btn" onClick={onCancel}>
                        Cancel
                    </button>
                </div>
            ) : (
                <button
                    type="button"
                    className="ghcap-btn ghcap-btn-primary"
                    disabled={reconnect.kind === 'starting'}
                    onClick={onReconnect}
                >
                    {reconnect.kind === 'starting' ? 'Requesting code…' : 'Reconnect'}
                </button>
            )}
            {reconnect.kind === 'error' && (
                <span className="ghcap-error">{reconnect.message}</span>
            )}
        </div>
    );
}

/** Click-to-copy device code (mirrors GithubCapabilitiesFlyout's CodeChip). */
function CodeChip({ code }: { code: string }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(code).then(
            () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            },
            () => {},
        );
    };
    return (
        <button type="button" className="gh-code" onClick={copy} title="Click to copy">
            {code}
            <span className="gh-code-hint">{copied ? '✓ Copied' : 'Click to copy'}</span>
        </button>
    );
}

import { useEffect, useRef, useState } from 'react';
import { IconX, IconAlert, IconRefresh } from './icons';
import {
    refreshControlState,
    type RefreshOutcome,
} from '../../lib/issue-watch-refresh';
import { notTrackingFix } from '../../lib/not-tracking-fix';
import {
    api,
    hasGenieBridge,
    isRemoteWindow,
    type GithubCapabilityKey,
    type WatchErrorDetail,
    type WatchFeedItem,
    type WatchFetchError,
    type WatchRepoView,
    type WatchTypeCounts,
} from '../../lib/genie';
import {
    useGithubCapabilities,
    CAPABILITY_LABEL,
} from '../../lib/githubCapabilities';
import {
    feedbackPathForWorkspace,
    feedItemByline,
    issueWatchGate,
    openCountForRepo,
} from '../../lib/issuewatch';
import {
    useGitHubReconnect,
    type GitHubReconnectState,
} from '../GitHubConnect';

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
    'code-scanning': 'Code scan',
    'secret-scanning': 'Secret',
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
    // A remote (Work-Mode host) window's GitHub gate must reflect the HOST — the
    // host is the machine that's authed and whose App grants the reads. This is
    // a stable per-window URL signal, so it never flips mid-session.
    const remote = isRemoteWindow();
    // Proactive gate: when the GitHub App is missing Issues/PR/Dependabot
    // permissions, those reads are guaranteed to fail — surface a needs-
    // permission banner with a Resolve affordance instead of polling blind. In a
    // remote window the missing set is host-sourced (via the status read below);
    // a local window uses the client's own live capabilities.
    const { caps } = useGithubCapabilities();
    const [repos, setRepos] = useState<WatchRepoView[]>([]);
    const [feed, setFeed] = useState<WatchFeedItem[]>([]);
    const [connected, setConnected] = useState(true);
    // Whether Tynn actually reported THIS workspace. Defaults true so an older
    // host that predates the field renders exactly as before rather than
    // accusing every workspace of being untracked.
    const [knownToServer, setKnownToServer] = useState(true);
    // Whether this workspace is linked to a Tynn PROJECT. Only used to decide
    // WHICH repair the "not tracking" message offers -- the main process knows
    // it, and the old copy asked the owner to go and check it by hand.
    const [linked, setLinked] = useState(true);
    /** Worst read error across the workspace's enabled repos (null = all ok). */
    const [error, setError] = useState<WatchFetchError | null>(null);
    /** Raw detail (HTTP status + message) behind `error`, for the precise copy. */
    const [detail, setDetail] = useState<WatchErrorDetail | null>(null);
    /** The stored GitHub session is dead — show the Reconnect banner + CTA. */
    const [needsReauth, setNeedsReauth] = useState(false);
    const [serviceState, setServiceState] = useState<string>('connecting');
    const [loading, setLoading] = useState(false);
    /**
     * False until the FIRST status read for the current workspace resolves. The
     * connection/reauth flags are account-global and only become meaningful once
     * loaded; rendering the disconnected/Reconnect UI before then (or carrying
     * the PREVIOUS workspace's flags across a switch) flashes a spurious
     * "reconnect GitHub" state. While `!loaded` we show a neutral loading line.
     */
    const [loaded, setLoaded] = useState(false);
    /**
     * REMOTE ONLY: the Issue Watch capabilities the HOST's GitHub App is missing,
     * host-sourced from the status read. Drives the capability gate in a remote
     * window so it reflects the HOST's grants, not the client's. Untouched (and
     * unused) in a local window — there the gate keys off `useGithubCapabilities`.
     */
    const [hostMissingCaps, setHostMissingCaps] = useState<GithubCapabilityKey[]>([]);
    /**
     * Unresolved project feedback in Tynn for this workspace.
     *
     * Read from the COUNTS rather than the feed because feedback has no items on
     * this feed — Tynn sends a tally, and the entries themselves live in Tynn.
     * Without this the pill's feedback dot would light and open a panel that
     * never mentions feedback, which is a dead end rather than a signal.
     */
    const [feedbackCount, setFeedbackCount] = useState(0);
    /**
     * Where the feedback notice opens — Tynn's id-addressed feedback page for
     * this workspace's project, or null when the workspace has no Tynn project
     * (then the notice stays plain text rather than offering a dead link).
     *
     * Resolved from the workspace ROW, not from `workspaceId`: the local id and
     * the Tynn project id coincide only by construction, and a locally
     * scaffolded envelope's do not.
     */
    const [feedbackPath, setFeedbackPath] = useState<string | null>(null);

    // FORCE a Tynn re-read, as opposed to `refresh()` below, which only re-reads
    // what Genie already has. Tynn owns the window -- shared with every agent on
    // this workspace -- so the cooldown it returns is rendered as-is rather than
    // counted down here, where it would drift out of agreement the moment
    // anything else spent it.
    // Scroll target for the "not tracking" repair, whose fix for both the
    // unlinked and no-repos cases is the repo list a few pixels above it.
    const reposRef = useRef<HTMLDivElement>(null);
    const [forcing, setForcing] = useState(false);
    const [forceResult, setForceResult] = useState<RefreshOutcome | null>(null);
    const forceState = refreshControlState({ busy: forcing, last: forceResult });
    const forceRefresh = async () => {
        if (!workspaceId || !hasGenieBridge() || forceState.disabled) return;
        setForcing(true);
        try {
            const r = await api().issueWatch.forceRefresh(workspaceId);
            setForceResult(r);
            // Tynn pushes the new snapshot through the normal delta path, but
            // re-reading locally makes the panel reflect it without waiting for
            // the push to land.
            if (r.refreshed) await refresh();
        } catch (e) {
            setForceResult({
                refreshed: false,
                reason: 'failed',
                error: e instanceof Error ? e.message : String(e),
                cooldown: { seconds: 0, nextAllowedAt: null, label: 'now' },
            });
        } finally {
            setForcing(false);
        }
    };

    const refresh = async () => {
        if (!workspaceId || !hasGenieBridge()) return;
        setLoading(true);
        try {
            // Re-poll FIRST via issue-watch:repos (it runs pollWorkspace, which
            // populates feedCache), THEN read the feed — sequentially, NOT in
            // parallel. The feed read must see the post-poll cache; racing it
            // against the poll was the bug where the repo badge (read after the
            // poll) said "1" while the feed (read before the poll completed) was
            // empty. Reading status after both keeps the same fresh-read recovery.
            const r = await api().issueWatch.repos(workspaceId);
            const f = await api().issueWatch.feed(workspaceId);
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
                    missingCapabilities: [],
                    serviceState: 'disconnected' as const,
                    // A failed status read tells us nothing about server-side
                    // knowledge — don't accuse the workspace of being untracked
                    // on top of an already-surfaced disconnection.
                    knownToServer: true,
                    // Same reasoning: a failed read is not evidence the
                    // workspace is unlinked, and claiming so would offer the
                    // wrong repair on top of an already-surfaced failure.
                    linked: true,
                }));
            setConnected(!!st.connected);
            setKnownToServer(st.knownToServer ?? true);
            // Default TRUE on an older payload: assuming "unlinked" would send
            // someone to fix a link that is already fine.
            setLinked(st.linked ?? true);
            setError(st.error ?? null);
            setDetail(st.detail ?? null);
            setNeedsReauth(!!st.needsReauth);
            setServiceState(st.serviceState ?? (st.connected ? 'connected' : 'disconnected'));
            // Remote only: the host-sourced missing-capability set feeds the gate
            // (a local window uses its own useGithubCapabilities instead, so
            // leaving this untouched keeps local render behavior identical).
            if (remote) setHostMissingCaps(st.missingCapabilities ?? []);
            // Best-effort and deliberately last: the GitHub feed above is the
            // panel's job, and a counts read that fails must not take it down.
            const all = await api()
                .issueWatch.counts()
                .catch((): Record<string, WatchTypeCounts> => ({}));
            setFeedbackCount(all[workspaceId]?.feedback ?? 0);
        } finally {
            setLoading(false);
            setLoaded(true);
        }
    };

    // Reconnect device flow — the SHARED driver (no install-chooser bounce),
    // with IssueWatch's own post-success step: re-check capabilities + re-poll
    // the feed so it recovers live without a restart.
    const {
        state: reconnectState,
        start: startReconnect,
        cancel: cancelReconnect,
    } = useGitHubReconnect({
        active: open,
        onSuccess: async () => {
            await api().github.recheckCapabilities().catch(() => {});
            await refresh();
        },
    });

    // On open: load + mark the workspace seen (clears rail dot/badge). The feed
    // we just captured keeps its unread highlights for this viewing.
    useEffect(() => {
        if (!open || !workspaceId) return;
        // New workspace (or fresh open) — drop the stale connection flags and
        // show the neutral loading line until this workspace's own status read
        // lands, so a switch never flashes the previous workspace's reconnect
        // state (or a default disconnected one) mid-load.
        setLoaded(false);
        void (async () => {
            await refresh();
            await api().issueWatch.markSeen(workspaceId).catch(() => {});
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, workspaceId]);

    // The workspace's Tynn project id lives on the workspace ROW, so resolving
    // the notice's destination is a separate read from the counts refresh —
    // keyed on the workspace alone, since the link cannot change while it is
    // open. A failed read leaves the notice inert rather than guessing an id.
    useEffect(() => {
        if (!open || !workspaceId || !hasGenieBridge()) return;
        let cancelled = false;
        void (async () => {
            const ws = await api()
                .workspaces.list()
                .then((all) => all.find((w) => w.id === workspaceId))
                .catch(() => undefined);
            if (!cancelled) setFeedbackPath(feedbackPathForWorkspace(ws));
        })();
        return () => {
            cancelled = true;
        };
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
            // A background poll just landed (this broadcast). Re-read the feed
            // (no re-poll — the poll that fired this already refreshed the cache)
            // so the Activity list — and the repo badges, which derive from it —
            // reflect the new items instead of going stale. Keeping the badge and
            // feed off the SAME array is what keeps them consistent.
            if (workspaceId) {
                void api()
                    .issueWatch.feed(workspaceId)
                    .then(setFeed)
                    .catch(() => {});
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, workspaceId]);

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

    // The GitHub-auth gate for THIS window: host-sourced in a remote window (all
    // flags come from the host's status), client-local otherwise — the SINGLE
    // decision the render below keys off, so local behavior is byte-for-byte the
    // prior logic and a remote window never runs the client's device flow.
    const gate = issueWatchGate({
        remote,
        status: { connected, needsReauth, error, missingCapabilities: hostMissingCaps },
        localCaps: caps,
    });
    const gatedIw = gate.view === 'feed' ? gate.gatedCaps : [];

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
                    {/* Make Tynn re-read GitHub NOW. The path existed only for
                        agents (`checkIssues(refresh)`) -- an agent could force a
                        refresh and the owner could not. */}
                    <button
                        type="button"
                        className={`iw-refresh tone-${forceState.tone}`}
                        onClick={forceRefresh}
                        disabled={forceState.disabled}
                        title={forceState.detail ?? 'Ask Tynn to re-read GitHub for this workspace now'}
                    >
                        <IconRefresh size={12} />
                        <span>{forceState.label}</span>
                    </button>
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
                    ) : !loaded ? (
                        // Account-global GitHub status not resolved yet for this
                        // workspace — stay neutral instead of flashing the
                        // disconnected/Reconnect UI during the load race.
                        <div className="iw-muted">Loading…</div>
                    ) : gate.view === 'reconnect' ? (
                        gate.scope === 'host' ? (
                            // Remote window: the HOST's GitHub session is dead.
                            // The re-mint must happen on the HOST — running the
                            // client's device flow here would auth the CLIENT's
                            // GitHub and do nothing for the host's reads. So point
                            // the user at the host; NO local Reconnect CTA.
                            <RemoteHostGithubNotice kind="reauth" detail={detail} />
                        ) : (
                            // Local window: the stored session is dead (expired/
                            // revoked token) — the App permissions are FINE; the
                            // fix is a one-click device-flow reconnect. Show the
                            // precise error + a Reconnect CTA.
                            <ReconnectBanner
                                detail={detail}
                                reconnect={reconnectState}
                                onReconnect={() => void startReconnect()}
                                onCancel={cancelReconnect}
                            />
                        )
                    ) : gate.view === 'connect' ? (
                        <div className="iw-gate" role="status">
                            <div className="iw-gate-head">
                                <IconAlert size={13} />
                                <span>IssueWatch is not connected to Tynn.</span>
                            </div>
                            <div className="iw-muted">
                                {serviceState === 'disabled' ? (
                                    <>
                                        IssueWatch is disabled by this Tynn account entitlement.{' '}
                                        <button
                                            type="button"
                                            className="iw-linkbtn"
                                            onClick={() =>
                                                void api()
                                                    .tynn.openInBrowser('https://tynn.ai/account/issuewatch')
                                                    .catch(() => {})
                                            }
                                        >
                                            Manage IssueWatch
                                        </button>
                                        .
                                    </>
                                ) : serviceState === 'connecting' ? (
                                    'Connecting to the Tynn IssueWatch stream…'
                                ) : serviceState === 'signed-out' ? (
                                    'Genie is signed out of Tynn. Sign in from Settings.'
                                ) : (
                                    'The Tynn IssueWatch transport disconnected. Check Tynn broadcasting and network connectivity. Genie GitHub access is not required.'
                                )}
                            </div>
                        </div>
                    ) : (
                        <>
                            {gatedIw.length > 0 && (
                                <div className="iw-gate" role="status">
                                    <div className="iw-gate-head">
                                        <IconAlert size={13} />
                                        <span>
                                            {remote
                                                ? "The host's GitHub App is missing permissions, so some watching is disabled:"
                                                : "Genie's GitHub App is missing permissions, so some watching is disabled:"}
                                        </span>
                                    </div>
                                    <ul className="iw-gate-list">
                                        {gatedIw.map((k) => (
                                            <li key={k}>{CAPABILITY_LABEL[k] ?? k}</li>
                                        ))}
                                    </ul>
                                    {remote ? (
                                        // Resolving App permissions is a HOST action —
                                        // the local resolve flow would touch the
                                        // client's GitHub, which is the wrong machine.
                                        <span className="iw-muted">
                                            Resolve these on the host machine.
                                        </span>
                                    ) : (
                                        onResolveGithub && (
                                            <button
                                                type="button"
                                                className="ghcap-btn ghcap-btn-primary"
                                                onClick={onResolveGithub}
                                            >
                                                Resolve…
                                            </button>
                                        )
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
                                <div className="iw-repos" ref={reposRef}>
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
                                            {r.upstream && (
                                                <span
                                                    className="iw-repo-upstream"
                                                    title={`Forked from ${r.upstream.owner}/${r.upstream.repo} — its issues/PRs are watched too`}
                                                >
                                                    ⬆ {r.upstream.owner}/{r.upstream.repo}
                                                </span>
                                            )}
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
                                            {r.enabled && !r.error && openCountForRepo(feed, r) > 0 && (
                                                <span className="iw-count">
                                                    {openCountForRepo(feed, r)}
                                                </span>
                                            )}
                                        </label>
                                    ))}
                                </div>
                            )}

                            {/* Above Activity, and worded as waiting rather than
                                broken: everything in the list below is a defect,
                                and feedback is not one. The entries themselves
                                live in Tynn — this is a summary that OPENS them,
                                not a tally that names a number and stops. Only
                                a workspace with a Tynn project gets the button;
                                without one there is nothing to open. */}
                            {feedbackCount > 0 &&
                                (feedbackPath ? (
                                    <button
                                        type="button"
                                        className="iw-feedback-note as-link"
                                        onClick={() =>
                                            void api().tynn.openInBrowser(feedbackPath)
                                        }
                                        title="Open this project’s feedback in Tynn"
                                    >
                                        {feedbackCount} unresolved{' '}
                                        {feedbackCount === 1 ? 'piece' : 'pieces'} of
                                        project feedback in Tynn, waiting on triage.
                                    </button>
                                ) : (
                                    <div className="iw-feedback-note">
                                        {feedbackCount} unresolved{' '}
                                        {feedbackCount === 1 ? 'piece' : 'pieces'} of
                                        project feedback in Tynn, waiting on triage.
                                    </div>
                                ))}

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
                                ) : !knownToServer ? (
                                    // Connected, but Tynn never reported THIS
                                    // workspace — a reconcile listing zero
                                    // workspaces is still a successful delivery.
                                    // Saying "nothing open" here is a lie that hid
                                    // a completely dead feed (genie#22).
                                    // A dead end is a bug. This used to be pure
                                    // ADVICE -- "check that it's linked, check
                                    // that it has repos" -- while Genie already
                                    // held both answers, offered no button for
                                    // either, and named two causes that are
                                    // false on a workspace that IS linked with
                                    // repos ticked. It now says which cause
                                    // actually applies and hands over the
                                    // control for it.
                                    (() => {
                                        const fix = notTrackingFix({
                                            linked,
                                            enabledRepoCount: repos.filter((r) => r.enabled).length,
                                            needsReauth,
                                        });
                                        return (
                                            <div className="iw-warn iw-warn-actionable">
                                                <span>{fix.message}</span>
                                                <button
                                                    type="button"
                                                    className="iw-linkbtn"
                                                    onClick={() => {
                                                        if (fix.action === 'reconnect-github') {
                                                            void startReconnect();
                                                        } else if (fix.action === 'force-refresh') {
                                                            void forceRefresh();
                                                        } else {
                                                            // 'unlinked' and 'no-repos'
                                                            // are both repaired in the
                                                            // repo list right above
                                                            // this message.
                                                            reposRef.current?.scrollIntoView({
                                                                behavior: 'smooth',
                                                                block: 'center',
                                                            });
                                                        }
                                                    }}
                                                >
                                                    {fix.actionLabel}
                                                </button>
                                            </div>
                                        );
                                    })()
                                ) : (
                                    <div className="iw-muted">
                                        Nothing open on the watched repos.
                                    </div>
                                )
                            ) : (
                                <>
                                    {/* Group by source: items from the watched repos
                                        vs items folded in from a fork's upstream. The
                                        "Upstream" subhead only shows when there ARE
                                        upstream items, so a plain (non-fork) workspace
                                        looks exactly as before. */}
                                    {(() => {
                                        const own = feed.filter((it) => it.source !== 'upstream');
                                        const up = feed.filter((it) => it.source === 'upstream');
                                        return (
                                            <>
                                                {up.length > 0 && (
                                                    <div className="iw-subhead">This repo</div>
                                                )}
                                                <FeedList items={own} />
                                                {up.length > 0 && (
                                                    <>
                                                        <div className="iw-subhead">Upstream</div>
                                                        <FeedList items={up} />
                                                    </>
                                                )}
                                            </>
                                        );
                                    })()}
                                </>
                            )}
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
}

/**
 * One source-grouped feed list ("This repo" or "Upstream"). Each item links out
 * to its GitHub URL and shows kind / repo / number / severity, unread items
 * highlighted — the same row chrome the feed has always used, factored out so the
 * own + upstream sections render identically.
 */
function FeedList({ items }: { items: WatchFeedItem[] }) {
    if (items.length === 0) return null;
    return (
        <ul className="iw-feed">
            {items.map((it) => (
                <li key={it.key} className={`iw-item${it.unread ? ' unread' : ''}`}>
                    <button
                        type="button"
                        onClick={() => void api().tynn.openInBrowser(it.url)}
                        title={it.url}
                    >
                        <span className={`iw-kind iw-kind-${it.kind}`}>
                            {KIND_LABEL[it.kind]}
                        </span>
                        <span className="iw-item-title">{it.title}</span>
                        <span className="iw-item-meta">
                            {it.owner}/{it.repo}
                            {it.number != null ? ` #${it.number}` : ''}
                            {it.severity ? ` · ${it.severity}` : ''}
                        </span>
                        {/* Who raised it and how long it has been open — without
                            these a stranger's hour-old issue and your six-month-old
                            one read identically. Empty for an item that knows
                            neither, so no orphan line renders. */}
                        {feedItemByline(it) && (
                            <span className="iw-item-byline">{feedItemByline(it)}</span>
                        )}
                    </button>
                </li>
            ))}
        </ul>
    );
}

/**
 * REMOTE-window notice for the HOST's GitHub state. A host window's Issue Watch
 * reflects the HOST's GitHub, so when the host's session is dead (`reauth`) or
 * disconnected we must NOT run the client's device-flow reconnect — that would
 * auth the wrong machine. Instead we tell the user to act ON THE HOST. Purely
 * informational: no Reconnect/Connect button (there is nothing local to do).
 */
function RemoteHostGithubNotice({
    kind,
    detail,
}: {
    kind: 'reauth' | 'disconnected';
    detail: WatchErrorDetail | null;
}) {
    if (kind === 'disconnected') {
        return (
            <div className="iw-muted">
                Connect GitHub on the host machine to watch issues, PRs, and
                Dependabot alerts. Issue Watch in a remote window reflects the
                host's GitHub connection.
            </div>
        );
    }
    const precise = preciseError(detail);
    return (
        <div className="iw-reauth" role="alert">
            <div className="iw-reauth-head">
                <IconAlert size={14} />
                <span>
                    The host's GitHub session expired — reconnect GitHub on the
                    host machine to restore Issue Watch.
                </span>
            </div>
            {precise && <div className="iw-reauth-detail">{precise}</div>}
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
    reconnect: GitHubReconnectState;
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

import { applyPushedDelta, type PushedIssueWatchDelta } from './index';
import { getWorkspace } from '../db';
import { resolveTynnLinkForRow } from '../workspace/tynn-link';

/**
 * Force a workspace's IssueWatch feed to refresh NOW, from Genie.
 *
 * The owner's ask: agents running in Genie terminals — and humans — need a way
 * to make IssueWatch re-read GitHub instead of waiting for the next server poll,
 * and the answer must always say when the next one is allowed.
 *
 * TYNN OWNS THE RATE LIMIT. One window per WORKSPACE, shared by every agent and
 * the human, and this side deliberately holds NO counter of its own. It resolves
 * which Tynn project the local workspace is, asks, applies whatever snapshot
 * comes back, and passes the cooldown through untouched. A second limiter here
 * would be a second answer to "when may I refresh", and the two would disagree
 * the moment another Genie window or the flyout spent the window first.
 *
 * Three outcomes, each of which has to survive the trip intact:
 *
 *   - `refreshed` — the snapshot is applied and the cooldown is the full window;
 *   - `cooldown`  — REFUSED, and that is not an error. Someone else spent the
 *     window; the current snapshot still applies and the cooldown says what is
 *     actually left;
 *   - `failed` / `unavailable` — reported as a failure, never as a refresh that
 *     happened, and nothing is written over the feed.
 */

/** What Tynn answers. `cooldown` is always present, so a caller never has to
 *  guess how long to wait. */
export interface TynnRefreshResponse {
    refreshed: boolean;
    reason: 'refreshed' | 'cooldown' | 'unavailable';
    error?: string | null;
    cooldown: { seconds: number; nextAllowedAt: string | null; label: string };
    workspace?: PushedIssueWatchDelta | null;
}

export interface ForceRefreshResult {
    refreshed: boolean;
    reason: 'refreshed' | 'cooldown' | 'failed' | 'unavailable';
    /** Only set for `failed` — what went wrong, so it can be shown rather than
     *  summarised into "something went wrong". */
    error?: string;
    cooldown: { seconds: number; nextAllowedAt: string | null; label: string };
}

export interface ForceRefreshDeps {
    workspaceRow?: (
        workspaceId: string,
    ) => { id: string; tynn_project_id?: string | null; [k: string]: unknown } | null;
    /** The recorded Tynn link, when `project.json` carries one. */
    resolveLink?: (row: unknown) => { projectId: string } | null;
    requestRefresh: (tynnProjectId: string) => Promise<TynnRefreshResponse>;
    applyDelta?: (delta: PushedIssueWatchDelta) => void;
}

/** A failure costs nothing — Tynn never charged the window for a request it did
 *  not serve — so the caller may retry immediately. Saying "5 minutes" here
 *  would invent a wait that does not exist. */
const NO_WAIT = { seconds: 0, nextAllowedAt: null, label: 'now' };

/**
 * Tynn answered, but not with a success — the status IS the diagnosis.
 *
 * A class rather than a formatted message, because the status is DATA. The
 * previous shape put it in an `Error` string and the only way to read it back
 * was to re-parse that string, which meant the string had to travel; and the
 * string also carried the endpoint, which is the half a remote reader must not
 * have (CodeQL `js/stack-trace-exposure`, alert #11).
 */
export class TynnRefreshHttpError extends Error {
    constructor(readonly status: number) {
        // The message stays useful in a host-side log and never leaves the
        // desktop — {@link describeRefreshFailure} builds what travels.
        super(`Tynn refused the IssueWatch refresh with HTTP ${status}`);
        this.name = 'TynnRefreshHttpError';
    }
}

/**
 * PURE. What a caller — local or REMOTE — is told about a failed refresh.
 *
 * ## Why this exists rather than a strip at the HTTP boundary
 *
 * `error` reaches a paired remote device through
 * `/api/desktop/issue-watch/force-refresh`, and it used to be
 * `e instanceof Error ? e.message : String(e)` — a Tynn fetch error's own text,
 * which carries the internal hostname on a DNS failure and the endpoint on a
 * status failure.
 *
 * Blanking it at the wire was the other option and is worse twice over. `error`
 * is CONSUMED — `refreshControlState` renders it as the sentence under the
 * Refresh button — so blanking trades a security warning for a vaguer UI. And it
 * would fix only the route CodeQL flagged, leaving the IPC path and every future
 * route to carry the raw text, which is how the alert came to exist.
 *
 * Classifying at the source loses nothing a reader acts on. Exactly two things
 * reach that catch — a transport failure and a non-OK status — and "could not
 * reach Tynn" versus "Tynn answered 503" is the whole of the difference anyone
 * does anything with. It is also what the rest of this file already does: the
 * `unavailable` branch's `error` is a fixed sentence, not exception text.
 *
 * The status number travels because it is actionable (503 is "wait", 401 is
 * "sign in") and is re-formatted from an integer rather than passed through, so
 * no attacker-influenced text can ride along inside it.
 */
export function describeRefreshFailure(e: unknown): string {
    const status =
        e instanceof TynnRefreshHttpError && Number.isInteger(e.status) ? e.status : null;
    if (status !== null && status >= 100 && status <= 599) {
        return `Tynn answered ${status}, so the refresh did not happen. Its own log will say why.`;
    }
    return 'Genie could not reach Tynn, so the refresh did not happen. Check the connection and try again.';
}

export async function forceRefreshWorkspace(
    workspaceId: string,
    deps: ForceRefreshDeps,
): Promise<ForceRefreshResult> {
    const row = (deps.workspaceRow ?? getWorkspace)(workspaceId);
    if (!row) {
        // Asking Tynn to refresh a workspace Genie does not have would either
        // refresh someone else's project or spend a window for nothing.
        return { refreshed: false, reason: 'unavailable', cooldown: { ...NO_WAIT } };
    }

    // Tynn keys IssueWatch by PROJECT. A locally scaffolded envelope mints its
    // own workspace id and records the link in project.json, so the local id is
    // only the right thing to send when no link exists — which is the case for
    // the Add-workspace flow, where `id := project.id` by construction.
    // `resolveTynnLinkForRow` wants the full workspace row; tests inject a
    // narrower shape, so the cast is at the seam rather than in the signature.
    const link = deps.resolveLink
        ? deps.resolveLink(row)
        : resolveTynnLinkForRow(row as Parameters<typeof resolveTynnLinkForRow>[0]);
    const projectId = row.tynn_project_id ?? link?.projectId ?? workspaceId;

    let answer: TynnRefreshResponse;
    try {
        answer = await deps.requestRefresh(projectId);
    } catch (e) {
        // The raw reason is kept where it is useful and cannot travel: this is
        // the desktop's own log. `describeRefreshFailure` builds what a caller —
        // including a paired remote device — is told.
        console.warn('[issue-watch] force refresh failed:', e);
        return {
            refreshed: false,
            reason: 'failed',
            error: describeRefreshFailure(e),
            cooldown: { ...NO_WAIT },
        };
    }

    // A refusal still carries real state, so the snapshot is applied either way:
    // the caller asked a reasonable question and deserves the current answer.
    // Nothing is applied when Tynn sent no workspace payload — a fabricated
    // empty snapshot would wipe real issues out of the panel.
    if (answer.workspace) (deps.applyDelta ?? applyPushedDelta)(answer.workspace);

    return {
        refreshed: answer.refreshed,
        reason: answer.reason,
        cooldown: answer.cooldown,
    };
}

/* ── the wired entry point ───────────────────────────────────────────────── */

/**
 * The session-bound transport, registered once at startup.
 *
 * Genie authenticates to Tynn's user API with the DESKTOP's session cookies, and
 * `session.defaultSession.fetch` only exists in the main process after the app is
 * ready — so it is injected rather than imported, exactly as the IssueWatch
 * channel already does. Unregistered means "not signed in yet", which is an
 * `unavailable` answer rather than a crash.
 */
let transport: { fetchImpl: typeof fetch; apiBaseUrl: () => string } | null = null;

export function setIssueWatchRefreshTransport(
    t: { fetchImpl: typeof fetch; apiBaseUrl: () => string } | null,
): void {
    transport = t;
}

/**
 * Ask Tynn to refresh THIS workspace now. The entry point `checkIssues(refresh)`
 * and the UI button both call.
 */
export async function requestIssueWatchRefresh(workspaceId: string): Promise<ForceRefreshResult> {
    if (!transport) {
        return {
            refreshed: false,
            reason: 'unavailable',
            error: 'Genie is not signed in to Tynn, so IssueWatch cannot be refreshed.',
            cooldown: { ...NO_WAIT },
        };
    }
    const { fetchImpl, apiBaseUrl } = transport;
    return forceRefreshWorkspace(workspaceId, {
        requestRefresh: async (projectId) => {
            const base = apiBaseUrl().replace(/\/+$/, '');
            const res = await fetchImpl(`${base}/api/v1/user/issue-watch/refresh`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ project_id: projectId }),
            });
            // A refusal is a 200 carrying `refreshed: false` — Tynn only uses a
            // non-2xx for a request it could not serve at all, which is the
            // distinction the caller needs.
            if (!res.ok) {
                // The endpoint and status text stay on THIS machine; only the
                // status number travels (see `describeRefreshFailure`).
                console.warn(
                    `[issue-watch] Tynn POST /api/v1/user/issue-watch/refresh -> ${res.status} ${res.statusText}`.trim(),
                );
                throw new TynnRefreshHttpError(res.status);
            }
            return (await res.json()) as TynnRefreshResponse;
        },
    });
}

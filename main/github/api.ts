import { net } from 'electron';
import {
    getAccessExpiryMs,
    getClientId,
    getRefreshExpiryMs,
    getRefreshToken,
    getToken,
    getUsername,
    markReauthNeeded,
    saveTokenSet,
} from './storage';
import { refreshUserToken } from './device-flow';
import { genieInstallUrl } from '../config';

/**
 * Thin GitHub API client. Uses the token in safeStorage; throws
 * GitHubAuthError when the user hasn't connected yet so callers can
 * route to the connect flow.
 */

const API_BASE = 'https://api.github.com';

export class GitHubAuthError extends Error {
    constructor() {
        super('No GitHub token. Connect a GitHub account in Settings first.');
        this.name = 'GitHubAuthError';
    }
}

export class GitHubApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'GitHubApiError';
    }
}

/** Skew (ms) before the recorded expiry at which we treat the access token as
 *  already stale, so a request never goes out with a token about to die. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Return a usable access token, refreshing first when the stored one has (or
 * is about to) expire and a refresh token is available. When the App opts out
 * of token expiration there is no recorded expiry and the token is returned
 * as-is. Throws GitHubAuthError (after flagging reauth) when there is no token
 * or the refresh token is itself dead.
 */
async function freshAccessToken(): Promise<string> {
    const token = getToken();
    if (!token) throw new GitHubAuthError();

    const expMs = getAccessExpiryMs();
    if (expMs === null || Date.now() < expMs - EXPIRY_SKEW_MS) {
        return token; // non-expiring, or still comfortably valid
    }
    return refreshOrFail();
}

/** Exchange the refresh token for a new grant, persist it, and return the new
 *  access token. On any failure, flag reauth and surface GitHubAuthError. */
async function refreshOrFail(): Promise<string> {
    const refreshToken = getRefreshToken();
    const refreshExp = getRefreshExpiryMs();
    const refreshDead = refreshExp !== null && Date.now() >= refreshExp;
    if (!refreshToken || refreshDead) {
        markReauthNeeded();
        throw new GitHubAuthError();
    }
    try {
        const next = await refreshUserToken(getClientId(), refreshToken);
        saveTokenSet(
            {
                accessToken: next.access_token,
                refreshToken: next.refresh_token ?? refreshToken,
                expiresInSec: next.expires_in,
                refreshTokenExpiresInSec: next.refresh_token_expires_in,
            },
            getUsername() ?? '',
        );
        return next.access_token;
    } catch {
        markReauthNeeded();
        throw new GitHubAuthError();
    }
}

async function gh<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    retriedAfterAuth = false,
): Promise<T> {
    const token = await freshAccessToken();
    const res = await net.fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Genie/0.7',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    // A 401 means the access token was rejected (e.g. expired earlier than our
    // recorded skew, or revoked). Refresh once and retry before giving up — a
    // second 401 falls through to the normal error path / reauth flag.
    if (res.status === 401 && !retriedAfterAuth && getRefreshToken()) {
        await refreshOrFail();
        return gh<T>(method, path, body, true);
    }
    if (res.status === 204) return null as T;
    const text = await res.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // GitHub sometimes returns HTML on 5xx; fall through with raw text.
    }
    if (res.status === 401) {
        // Unrecoverable here: either no refresh token (a revoked non-expiring
        // token) or a second 401 after refreshing. Flag a reconnect so the UI
        // stops showing a stale "Connected" and the user can re-authorize.
        markReauthNeeded();
    }
    if (!res.ok) {
        // GitHub's top-level `message` is often generic ("Repository
        // creation failed.", "Validation Failed") — the actionable detail
        // is in `errors[]`. Fold those in so the UI shows the real cause
        // (e.g. "name already exists on this account").
        let msg =
            (json && typeof json === 'object' && 'message' in json
                ? String((json as { message: unknown }).message)
                : null) ?? text ?? res.statusText;
        const errs =
            json && typeof json === 'object' && Array.isArray((json as { errors?: unknown }).errors)
                ? ((json as { errors: Array<Record<string, unknown>> }).errors)
                : [];
        const details = errs
            .map((e) => (typeof e.message === 'string' ? e.message : `${e.field ?? ''} ${e.code ?? ''}`.trim()))
            .filter(Boolean);
        if (details.length) msg += ` — ${details.join('; ')}`;
        throw new GitHubApiError(res.status, msg);
    }
    return json as T;
}

/** True when a 422 from repo creation means "this name already exists". */
function isNameExists(e: unknown): boolean {
    return (
        e instanceof GitHubApiError &&
        e.status === 422 &&
        /already exists/i.test(e.message)
    );
}

/**
 * Heuristic: a write that fails because the GitHub App isn't installed on
 * the target account. With a GitHub-App user token, GitHub answers 403
 * (sometimes 404) for an account where the App has no installation — the
 * App simply can't see/act on it. We can't always distinguish this from a
 * genuine permission denial, so we treat 403/404 on a write as "probably
 * not installed" and rewrite the error into an actionable install prompt
 * that the renderer keys off (`code === 'not_installed'`).
 */
function isLikelyNotInstalled(e: unknown): boolean {
    return (
        e instanceof GitHubApiError && (e.status === 403 || e.status === 404)
    );
}

/**
 * Raised when a write (create/fork) fails on an account the App isn't
 * installed on. Carries the install URL + target so the UI can offer a
 * one-click "Install Genie on <account>" instead of dead-ending. The install
 * URL pre-targets `account` when its numeric id is known (so the chooser
 * lands on the right account), and falls back to the plain chooser otherwise.
 */
export class GitHubNotInstalledError extends Error {
    readonly code = 'not_installed';
    constructor(
        public account: string,
        public installUrl: string,
        cause?: GitHubApiError,
    ) {
        super(
            `Genie isn't installed on ${account} — install it: ${installUrl}` +
                (cause ? ` (GitHub said: ${cause.message})` : ''),
        );
        this.name = 'GitHubNotInstalledError';
    }
}

/**
 * Wrap a write error in a not-installed prompt when it looks like the App
 * isn't installed on `account`; otherwise rethrow unchanged. `targetId` is
 * the account's numeric id when known — it pre-targets the install chooser at
 * that exact account (personal OR org), so the install lands where the write
 * needed it instead of defaulting elsewhere.
 */
function asNotInstalled(e: unknown, account: string, targetId?: number | null): never {
    if (isLikelyNotInstalled(e)) {
        throw new GitHubNotInstalledError(
            account,
            genieInstallUrl(targetId),
            e as GitHubApiError,
        );
    }
    throw e;
}

export interface GitHubUser {
    login: string;
    name: string | null;
    avatar_url: string;
}

export interface GitHubOrg {
    login: string;
    avatar_url: string;
}

export async function getViewer(): Promise<GitHubUser> {
    return gh<GitHubUser>('GET', '/user');
}

/** One installation of the GitHub App, as returned by /user/installations. */
interface GhInstallation {
    /**
     * The INSTALLATION's own id — distinct from `account.id`. This is the id in
     * the per-installation review URL (`settings/installations/<id>`), where the
     * owner approves a pending permission update. (account.id is the ACCOUNT id,
     * used for the install chooser's `suggested_target_id`.)
     */
    id?: number;
    account?: {
        id?: number;
        login?: string;
        avatar_url?: string;
        /** 'Organization' | 'User' — distinguishes an org install from a
         *  personal-account install. */
        type?: string;
    };
    /**
     * The permissions GitHub GRANTED this installation, as a map of permission
     * name → access level (`read` | `write` | `admin`). This is what the
     * installation owner approved for the App — narrower than (or equal to) the
     * App's declared permissions, and it's what capability detection reads to
     * decide which GitHub-dependent features Genie can use. (See
     * `main/github/capabilities.ts`.)
     */
    permissions?: Record<string, string>;
}

/**
 * One account where the "Genie IDE" GitHub App is installed — the App-token
 * equivalent of an entry the user can create/fork on. `id` is the account's
 * numeric id (used to pre-target the install chooser); `isOrg` distinguishes
 * an org install from the personal-account install.
 */
export interface GitHubInstallation {
    login: string;
    avatar_url: string;
    id: number | null;
    isOrg: boolean;
    /**
     * The INSTALLATION's own id (NOT the account id in `id`). Keys the
     * per-installation review URL where the owner approves a pending permission
     * update — see `genieInstallationReviewUrl`. Null when GitHub omitted it.
     */
    installationId: number | null;
    /**
     * The permissions GitHub granted this installation (permission name →
     * access level). Drives capability detection — see `capabilities.ts`. Empty
     * object when GitHub didn't include a permissions map for the installation.
     */
    permissions: Record<string, string>;
}

/**
 * List EVERY account where the App is installed — personal AND orgs. This is
 * the source of truth for "where can Genie act"; the connect flow uses it to
 * detect zero/missing installations and drive the user to the install
 * chooser, and the owner picker uses it to know whether the personal account
 * is installed (not just which orgs are).
 *
 * For a GitHub-App user token `/user/orgs` returns an empty list (org
 * membership isn't a granted permission), so we read `/user/installations`
 * and map each installation's `account`.
 */
export async function listInstallations(): Promise<GitHubInstallation[]> {
    const res = await gh<{ installations?: GhInstallation[] }>(
        'GET',
        '/user/installations',
    );
    const installations = Array.isArray(res?.installations)
        ? res.installations
        : [];
    const out: GitHubInstallation[] = [];
    for (const inst of installations) {
        const login = inst.account?.login;
        if (!login) continue;
        out.push({
            login,
            avatar_url: inst.account?.avatar_url ?? '',
            id: inst.account?.id ?? null,
            isOrg: inst.account?.type === 'Organization',
            installationId: inst.id ?? null,
            permissions: inst.permissions ?? {},
        });
    }
    return out;
}

/**
 * Read every installation's GRANTED permission map (permission name → access
 * level). This is the raw input to capability detection: aggregate these (see
 * `capabilities.aggregatePermissions`) to learn the widest access Genie has,
 * then compute which capabilities that does/doesn't satisfy.
 *
 * Reuses {@link listInstallations} (one `/user/installations` read) so the
 * permissions ride along with the install list already fetched everywhere.
 */
export async function readGrantedPermissions(): Promise<Record<string, string>[]> {
    const installs = await listInstallations();
    return installs.map((i) => i.permissions);
}

/**
 * Read every installation WITH its identity (login/id/isOrg) AND its granted
 * permission map. The capability detection needs the identity — not just the
 * permission maps — to tell the user WHICH specific installations are missing a
 * permission (there's no GitHub "approve for all", so each install that lacks
 * the permission must be approved individually). Reuses {@link listInstallations}.
 */
export async function readInstallationGrants(): Promise<GitHubInstallation[]> {
    return listInstallations();
}

/**
 * List the ORG accounts Genie can act on (back-compat for the owner picker,
 * which offers the personal account as the empty-string option separately).
 * Derived from {@link listInstallations}.
 */
export async function listOrgs(): Promise<GitHubOrg[]> {
    const installs = await listInstallations();
    return installs
        .filter((i) => i.isOrg)
        .map((i) => ({ login: i.login, avatar_url: i.avatar_url }));
}

/** The owner of a GitHub repo: login + numeric id + whether it's an org.
 *  Used to default create/fork to the SOURCE repo's account. */
export interface RepoOwner {
    login: string;
    id: number | null;
    isOrg: boolean;
}

/**
 * Resolve the owner of an existing repo (GET /repos/{owner}/{repo}). The
 * create/fork flows use this to target the SAME account the source repo lives
 * in (personal OR org), and to pre-target the install chooser at that account
 * when Genie isn't installed there. Best-effort: returns just the login when
 * the lookup fails (e.g. the App can't see a private source), since the login
 * alone is enough to drive the owner picker.
 */
export async function getRepoOwner(owner: string, repo: string): Promise<RepoOwner> {
    try {
        const r = await gh<{ owner?: { login?: string; id?: number; type?: string } }>(
            'GET',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        );
        return {
            login: r.owner?.login ?? owner,
            id: r.owner?.id ?? null,
            isOrg: r.owner?.type === 'Organization',
        };
    } catch {
        return { login: owner, id: null, isOrg: false };
    }
}

export interface CreateRepoOpts {
    name: string;
    /** Where to create — undefined / null means the authenticated user. */
    owner?: string | null;
    /** Numeric id of `owner`, when known — pre-targets the install chooser at
     *  that account if Genie isn't installed there. */
    ownerId?: number | null;
    description?: string;
    private?: boolean;
}

export interface CreatedRepo {
    full_name: string;
    clone_url: string;
    ssh_url: string;
    html_url: string;
    default_branch: string;
}

/**
 * Create a repo under the authenticated user (POST /user/repos) OR under
 * an org the user can write to (POST /orgs/{org}/repos). GitHub returns
 * the new repo's clone + html URLs which we hand back unchanged.
 */
export async function createRepo(opts: CreateRepoOpts): Promise<CreatedRepo> {
    const body = {
        name: opts.name,
        description: opts.description ?? '',
        private: opts.private ?? true,
        auto_init: false,
    };
    try {
        if (opts.owner) {
            return await gh<CreatedRepo>('POST', `/orgs/${opts.owner}/repos`, body);
        }
        return await gh<CreatedRepo>('POST', '/user/repos', body);
    } catch (e) {
        // A previous run that failed AFTER repo creation (e.g. the local
        // build collided) leaves the repo behind. Reuse it instead of
        // dead-ending the retry — fetch the existing repo and return it.
        // The envelope flow only ever PUSHES an initial commit, and the
        // repo it made earlier is empty, so this is safe.
        if (isNameExists(e)) {
            const owner = opts.owner || (await getViewer()).login;
            return gh<CreatedRepo>('GET', `/repos/${owner}/${opts.name}`);
        }
        // The App must be installed on the target account to create there.
        // (Creating a PERSONAL repo via an App user token is historically
        // flaky; this turns that failure into an actionable install prompt
        // rather than a crash.) Pre-target the chooser at the owner account
        // when its id is known.
        asNotInstalled(e, opts.owner || (await viewerLogin()), opts.ownerId);
    }
}

/** The authenticated user's login, used to name the personal account in
 *  install prompts. Best-effort — falls back to a generic label. */
async function viewerLogin(): Promise<string> {
    try {
        return (await getViewer()).login;
    } catch {
        return 'your account';
    }
}

export interface ParsedRepoRef {
    owner: string;
    repo: string;
}

/**
 * Pull owner + repo out of a GitHub remote URL (https or ssh). Returns
 * null for non-GitHub or unparseable URLs so callers can fall back to
 * clone/local without offering a fork.
 */
export function parseGitHubRemote(url: string): ParsedRepoRef | null {
    const trimmed = url.trim().replace(/\.git$/i, '').replace(/\/$/, '');
    // git@github.com:owner/repo  |  ssh://git@github.com/owner/repo
    const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/(.+)$/i.exec(trimmed);
    if (ssh) return { owner: ssh[1], repo: ssh[2].split('/').pop()! };
    // https://github.com/owner/repo
    const https = /^https?:\/\/github\.com\/([^/]+)\/(.+)$/i.exec(trimmed);
    if (https) return { owner: https[1], repo: https[2].split('/').pop()! };
    return null;
}

// --- Issue Watch ------------------------------------------------------------

/** A normalized watched item (issue / PR / Dependabot alert) for the feed. */
export interface WatchItem {
    kind: 'issue' | 'pr' | 'dependabot';
    /** Stable key across polls: `<owner>/<repo>:<kind>:<number|ghsa>`. */
    key: string;
    number: number | null;
    title: string;
    url: string;
    /** ISO timestamp used for unread (updated since last seen). */
    updatedAt: string;
    author?: string;
    /** Dependabot severity (low|medium|high|critical). */
    severity?: string;
}

type GhIssue = {
    number: number;
    title: string;
    html_url: string;
    updated_at: string;
    user?: { login?: string };
    pull_request?: unknown; // present ⇒ it's a PR, not an issue
};
type GhPull = {
    number: number;
    title: string;
    html_url: string;
    updated_at: string;
    user?: { login?: string };
};
type GhAlert = {
    number: number;
    html_url?: string;
    updated_at?: string;
    created_at?: string;
    security_advisory?: { summary?: string; ghsa_id?: string };
    security_vulnerability?: { severity?: string };
    dependency?: { package?: { name?: string } };
};

/**
 * Why a repo's watch fetch came back empty. `null` (in {@link FetchOutcome})
 * means the fetch genuinely SUCCEEDED — distinct from a swallowed failure, so
 * the flyout can say "no open issues" only when it's true and otherwise explain
 * why it can't see them. Ordered worst-first by {@link worseError} so the
 * issues read's failure dominates a secondary (PR / Dependabot) failure.
 */
export type WatchFetchError =
    | 'unauthenticated' // no / expired GitHub token (GitHubAuthError)
    | 'forbidden' // 403 — App lacks Issues access on the repo
    | 'not_found' // 404 — no access to the repo (private / not installed)
    | 'rate_limited' // 403/429 with a rate-limit signal
    | 'unknown'; // any other failure

/** Classify a thrown gh() error into a {@link WatchFetchError}. */
export function classifyFetchError(e: unknown): WatchFetchError {
    if (e instanceof GitHubAuthError) return 'unauthenticated';
    if (e instanceof GitHubApiError) {
        // A 401 response = rejected/expired credentials (gh() already flagged
        // reauth). Treat it the same as "not connected" so the flyout routes to
        // Settings rather than reporting a generic error.
        if (e.status === 401) return 'unauthenticated';
        if (e.status === 429) return 'rate_limited';
        if (e.status === 403) {
            // GitHub returns 403 for BOTH a missing permission and a spent rate
            // limit; the message carries "rate limit" only in the latter.
            return /rate limit/i.test(e.message) ? 'rate_limited' : 'forbidden';
        }
        if (e.status === 404) return 'not_found';
    }
    return 'unknown';
}

/**
 * A classified fetch failure PLUS the raw HTTP status + GitHub message behind
 * it. The bucket ({@link WatchFetchError}) drives the flyout's routing
 * (reconnect / install / rate-limit copy); the `status` + `message` let it show
 * the EXACT cause — "GitHub returned 401: Bad credentials" — instead of a vague
 * "unexpected error", which matters most for the `unknown` bucket where the
 * bucket itself says nothing actionable. `null` everywhere means success.
 */
export interface WatchErrorDetail {
    error: WatchFetchError;
    /** Underlying HTTP status when the failure was a {@link GitHubApiError}. */
    status?: number;
    /** GitHub's message (or our auth-error message) for the failure. */
    message?: string;
}

/**
 * Classify a thrown gh() error AND capture its raw HTTP status + message. Pairs
 * with {@link classifyFetchError} (same bucketing) but preserves the precise
 * detail so the renderer can render the actual error rather than a generic one.
 */
export function classifyFetchDetail(e: unknown): WatchErrorDetail {
    const error = classifyFetchError(e);
    if (e instanceof GitHubApiError) {
        return { error, status: e.status, message: e.message };
    }
    if (e instanceof GitHubAuthError) {
        return { error, message: e.message };
    }
    if (e instanceof Error) {
        return { error, message: e.message };
    }
    return { error };
}

/** Severity ranking — a lower index is a worse (more actionable) failure. The
 *  issues read drives the surfaced status, so its outcome wins over a secondary
 *  PR / Dependabot failure of equal-or-lesser severity. */
const ERROR_RANK: WatchFetchError[] = [
    'unauthenticated',
    'forbidden',
    'not_found',
    'rate_limited',
    'unknown',
];

/** The worse of two fetch errors (null = success, always loses). */
export function worseError(
    a: WatchFetchError | null,
    b: WatchFetchError | null,
): WatchFetchError | null {
    if (a === null) return b;
    if (b === null) return a;
    return ERROR_RANK.indexOf(a) <= ERROR_RANK.indexOf(b) ? a : b;
}

/** A best-effort GET's outcome: the rows, plus the failure detail (null = ok). */
interface ListOutcome<T> {
    items: T[];
    /** Full failure detail (bucket + raw status/message), null on success. */
    detail: WatchErrorDetail | null;
}

/**
 * Best-effort GET that returns [] on any error (e.g. feature disabled, 404),
 * but PRESERVES why it failed (bucket + raw HTTP status/message) so callers can
 * distinguish "no items" from "couldn't read" AND show the exact cause. The
 * detail is `null` only on a genuine success.
 */
async function ghListOutcome<T>(path: string): Promise<ListOutcome<T>> {
    try {
        const r = await gh<T[]>('GET', path);
        return { items: Array.isArray(r) ? r : [], detail: null };
    } catch (e) {
        return { items: [], detail: classifyFetchDetail(e) };
    }
}

/**
 * The normalized items for a repo plus why the read was empty. `error` is the
 * surfaced bucket (null = ok); `detail` carries the raw HTTP status + GitHub
 * message for that same failure so the flyout can show the precise cause. Both
 * are null on a genuine success.
 */
export interface FetchOutcome {
    items: WatchItem[];
    /** Worst failure across the three reads, weighted to the issues read; null
     *  when the issues read succeeded (PR / Dependabot failures are secondary
     *  and never surface a status on their own). */
    error: WatchFetchError | null;
    /** The raw detail (HTTP status + message) behind {@link error}, or null. */
    detail: WatchErrorDetail | null;
}

/**
 * Fetch a repo's open Issues, PRs, and Dependabot alerts as normalized
 * WatchItems WITH the read's outcome. Each category is fetched independently
 * and degrades to [] on error so one disabled feature (e.g. Dependabot off)
 * doesn't sink the rest — but the failure CLASS is preserved so a silent-empty
 * feed can explain itself.
 *
 * The surfaced `error` is the ISSUES read's failure when it failed (that's the
 * one users care about: "why don't I see my issues?"). A PR or Dependabot
 * failure on its own is secondary and does NOT surface a status — a Dependabot
 * 403 (alerts feature off / no security access) must never mask a working
 * issues read.
 */
export async function fetchRepoWatchItemsResult(
    owner: string,
    repo: string,
): Promise<FetchOutcome> {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const [issues, pulls, alerts] = await Promise.all([
        ghListOutcome<GhIssue>(`${base}/issues?state=open&per_page=50&sort=updated`),
        ghListOutcome<GhPull>(`${base}/pulls?state=open&per_page=50&sort=updated`),
        ghListOutcome<GhAlert>(`${base}/dependabot/alerts?state=open&per_page=50`),
    ]);
    // The issues read is the important one. When IT fails, surface that (and the
    // detail behind it). A secondary PR/Dependabot failure of unauthenticated/
    // rate-limited severity (which affects every read, not just one feature) can
    // still escalate — and bring its OWN detail along, since it's now the
    // surfaced failure — but a lone forbidden/not_found on PRs or a Dependabot
    // failure stays quiet.
    let detail = issues.detail;
    if (detail === null) {
        for (const sec of [pulls.detail, alerts.detail]) {
            if (sec && (sec.error === 'unauthenticated' || sec.error === 'rate_limited')) {
                detail = sec;
            }
        }
    }
    const items = buildWatchItems(owner, repo, issues.items, pulls.items, alerts.items);
    return { items, error: detail?.error ?? null, detail };
}

/** Normalize the three raw GitHub lists into WatchItems (newest-agnostic). */
function buildWatchItems(
    owner: string,
    repo: string,
    issuesRaw: GhIssue[],
    pullsRaw: GhPull[],
    alertsRaw: GhAlert[],
): WatchItem[] {
    const slug = `${owner}/${repo}`;
    const items: WatchItem[] = [];
    for (const i of issuesRaw) {
        if (i.pull_request) continue; // the issues endpoint also returns PRs
        items.push({
            kind: 'issue',
            key: `${slug}:issue:${i.number}`,
            number: i.number,
            title: i.title,
            url: i.html_url,
            updatedAt: i.updated_at,
            author: i.user?.login,
        });
    }
    for (const p of pullsRaw) {
        items.push({
            kind: 'pr',
            key: `${slug}:pr:${p.number}`,
            number: p.number,
            title: p.title,
            url: p.html_url,
            updatedAt: p.updated_at,
            author: p.user?.login,
        });
    }
    for (const a of alertsRaw) {
        const ghsa = a.security_advisory?.ghsa_id ?? String(a.number);
        items.push({
            kind: 'dependabot',
            key: `${slug}:dependabot:${ghsa}`,
            number: a.number ?? null,
            title:
                a.security_advisory?.summary ??
                `Vulnerability in ${a.dependency?.package?.name ?? 'a dependency'}`,
            url:
                a.html_url ??
                `https://github.com/${slug}/security/dependabot/${a.number}`,
            updatedAt: a.updated_at ?? a.created_at ?? new Date(0).toISOString(),
            severity: a.security_vulnerability?.severity,
        });
    }
    return items;
}

export interface ForkRepoOpts {
    /** Source repo to fork. */
    owner: string;
    repo: string;
    /** Org to fork INTO. Undefined/null = fork into the authenticated user. */
    intoOrg?: string | null;
    /** Numeric id of `intoOrg`, when known — pre-targets the install chooser
     *  at that account if Genie isn't installed there. */
    intoOrgId?: number | null;
    /** Optional rename of the fork (GitHub keeps the source name by default). */
    name?: string;
}

/**
 * Fork an existing GitHub repo (POST /repos/{owner}/{repo}/forks). The
 * fork is created asynchronously on GitHub's side, but the API returns
 * the fork object immediately with its clone URLs — usable as a submodule
 * source right away (git clone retries while GitHub finishes copying).
 *
 * Forks back Teams/Agents workflows: each actor forks the canonical repo
 * (or the whole {slug}.agi envelope) into their own account/org, works
 * there, and PRs back. The `intoOrg` + rename knobs make a fork land
 * exactly where the caller's owner picker chose.
 */
export async function forkRepo(opts: ForkRepoOpts): Promise<CreatedRepo> {
    const body: Record<string, unknown> = { default_branch_only: false };
    if (opts.intoOrg) body.organization = opts.intoOrg;
    if (opts.name) body.name = opts.name;
    try {
        return await gh<CreatedRepo>(
            'POST',
            `/repos/${opts.owner}/${opts.repo}/forks`,
            body,
        );
    } catch (e) {
        // A fork lands under the destination account; if the App isn't
        // installed there it can't write the fork. Surface an install
        // prompt for that account, pre-targeted by id when known.
        asNotInstalled(e, opts.intoOrg || (await viewerLogin()), opts.intoOrgId);
    }
}

import { net } from 'electron';
import { getToken } from './storage';

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

async function gh<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
): Promise<T> {
    const token = getToken();
    if (!token) throw new GitHubAuthError();
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
    if (res.status === 204) return null as T;
    const text = await res.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // GitHub sometimes returns HTML on 5xx; fall through with raw text.
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

export interface GitHubUser {
    login: string;
    name: string | null;
    avatar_url: string;
}

export interface GitHubOrg {
    login: string;
    avatar_url: string;
    /** True when the authenticated user can create repos in this org. */
    can_create_repository?: boolean;
}

export async function getViewer(): Promise<GitHubUser> {
    return gh<GitHubUser>('GET', '/user');
}

export async function listOrgs(): Promise<GitHubOrg[]> {
    return gh<GitHubOrg[]>('GET', '/user/orgs');
}

export interface CreateRepoOpts {
    name: string;
    /** Where to create — undefined / null means the authenticated user. */
    owner?: string | null;
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
        throw e;
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

/** Best-effort GET that returns [] on any error (e.g. feature disabled, 404). */
async function ghListSafe<T>(path: string): Promise<T[]> {
    try {
        const r = await gh<T[]>('GET', path);
        return Array.isArray(r) ? r : [];
    } catch {
        return [];
    }
}

/**
 * Fetch a repo's open Issues, PRs, and Dependabot alerts as normalized
 * WatchItems. Each category is fetched independently and degrades to [] on
 * error so one disabled feature (e.g. Dependabot off) doesn't sink the rest.
 */
export async function fetchRepoWatchItems(
    owner: string,
    repo: string,
): Promise<WatchItem[]> {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const [issuesRaw, pullsRaw, alertsRaw] = await Promise.all([
        ghListSafe<GhIssue>(`${base}/issues?state=open&per_page=50&sort=updated`),
        ghListSafe<GhPull>(`${base}/pulls?state=open&per_page=50&sort=updated`),
        ghListSafe<GhAlert>(`${base}/dependabot/alerts?state=open&per_page=50`),
    ]);
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
    return gh<CreatedRepo>(
        'POST',
        `/repos/${opts.owner}/${opts.repo}/forks`,
        body,
    );
}

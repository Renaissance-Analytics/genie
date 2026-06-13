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
        const msg =
            (json && typeof json === 'object' && 'message' in json
                ? String((json as { message: unknown }).message)
                : null) ?? text ?? res.statusText;
        throw new GitHubApiError(res.status, msg);
    }
    return json as T;
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
    if (opts.owner) {
        return gh<CreatedRepo>('POST', `/orgs/${opts.owner}/repos`, body);
    }
    return gh<CreatedRepo>('POST', '/user/repos', body);
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

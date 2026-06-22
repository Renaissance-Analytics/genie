import { app, session, shell } from 'electron';
import { getAllSettings } from '../db';
import type {
    Backend,
    BackendCaptureResult,
    BackendInbox,
    BackendProject,
    BackendUser,
} from './backend';

/**
 * Tynn backend — talks to a Tynn-hosted instance (defaults to
 * https://tynn.ai) using the user's web session cookie. Cookies live in
 * Electron's default `session`, dropped there by the `genie://` callback
 * flow handled in main/auth.ts.
 */
export class TynnAuthError extends Error {
    constructor(public status: number) {
        super(`Tynn returned ${status} — sign-in required`);
        this.name = 'TynnAuthError';
    }
}

interface TynnFetchOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
}

/**
 * Default Tynn host depends on whether Genie is running packaged
 * (production install) or from `npm run dev`. Packaged installs talk
 * to the public Tynn at tynn.ai; dev sessions talk to the local Herd
 * site at tynn.test that's serving the _app/ source. A user setting
 * overrides both for self-hosted / staging cases.
 */
function defaultTynnHost(): string {
    return app.isPackaged ? 'https://tynn.ai' : 'https://tynn.test';
}

export class TynnBackend implements Backend {
    readonly kind = 'tynn' as const;

    host(): string {
        const override = getAllSettings().tynn_host?.trim();
        return override || defaultTynnHost();
    }

    async whoami(): Promise<BackendUser | null> {
        try {
            const u = await this.fetch<{ id: string; name: string; email: string }>(
                '/api/v1/me',
            );
            return { backend: 'tynn', id: u.id, name: u.name, email: u.email };
        } catch {
            return null;
        }
    }

    async listProjects(): Promise<BackendProject[]> {
        try {
            const data = await this.fetch<
                | {
                      data: Array<{
                          id: string;
                          name: string;
                          slug: string;
                          owner_type?: string;
                          owner_name?: string;
                          base_url?: string;
                      }>;
                  }
                | Array<{
                      id: string;
                      name: string;
                      slug: string;
                      owner_type?: string;
                      owner_name?: string;
                      base_url?: string;
                  }>
            >('/api/v1/projects');
            const rows = Array.isArray(data) ? data : data.data;
            return rows.map((p) => ({
                backend: 'tynn' as const,
                id: p.id,
                name: p.name,
                slug: p.slug,
                owner_type: p.owner_type,
                owner_name: p.owner_name,
                base_url: p.base_url,
            }));
        } catch {
            return [];
        }
    }

    /**
     * Mint an MCP agent token for a project the signed-in user maintains
     * (POST /api/v1/projects/agent-token). Rides the web session cookie like
     * every other call here. Returns the one-time token + the MCP endpoint URL
     * Genie writes into the workspace .mcp.json. Throws TynnAuthError when the
     * session is dead (caller re-signs-in) and a plain Error on 403/other.
     */
    async mintAgentToken(projectId: string): Promise<{
        token: string;
        mcpUrl: string;
        scopes: string[];
        isOpsProject: boolean;
        agent: { id: string; name: string };
    }> {
        const data = await this.fetch<{
            token: string;
            mcp_url: string;
            scopes: string[];
            is_ops_project: boolean;
            agent: { id: string; name: string };
        }>('/api/v1/projects/agent-token', {
            method: 'POST',
            body: { project_id: projectId },
        });
        return {
            token: data.token,
            mcpUrl: data.mcp_url,
            scopes: data.scopes ?? [],
            isOpsProject: !!data.is_ops_project,
            agent: data.agent,
        };
    }

    /**
     * For an Ops project, the projects it governs (POST /api/v1/projects/
     * ops-slaves). Genie maps each slave to a local workspace to resolve its
     * `*.agi` repo. Returns {isOpsProject:false, slaves:[]} for non-Ops.
     */
    async opsSlaves(projectId: string): Promise<{
        isOpsProject: boolean;
        slaves: Array<{
            id: string;
            name: string;
            slug: string;
            owner_name: string | null;
            owner_slug: string | null;
            base_url?: string;
        }>;
    }> {
        try {
            const data = await this.fetch<{
                is_ops_project: boolean;
                slaves: Array<{
                    id: string;
                    name: string;
                    slug: string;
                    owner_name: string | null;
                    owner_slug: string | null;
                    base_url?: string;
                }>;
            }>('/api/v1/projects/ops-slaves', {
                method: 'POST',
                body: { project_id: projectId },
            });

            return { isOpsProject: !!data.is_ops_project, slaves: data.slaves ?? [] };
        } catch {
            return { isOpsProject: false, slaves: [] };
        }
    }

    async captureWish(
        projectId: string,
        content: string,
    ): Promise<BackendCaptureResult> {
        const data = await this.fetch<{ id: string }>('/api/v1/wishes', {
            method: 'POST',
            body: {
                project_id: projectId,
                title: content.slice(0, 120),
                description: content.length > 120 ? content : undefined,
            },
        });
        return { backend: 'tynn', id: data.id };
    }

    async fetchInbox(): Promise<BackendInbox> {
        try {
            const data = await this.fetch<{
                count: number;
                events: Array<{
                    id: string;
                    kind: string;
                    actor: string;
                    subject: string;
                    url: string;
                    when: string;
                }>;
            }>('/api/v1/me/inbox');
            return {
                backend: 'tynn',
                count: data.count ?? 0,
                events: (data.events ?? []).map((e) => ({
                    ...e,
                    url: e.url.startsWith('http') ? e.url : this.host() + e.url,
                })),
            };
        } catch {
            return { backend: 'tynn', count: 0, events: [] };
        }
    }

    openInBrowser(pathOrUrl: string): void {
        const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.host() + pathOrUrl;
        shell.openExternal(url);
    }

    async signOut(): Promise<void> {
        const host = this.host();
        const cookies = await session.defaultSession.cookies.get({ url: host });
        for (const c of cookies) {
            const cookieUrl = `${c.secure ? 'https' : 'http'}://${c.domain?.replace(/^\./, '') ?? new URL(host).host}${c.path ?? '/'}`;
            try {
                await session.defaultSession.cookies.remove(cookieUrl, c.name);
            } catch {
                /* best effort */
            }
        }
    }

    private async getCsrf(): Promise<string | null> {
        try {
            const cookies = await session.defaultSession.cookies.get({
                url: this.host(),
                name: 'XSRF-TOKEN',
            });
            const v = cookies[0]?.value;
            return v ? decodeURIComponent(v) : null;
        } catch {
            return null;
        }
    }

    private async fetch<T>(path: string, opts: TynnFetchOptions = {}): Promise<T> {
        const url = this.host() + path;
        const method = opts.method ?? 'GET';
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            ...(opts.headers ?? {}),
        };
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        if (method !== 'GET') {
            const csrf = await this.getCsrf();
            if (csrf) headers['X-XSRF-TOKEN'] = csrf;
        }
        // Use Electron's session-bound fetch so the cookies stored in
        // session.defaultSession (genie_token after callback, laravel_session
        // after exchange, XSRF-TOKEN, etc.) ride along automatically. The
        // global `fetch` in Electron's main process is Node undici and
        // ignores Electron's cookie store — that's why the genie_token
        // exchange silently 401'd before.
        const res = await session.defaultSession.fetch(url, {
            method,
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        if (res.status === 401 || res.status === 419) {
            throw new TynnAuthError(res.status);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Tynn ${method} ${path} → ${res.status} ${text}`);
        }
        if (res.status === 204) return null as T;
        return (await res.json()) as T;
    }
}

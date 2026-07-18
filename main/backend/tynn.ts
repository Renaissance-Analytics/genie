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

/** Source of a member's entitlement to a Virtual Workstation (resolved Tynn-side). */
export type WorkstationEntitlementSource = 'owner' | 'grant' | 'invite';

/** A Virtual Workstation the signed-in member may connect to — a row of
 *  `GET /workstations/connectable`. `connectable` is true only when the
 *  workstation is active AND the member is entitled; non-entitled rows carry
 *  null capability/source. */
export interface ConnectableWorkstation {
    id: string;
    name: string;
    status: string;
    is_local: boolean;
    relay_endpoint: string;
    connectable: boolean;
    capability: string | null;
    scopes: string[];
    source: WorkstationEntitlementSource | null;
}

/** The minted connect grant from `POST /workstations/{id}/connect-grant`.
 *  `token` is the short-TTL EdDSA JWS to present in the relay `member-hello`;
 *  capability/scope are resolved SERVER-side (no client self-escalation). */
export interface WorkstationConnectGrant {
    token: string;
    workstation_id: string;
    relay_endpoint: string;
    /** Enrolled host Ed25519 SPKI DER (base64), pinned by Tynn for site E2E. */
    host_public_key: string;
    capability: string;
    scopes: string[];
    source: WorkstationEntitlementSource;
    /** ISO-8601 expiry. */
    expires_at: string | null;
    /** Seconds between heartbeat introspections the member should run. */
    heartbeat_interval: number;
    /** PoP confirmation echo (informational): the JWK thumbprint Tynn bound the
     *  grant to (`cnf.jkt`), derived from the `pop_jwk` we sent. */
    cnf?: { jkt: string };
}

/** The heartbeat revocation check from `POST /api/v1/workstations/grants/introspect`. */
export interface WorkstationGrantIntrospection {
    active: boolean;
    revoked?: boolean;
    expired?: boolean;
    workstation_locked?: boolean;
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
     * Owners the signed-in user may create a project under, for Genie's
     * "Create new project" form (GET /api/v1/projects/owner-options). Always
     * "Personal" first, then the user's orgs/teams. Returns [] when the session
     * is dead or the call fails — the form falls back to personal-only.
     */
    async ownerOptions(): Promise<
        Array<{ kind: 'user' | 'organization' | 'team'; id: string; label: string }>
    > {
        try {
            const data = await this.fetch<{
                data: Array<{
                    kind: 'user' | 'organization' | 'team';
                    id: string;
                    label: string;
                }>;
            }>('/api/v1/projects/owner-options');
            return data.data ?? [];
        } catch {
            return [];
        }
    }

    /**
     * Create a Tynn project from Genie's "Create new project" form
     * (POST /api/v1/projects). Rides the web session cookie. Defaults to the
     * user's personal account when no owner is given. Returns the new project
     * in the same shape listProjects() yields so Genie can use it directly as a
     * workspace's associated project. Throws TynnAuthError on a dead session
     * and a plain Error on 403 (owner not permitted) / 422 (validation).
     */
    async createProject(input: {
        name: string;
        owner_type?: 'user' | 'organization' | 'team';
        owner_id?: string;
        slug?: string;
    }): Promise<BackendProject> {
        const data = await this.fetch<{
            data: {
                id: string;
                name: string;
                slug: string;
                owner_type?: string;
                owner_name?: string;
                base_url?: string;
            };
        }>('/api/v1/projects', {
            method: 'POST',
            body: {
                name: input.name,
                owner_type: input.owner_type,
                owner_id: input.owner_id,
                slug: input.slug,
            },
        });
        const p = data.data;
        return {
            backend: 'tynn',
            id: p.id,
            name: p.name,
            slug: p.slug,
            owner_type: p.owner_type,
            owner_name: p.owner_name,
            base_url: p.base_url,
        };
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

    // --- Local Workstation (self-register + enroll) ------------------------

    /**
     * Self-register THIS machine as a Tynn Workstation (POST /api/v1/workstations/
     * self-register) — session-authed, FREE + uncapped (no GCC spawn; design brief
     * genie-service-separation §2a). Returns the workstation row + a one-time
     * enrollment grant (`workstation_id`, `secret`, `expires_at`) to complete with
     * `enrollWorkstation`. Throws TynnAuthError on a dead session.
     */
    async selfRegisterWorkstation(name: string): Promise<{
        workstation: { id: string; name: string; status: string };
        enrollment: { workstation_id: string; secret: string; expires_at: string | null };
    }> {
        return this.fetch<{
            workstation: { id: string; name: string; status: string };
            enrollment: { workstation_id: string; secret: string; expires_at: string | null };
        }>('/api/v1/workstations/self-register', {
            method: 'POST',
            body: { name },
        });
    }

    /**
     * Complete enrollment by presenting the one-time secret + this host's Ed25519
     * PUBLIC key (POST /api/v1/workstations/{id}/enroll), which flips the
     * workstation Active. `hostPublicKeyB64` is the SPKI DER, base64 (exactly what
     * the GCC enrolls for a cloud host). Rides the session cookie. Throws
     * TynnAuthError on a dead session and a plain Error on 403/410/422.
     */
    async enrollWorkstation(
        id: string,
        enrollmentSecret: string,
        hostPublicKeyB64: string,
        fingerprint?: string,
    ): Promise<{ workstation: { id: string; name: string; status: string } }> {
        return this.fetch<{ workstation: { id: string; name: string; status: string } }>(
            `/api/v1/workstations/${encodeURIComponent(id)}/enroll`,
            {
                method: 'POST',
                body: {
                    enrollment_secret: enrollmentSecret,
                    host_public_key: hostPublicKeyB64,
                    host_fingerprint: fingerprint,
                },
            },
        );
    }

    /**
     * The PUBLIC broadcast app key + cluster this Tynn broadcasts over (GET
     * /api/v1/broadcasting-config) — the SAME Pusher app key Tynn's own web bundle
     * already ships (`VITE_PUSHER_APP_KEY`; a Pusher app key is public, it rides
     * every browser). A local workstation reads it to subscribe to its own channel
     * without any build-time config. Returns null on any failure (endpoint absent /
     * dead session), so the IssueWatch push simply stays off.
     *
     * TODO(genie-service-separation §2a): this endpoint is the pending SERVER-side
     * piece — until Tynn ships it this yields null and the local client falls back
     * to the GENIE_PUSHER_APP_KEY env override (dev / self-host). Wiring it here now
     * means the day Tynn deploys `/api/v1/broadcasting-config` a local Genie picks
     * up the push path with zero client changes.
     */
    async fetchBroadcastConfig(): Promise<{ key: string; cluster: string } | null> {
        try {
            const data = await this.fetch<{ key?: string; cluster?: string }>(
                '/api/v1/broadcasting-config',
            );
            return data.key ? { key: data.key, cluster: data.cluster || 'us2' } : null;
        } catch {
            return null;
        }
    }

    /**
     * The user's FMS feature toggles (GET /api/v1/features) — the per-account
     * entitlements that gate the connected services (AgentInbox, IssueWatch) on
     * top of the free local host. Returns both OFF on a dead session / failure, so
     * a missing/unreachable Tynn simply leaves the connected services off.
     */
    async fetchFeatures(): Promise<{ issuewatch: boolean; agentinbox: boolean }> {
        try {
            const data = await this.fetch<{
                features?: { issuewatch?: boolean; agentinbox?: boolean };
            }>('/api/v1/features');
            return {
                issuewatch: !!data.features?.issuewatch,
                agentinbox: !!data.features?.agentinbox,
            };
        } catch {
            return { issuewatch: false, agentinbox: false };
        }
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
            // GitHub owner + name of the slave's PRIMARY repo, when registered.
            // Genie prefers these for the `*.agi` clone URL (the envelope lives at
            // github.com/<repo_owner>/<repo_name>.agi, not owner_slug + slug).
            repo_owner: string | null;
            repo_name: string | null;
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
                    repo_owner: string | null;
                    repo_name: string | null;
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

    // --- Virtual Workstations (member-facing) ------------------------------

    /**
     * The Virtual Workstations the signed-in member may connect to (GET
     * /workstations/connectable) — owner/admin, a live grant, or an accepted
     * invite. Session-cookie web endpoint (not /api/v1). Returns [] on a dead
     * session or failure; the Hosts picker just shows no workstations.
     */
    async listConnectableWorkstations(): Promise<ConnectableWorkstation[]> {
        try {
            const data = await this.fetch<{ workstations: ConnectableWorkstation[] }>(
                '/workstations/connectable',
            );
            return data.workstations ?? [];
        } catch {
            return [];
        }
    }

    /**
     * Mint a fresh short-TTL connect grant for an entitled member (POST
     * /workstations/{id}/connect-grant — the session identifies the member).
     * `popJwk` is the ephemeral public key (RFC 8037 OKP) the member proves
     * possession of (P4.5); Tynn binds the grant to its thumbprint (`cnf.jkt`),
     * so a leaked grant can't be replayed without the private key. Returns the
     * JWS + relay endpoint to dial. Throws TynnAuthError on a dead session, and a
     * plain Error on 403 (not entitled) / 500 (workstation not active).
     */
    async connectGrant(
        workstationId: string,
        popJwk?: unknown,
    ): Promise<WorkstationConnectGrant> {
        return this.fetch<WorkstationConnectGrant>(
            `/workstations/${encodeURIComponent(workstationId)}/connect-grant`,
            { method: 'POST', body: popJwk === undefined ? undefined : { pop_jwk: popJwk } },
        );
    }

    /**
     * The grant heartbeat / revocation check (POST /api/v1/workstations/grants/
     * introspect) — a public, signed-token-gated stateless endpoint the member
     * polls every `heartbeat_interval` to keep the session warm and detect
     * revocation/lock/expiry. A non-200 (401 bad signature / 404 unknown grant)
     * means the grant is no longer usable → reported as inactive.
     */
    async introspectGrant(token: string): Promise<WorkstationGrantIntrospection> {
        try {
            const data = await this.fetch<WorkstationGrantIntrospection>(
                '/api/v1/workstations/grants/introspect',
                { method: 'POST', body: { token } },
            );
            return { ...data, active: !!data.active };
        } catch {
            return { active: false };
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

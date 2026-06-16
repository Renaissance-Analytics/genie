import { shell } from 'electron';
import { getAionimaConfig, setAionimaConfig } from '../db';
import type {
    Backend,
    BackendCaptureResult,
    BackendInbox,
    BackendProject,
    BackendUser,
} from './backend';

/**
 * Aionima backend — talks to a locally-hosted AGI gateway, defaulting to
 * `http://<configured-ip>:3100`. Uses bearer-token auth: the user pastes
 * a token (or it gets minted via the pairing flow once Civicognita/agi#178
 * lands).
 *
 * Maps to AGI's documented surface (docs/human/api-reference.md):
 *
 *   GET  /api/auth/me         — whoami
 *   GET  /api/projects        — listProjects
 *   POST /api/projects        — used by .agi-envelope register flow
 *   GET  /api/notifications   — fetchInbox
 *
 * Quick capture has no native endpoint yet. captureWish() routes through
 * a chat-session placeholder (also documented at `/api/chat/sessions`) so
 * the global hotkey works in Aionima-only mode today; will swap to a
 * native `POST /api/capture` (or whatever they ship) once Q5.4 is
 * answered on Civicognita/agi#178.
 */
export class AionimaBackend implements Backend {
    readonly kind = 'aionima' as const;

    host(): string {
        return getAionimaConfig().host ?? '';
    }

    private bearer(): string | null {
        return getAionimaConfig().token || null;
    }

    isConfigured(): boolean {
        return !!this.host() && !!this.bearer();
    }

    async whoami(): Promise<BackendUser | null> {
        return (await this.probe()).user;
    }

    /**
     * Like whoami(), but SURFACES the failure reason instead of swallowing it.
     * Used by the Settings "Save + test" flow so a misconfigured host/token
     * shows an actionable message ("Failed to parse URL", "ECONNREFUSED", a 401
     * body, …) rather than a generic "could not reach". whoami() delegates here.
     */
    async probe(): Promise<{ user: BackendUser | null; error?: string }> {
        if (!this.host()) return { user: null, error: 'No Aionima host set.' };
        if (!this.bearer()) return { user: null, error: 'No bearer token set.' };
        try {
            const u = await this.fetch<{
                entityId?: string;
                id?: string;
                displayName?: string;
                name?: string;
                email?: string;
                kind?: string;
            }>('/api/auth/me');
            return {
                user: {
                    backend: 'aionima',
                    id: u.entityId ?? u.id ?? 'unknown',
                    name: u.displayName ?? u.name ?? 'Aionima user',
                    email: u.email,
                    kind: u.kind,
                },
            };
        } catch (e) {
            return {
                user: null,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    async listProjects(): Promise<BackendProject[]> {
        if (!this.isConfigured()) return [];
        try {
            const data = await this.fetch<
                | {
                      projects?: Array<{
                          id?: string;
                          name: string;
                          path?: string;
                          slug?: string;
                      }>;
                  }
                | Array<{
                      id?: string;
                      name: string;
                      path?: string;
                      slug?: string;
                  }>
            >('/api/projects');
            const rows = Array.isArray(data) ? data : (data.projects ?? []);
            return rows.map((p) => ({
                backend: 'aionima' as const,
                id: p.id ?? p.path ?? p.name,
                name: p.name,
                slug: p.slug ?? p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                base_url: p.path,
            }));
        } catch {
            return [];
        }
    }

    /**
     * Captures the content as a chat message addressed to Aion. The body
     * shape is a best guess based on `/api/chat/sessions` — we'll switch
     * to `POST /api/capture` (or whatever native endpoint Aionima ships)
     * once Q5.4 on Civicognita/agi#178 is answered.
     */
    async captureWish(
        projectId: string,
        content: string,
    ): Promise<BackendCaptureResult> {
        if (!this.isConfigured()) {
            throw new Error('Aionima not configured. Set host + token in Settings.');
        }
        const data = await this.fetch<{ id?: string; session_id?: string }>(
            '/api/chat/sessions',
            {
                method: 'POST',
                body: {
                    title: content.slice(0, 60),
                    initial_message: content,
                    project_id: projectId || undefined,
                    origin: 'genie-quick-capture',
                },
            },
        );
        return {
            backend: 'aionima',
            id: data.id ?? data.session_id ?? 'unknown',
        };
    }

    async fetchInbox(): Promise<BackendInbox> {
        if (!this.isConfigured()) {
            return { backend: 'aionima', count: 0, events: [] };
        }
        try {
            const data = await this.fetch<{
                unread?: number;
                items?: Array<{
                    id: string;
                    kind?: string;
                    type?: string;
                    actor?: string;
                    title?: string;
                    subject?: string;
                    url?: string;
                    when?: string;
                    created_at?: string;
                }>;
            }>('/api/notifications?unread=true');
            const items = data.items ?? [];
            return {
                backend: 'aionima',
                count: data.unread ?? items.length,
                events: items.map((n) => ({
                    id: 'aionima:' + n.id,
                    kind: n.kind ?? n.type ?? 'notification',
                    actor: n.actor ?? 'Aionima',
                    subject: n.subject ?? n.title ?? 'Notification',
                    url: n.url ? this.absUrl(n.url) : this.host(),
                    when: n.when ?? n.created_at ?? '',
                })),
            };
        } catch {
            return { backend: 'aionima', count: 0, events: [] };
        }
    }

    openInBrowser(pathOrUrl: string): void {
        shell.openExternal(this.absUrl(pathOrUrl));
    }

    async signOut(): Promise<void> {
        setAionimaConfig({ token: null });
    }

    /**
     * The host with a guaranteed scheme + no trailing slash. Users routinely
     * paste a bare `192.168.0.144:3100` — without a scheme, fetch throws a URL
     * parse error instantly (the "it just flashes and fails" symptom), so we
     * default to http:// (Aionima is a LAN gateway; https is opt-in by typing it).
     */
    private baseUrl(): string {
        let h = this.host().trim().replace(/\/+$/, '');
        if (!h) return '';
        if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
        return h;
    }

    private absUrl(pathOrUrl: string): string {
        if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
        const base = this.baseUrl();
        return base + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
    }

    private async fetch<T>(
        path: string,
        opts: {
            method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
            body?: unknown;
            headers?: Record<string, string>;
        } = {},
    ): Promise<T> {
        const host = this.host();
        if (!host) throw new Error('Aionima host not set.');
        const url = this.absUrl(path);
        const method = opts.method ?? 'GET';
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...(opts.headers ?? {}),
        };
        const token = this.bearer();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

        const res = await fetch(url, {
            method,
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Aionima ${method} ${path} → ${res.status} ${text}`);
        }
        if (res.status === 204) return null as T;
        return (await res.json()) as T;
    }
}

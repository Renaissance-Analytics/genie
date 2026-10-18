/**
 * FEEDBACK TO TYNN (Tynn #760): one POST to `/api/v1/genie/feedback` with the Tynn token Genie already holds — the token
 * twin of Genie 1's session route. Tynn files it as an issue in the project, if the token's person can see it, and stamps
 * it as from Genie. Every refusal comes back as words the window can show; nothing throws.
 */

export interface FeedbackSendPorts {
    /** The Tynn this Genie is signed in to, and its token; `null` = not signed in. */
    readonly credentials: () => { host: string; token: string } | null;
    readonly fetch: (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface FeedbackRequest {
    readonly projectId: string;
    readonly message: string;
    /** Context that makes a report actionable later: Genie's version, the workspace. */
    readonly meta: Readonly<Record<string, string>>;
}

export type FeedbackSent = { ok: true; issueNumber: number | null } | { ok: false; reason: string };

export async function sendFeedback(ports: FeedbackSendPorts, request: FeedbackRequest): Promise<FeedbackSent> {
    const creds = ports.credentials();
    if (creds === null) return { ok: false, reason: 'Genie is not signed in to Tynn.' };
    let res: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
        res = await ports.fetch(`${creds.host.replace(/\/+$/, '')}/api/v1/genie/feedback`, {
            method: 'POST',
            headers: { authorization: `Bearer ${creds.token}`, accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ project_id: request.projectId, message: request.message, meta: request.meta }),
        });
    } catch (error) {
        return { ok: false, reason: `Tynn could not be reached: ${(error as Error).message}` };
    }
    let body: { issue_number?: unknown; error?: unknown } = {};
    try { body = ((await res.json()) ?? {}) as typeof body; } catch { /* a body that is not JSON says nothing more than its status */ }
    if (res.ok) return { ok: true, issueNumber: typeof body.issue_number === 'number' ? body.issue_number : null };
    if (res.status === 403 && body.error === 'project-not-accessible') return { ok: false, reason: 'Tynn says that project is not one you can file into.' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: `Tynn did not accept Genie’s token (HTTP ${res.status}). Sign in to Tynn again in Settings.` };
    if (res.status === 422) return { ok: false, reason: 'There was nothing to send.' };
    return { ok: false, reason: `Tynn answered HTTP ${res.status}.` };
}

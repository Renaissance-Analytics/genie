import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppCredentials } from './backend-credentials';
export interface BackendCallInput { tool?: unknown; args?: unknown; workspaceId?: unknown }
export function createAppHttpHandler(deps: {
    credentials: AppCredentials;
    call: (id: string, input: BackendCallInput) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
    me: (id: string) => unknown;
}) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const send = (status: number, value: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
        };
        const refuse = (status: number, error: string) => send(status, { ok: false, error });
        if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
            return refuse(403, 'Only a local app backend may call this endpoint; browser requests are refused.');
        }
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
        if (!token) return refuse(401, 'A valid app bearer credential is required.');
        const auth = deps.credentials.resolve(token);
        if (!auth.grant) return refuse(401, auth.error!);
        if (req.url === '/app/me' && req.method === 'GET') return send(200, deps.me(auth.grant.appId));
        if (req.url !== '/app/call') return refuse(404, 'Unknown app endpoint.');
        if (req.method !== 'POST') return refuse(405, 'Use POST for app calls.');
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return refuse(415, 'Use application/json.');
        let input: BackendCallInput;
        try {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                size += bytes.length;
                if (size > 64 * 1024) return refuse(413, 'App call exceeds 64 KiB.');
                chunks.push(bytes);
            }
            const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse(400, 'Expected an app call object.');
            input = raw as BackendCallInput;
        } catch { return refuse(400, 'Invalid app call JSON.'); }
        // Grant revocation can happen while the request body is arriving.
        const current = deps.credentials.resolve(token);
        if (!current.grant) return refuse(401, current.error!);
        const result = await deps.call(current.grant.appId, input);
        send(result.ok ? 200 : 403, result);
    };
}

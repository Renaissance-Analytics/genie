import { tynnProjectUrl } from '../core/tynn.js';

/**
 * ONE CALL TO TYNN (§6.1 add from Tynn; §6.9 the optional identity layer): `GET /api/v1/project` with
 * the stored token as a Bearer. The answer is handed back as JSON for `parseTynnProject` to judge;
 * anything that is not 2xx is thrown in Tynn's own words — status and message — so the person sees
 * what Tynn said, not what Genie guessed. No token is its own refusal, before any request.
 */

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function tynnClient(fetchImpl: FetchLike) {
    return {
        project: async (host: string, token: string): Promise<unknown> => {
            if (token.trim().length === 0) throw new Error('sign in to Tynn first: no token is set (Settings → General → Tynn token)');
            const res = await fetchImpl(tynnProjectUrl(host), { headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' } });
            const text = await res.text();
            if (!res.ok) {
                let message = text.slice(0, 200);
                try {
                    const body = JSON.parse(text) as { message?: unknown };
                    if (typeof body.message === 'string') message = body.message;
                } catch {
                    // Not JSON: the raw text is the message.
                }
                throw new Error(`Tynn answered ${res.status}: ${message}`);
            }
            try {
                return JSON.parse(text) as unknown;
            } catch {
                throw new Error(`Tynn answered ${res.status} with something that is not JSON`);
            }
        },
    };
}

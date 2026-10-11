import { describe, expect, it } from 'vitest';
import { tynnClient, type FetchLike } from '../src/main/tynn-client.js';

/**
 * THE ONE CALL TO TYNN (§6.1). Bearer token on the project endpoint; the JSON back for the core to
 * judge; a non-2xx thrown in Tynn's own words (status + message); no token refused before any request.
 */

function fake(status: number, body: string) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => { calls.push({ url, headers: init.headers }); return { ok: status >= 200 && status < 300, status, text: async () => body }; };
    return { fetchImpl, calls };
}

describe('tynnClient.project', () => {
    it('GETs /api/v1/project under the host with the Bearer token and hands back the JSON', async () => {
        const f = fake(200, JSON.stringify({ id: 42, name: 'Tynn.ai', slug: 'tynn' }));
        expect(await tynnClient(f.fetchImpl).project('https://tynn.ai/', ' tok_abc ')).toEqual({ id: 42, name: 'Tynn.ai', slug: 'tynn' });
        expect(f.calls).toEqual([{ url: 'https://tynn.ai/api/v1/project', headers: { Authorization: 'Bearer tok_abc', Accept: 'application/json' } }]);
    });

    it('a non-2xx is thrown in Tynn’s words — status and message — JSON or not', async () => {
        await expect(tynnClient(fake(401, '{"message":"Unauthenticated."}').fetchImpl).project('https://tynn.ai', 'x')).rejects.toThrow('Tynn answered 401: Unauthenticated.');
        await expect(tynnClient(fake(503, '<html>maintenance</html>').fetchImpl).project('https://tynn.ai', 'x')).rejects.toThrow('Tynn answered 503: <html>maintenance</html>');
        await expect(tynnClient(fake(200, 'not json').fetchImpl).project('https://tynn.ai', 'x')).rejects.toThrow(/not JSON/);
    });

    it('no token is refused before any request is made', async () => {
        const f = fake(200, '{}');
        await expect(tynnClient(f.fetchImpl).project('https://tynn.ai', '   ')).rejects.toThrow(/sign in to Tynn first/);
        expect(f.calls).toEqual([]);
    });
});

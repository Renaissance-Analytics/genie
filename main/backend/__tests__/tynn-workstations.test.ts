import { afterEach, describe, expect, it, vi } from 'vitest';
import { session } from 'electron';
import { TynnBackend, TynnAuthError } from '../tynn';

// tynn.ts reads `getAllSettings().tynn_host`; stub it so host() resolves to the
// dev default (https://tynn.test) without touching a real settings DB.
vi.mock('../../db', () => ({ getAllSettings: () => ({}) }));

/**
 * The member-facing Virtual Workstation calls ride the same session-cookie
 * `session.defaultSession.fetch` seam as the rest of the Tynn backend. These
 * lock in the request shapes (paths, method, no-body on connect-grant) and the
 * response mapping the relay member-client + Hosts picker depend on.
 */

interface CapturedRequest {
    url: string;
    method?: string;
    body?: string;
}

function mockFetch(captured: CapturedRequest[], reply: (req: CapturedRequest) => Response) {
    return vi
        .spyOn(session.defaultSession, 'fetch')
        .mockImplementation(async (input: unknown, init?: { method?: string; body?: string }) => {
            const req: CapturedRequest = {
                url: String(input),
                method: init?.method,
                body: init?.body,
            };
            captured.push(req);
            return reply(req);
        });
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

afterEach(() => vi.restoreAllMocks());

describe('TynnBackend.listConnectableWorkstations', () => {
    it('GETs /workstations/connectable and unwraps the list', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () =>
            json({
                workstations: [
                    {
                        id: 'ws1',
                        name: 'Studio',
                        status: 'active',
                        relay_endpoint: 'wss://relay.tynn.ai',
                        connectable: true,
                        capability: 'control',
                        scopes: ['host:all'],
                        source: 'owner',
                    },
                ],
            }),
        );

        const out = await new TynnBackend().listConnectableWorkstations();
        expect(captured[0].url).toBe('https://tynn.test/workstations/connectable');
        expect(captured[0].method ?? 'GET').toBe('GET');
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ id: 'ws1', connectable: true, source: 'owner' });
    });

    it('returns [] when the call fails (dead session / network)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ error: 'unauthenticated' }, 401));
        await expect(new TynnBackend().listConnectableWorkstations()).resolves.toEqual([]);
    });
});

describe('TynnBackend.connectGrant', () => {
    it('POSTs /workstations/{id}/connect-grant with NO body and returns the grant', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () =>
            json(
                {
                    token: 'jws.header.sig',
                    workstation_id: 'ws1',
                    relay_endpoint: 'wss://relay.tynn.ai',
                    capability: 'control',
                    scopes: ['host:all'],
                    source: 'owner',
                    expires_at: '2026-06-30T12:00:00+00:00',
                    heartbeat_interval: 60,
                },
                201,
            ),
        );

        const grant = await new TynnBackend().connectGrant('ws1');
        expect(captured[0].url).toBe('https://tynn.test/workstations/ws1/connect-grant');
        expect(captured[0].method).toBe('POST');
        expect(captured[0].body).toBeUndefined();
        expect(grant.token).toBe('jws.header.sig');
        expect(grant.heartbeat_interval).toBe(60);
    });

    it('throws TynnAuthError on a dead session (401)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ error: 'unauthenticated' }, 401));
        await expect(new TynnBackend().connectGrant('ws1')).rejects.toBeInstanceOf(TynnAuthError);
    });

    it('throws a plain Error on 403 (not entitled)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ error: 'not entitled' }, 403));
        await expect(new TynnBackend().connectGrant('ws1')).rejects.toThrow();
    });
});

describe('TynnBackend.introspectGrant', () => {
    it('POSTs the token to the introspect endpoint and maps active', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () =>
            json({ active: true, revoked: false, expired: false, workstation_locked: false }),
        );

        const out = await new TynnBackend().introspectGrant('jws.header.sig');
        expect(captured[0].url).toBe('https://tynn.test/api/v1/workstations/grants/introspect');
        expect(captured[0].method).toBe('POST');
        expect(JSON.parse(captured[0].body as string)).toEqual({ token: 'jws.header.sig' });
        expect(out.active).toBe(true);
    });

    it('reports inactive for a revoked-but-authentic grant (200 active:false)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ active: false, revoked: true }));
        const out = await new TynnBackend().introspectGrant('jws.header.sig');
        expect(out.active).toBe(false);
        expect(out.revoked).toBe(true);
    });

    it('reports inactive when the endpoint rejects the token (401/404)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ active: false, error: 'invalid_signature' }, 401));
        await expect(new TynnBackend().introspectGrant('bad')).resolves.toEqual({ active: false });
    });
});

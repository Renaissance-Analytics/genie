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
    const impl = async (
        input: string | Request,
        init?: { method?: string; body?: BodyInit | null },
    ): Promise<Response> => {
        const req: CapturedRequest = {
            url: String(input),
            method: init?.method,
            body: typeof init?.body === 'string' ? init.body : undefined,
        };
        captured.push(req);
        return reply(req);
    };
    return vi
        .spyOn(session.defaultSession, 'fetch')
        .mockImplementation(impl as typeof session.defaultSession.fetch);
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

    it('includes pop_jwk in the body when given (P4.5 binding)', async () => {
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
                    expires_at: null,
                    heartbeat_interval: 60,
                    cnf: { jkt: 'thumb123' },
                },
                201,
            ),
        );

        const popJwk = { kty: 'OKP', crv: 'Ed25519', x: 'pubkeyb64url' };
        const grant = await new TynnBackend().connectGrant('ws1', popJwk);
        expect(captured[0].method).toBe('POST');
        expect(JSON.parse(captured[0].body as string)).toEqual({ pop_jwk: popJwk });
        expect(grant.cnf?.jkt).toBe('thumb123');
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

describe('TynnBackend.selfRegisterWorkstation', () => {
    it('POSTs the machine name to self-register and returns the enrollment grant', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () =>
            json(
                {
                    workstation: { id: 'ws-new', name: 'studio-pc', status: 'pending' },
                    enrollment: { workstation_id: 'ws-new', secret: 's3cr3t', expires_at: null },
                },
                201,
            ),
        );

        const out = await new TynnBackend().selfRegisterWorkstation('studio-pc');
        expect(captured[0].url).toBe('https://tynn.test/api/v1/workstations/self-register');
        expect(captured[0].method).toBe('POST');
        expect(JSON.parse(captured[0].body as string)).toEqual({ name: 'studio-pc' });
        expect(out.enrollment).toEqual({ workstation_id: 'ws-new', secret: 's3cr3t', expires_at: null });
    });

    it('throws TynnAuthError on a dead session (401)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ error: 'unauthenticated' }, 401));
        await expect(new TynnBackend().selfRegisterWorkstation('pc')).rejects.toBeInstanceOf(
            TynnAuthError,
        );
    });
});

describe('TynnBackend.enrollWorkstation', () => {
    it('POSTs the secret + SPKI public key (+ fingerprint) to the enroll endpoint', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () =>
            json({ workstation: { id: 'ws-new', name: 'pc', status: 'active' } }),
        );

        const out = await new TynnBackend().enrollWorkstation('ws-new', 's3cr3t', 'SPKIb64', 'fp-hex');
        expect(captured[0].url).toBe('https://tynn.test/api/v1/workstations/ws-new/enroll');
        expect(captured[0].method).toBe('POST');
        expect(JSON.parse(captured[0].body as string)).toEqual({
            enrollment_secret: 's3cr3t',
            host_public_key: 'SPKIb64',
            host_fingerprint: 'fp-hex',
        });
        expect(out.workstation.status).toBe('active');
    });

    it('throws a plain Error on 410 (expired enrollment)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ error: 'expired' }, 410));
        await expect(
            new TynnBackend().enrollWorkstation('ws-new', 'stale', 'SPKIb64'),
        ).rejects.toThrow();
    });
});

describe('TynnBackend.fetchFeatures', () => {
    it('GETs /api/v1/features and maps the FMS toggles', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ features: { issuewatch: true, whisperchat: false } }));

        const out = await new TynnBackend().fetchFeatures();
        expect(captured[0].url).toBe('https://tynn.test/api/v1/features');
        expect(captured[0].method ?? 'GET').toBe('GET');
        expect(out).toEqual({ issuewatch: true, whisperchat: false });
    });

    it('returns both OFF when the call fails (dead session / unreachable Tynn)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ error: 'unauthenticated' }, 401));
        await expect(new TynnBackend().fetchFeatures()).resolves.toEqual({
            issuewatch: false,
            whisperchat: false,
        });
    });
});

describe('TynnBackend.fetchBroadcastConfig', () => {
    it('GETs /api/v1/broadcasting-config and returns the public key + cluster', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ key: 'pk_public', cluster: 'eu' }));

        const out = await new TynnBackend().fetchBroadcastConfig();
        expect(captured[0].url).toBe('https://tynn.test/api/v1/broadcasting-config');
        expect(out).toEqual({ key: 'pk_public', cluster: 'eu' });
    });

    it('defaults the cluster to us2 when only a key is returned', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ key: 'pk_public' }));
        await expect(new TynnBackend().fetchBroadcastConfig()).resolves.toEqual({
            key: 'pk_public',
            cluster: 'us2',
        });
    });

    it('returns null when the endpoint is absent / fails (push stays off)', async () => {
        const captured: CapturedRequest[] = [];
        mockFetch(captured, () => json({ error: 'not found' }, 404));
        await expect(new TynnBackend().fetchBroadcastConfig()).resolves.toBeNull();
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

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC, API_KEY, SUBSCRIPTION } from '../../host-core/crypto/escrow';
import { generateEncryptionKeypair, seal, sodiumReady } from '../../host-core/crypto/sealed-box';
import {
    createManagedCredentialClient,
    isProviderCredentialChange,
    parseCredentialBundle,
    toProviderCredentialChange,
} from '../managed-credential-client';

/**
 * SYNTHETIC KEYS + FAKE CIPHERTEXT ONLY. Every sealed box below was produced in
 * this test from a locally generated keypair; no real credential exists here.
 */

const WS_ID = 'ws-42';
const BASE = 'https://tynn.test';
const AUTH = 'Workstation 1700000000:sig==';
const PREFIX = `${BASE}/api/v1/workstations/${WS_ID}`;

const identity = { workstationId: WS_ID, authHeader: () => AUTH };

beforeAll(async () => {
    await sodiumReady();
});

function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('parseCredentialBundle', () => {
    it('reads the camelCase bundle Tynn serves', async () => {
        const escrow = await generateEncryptionKeypair();
        const ciphertext = await seal('fake-anthropic-0000', escrow.publicKeyB64);

        const bundle = parseCredentialBundle({
            workstationId: WS_ID,
            escrow: {
                publicKey: escrow.publicKeyB64,
                fingerprint: 'abc',
                wrappedPrivateKey: 'AAAA',
            },
            credentials: [
                {
                    id: '01K1',
                    provider: ANTHROPIC,
                    kind: API_KEY,
                    scope: 'account',
                    projectId: null,
                    label: 'Claude Max',
                    sealedTo: 'escrow',
                    ciphertext,
                    updatedAt: '2026-07-25T00:00:00Z',
                },
            ],
        });

        expect(bundle.escrow).toEqual({
            publicKeyB64: escrow.publicKeyB64,
            wrappedPrivateKeyB64: 'AAAA',
        });
        expect(bundle.credentials).toEqual([
            {
                id: '01K1',
                provider: ANTHROPIC,
                kind: API_KEY,
                scope: 'account',
                projectId: null,
                label: 'Claude Max',
                sealedTo: 'escrow',
                ciphertext,
                updatedAt: '2026-07-25T00:00:00Z',
            },
        ]);
    });

    it('carries project scope and a host-sealed marker through', () => {
        const bundle = parseCredentialBundle({
            escrow: { publicKey: 'pk' },
            credentials: [
                {
                    id: 'p1',
                    provider: ANTHROPIC,
                    kind: API_KEY,
                    scope: 'project',
                    projectId: 'proj-9',
                    sealedTo: 'host',
                    ciphertext: 'x'.repeat(80),
                },
            ],
        });

        expect(bundle.credentials[0]).toMatchObject({
            scope: 'project',
            projectId: 'proj-9',
            sealedTo: 'host',
        });
    });

    it('defaults sealedTo to escrow and scope to account when omitted', () => {
        const bundle = parseCredentialBundle({
            escrow: { publicKey: 'pk' },
            credentials: [{ id: 'c', provider: ANTHROPIC, kind: API_KEY, ciphertext: 'y'.repeat(80) }],
        });

        expect(bundle.credentials[0]).toMatchObject({ sealedTo: 'escrow', scope: 'account' });
    });

    it('tolerates a bundle with no escrow copy and no credentials', () => {
        expect(parseCredentialBundle({ escrow: { publicKey: 'pk' } })).toEqual({
            escrow: { publicKeyB64: 'pk', wrappedPrivateKeyB64: null },
            credentials: [],
        });
        expect(parseCredentialBundle(null)).toEqual({
            escrow: { publicKeyB64: '', wrappedPrivateKeyB64: null },
            credentials: [],
        });
    });

    it('drops a credential row missing an id, provider, kind, or ciphertext', () => {
        const bundle = parseCredentialBundle({
            escrow: { publicKey: 'pk' },
            credentials: [
                { provider: ANTHROPIC, kind: API_KEY, ciphertext: 'z'.repeat(80) }, // no id
                { id: 'a', kind: API_KEY, ciphertext: 'z'.repeat(80) }, // no provider
                { id: 'b', provider: ANTHROPIC, ciphertext: 'z'.repeat(80) }, // no kind
                { id: 'c', provider: ANTHROPIC, kind: API_KEY }, // no ciphertext
                'nonsense',
            ],
        });
        expect(bundle.credentials).toEqual([]);
    });
});

describe('createManagedCredentialClient', () => {
    it('publishes ONLY the public key — no client-sent fingerprint', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ fingerprint: 'server-derived' }));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await client.publishEncryptionKey({ publicKeyB64: 'PUBKEY', fingerprint: 'ignored' });

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${PREFIX}/encryption-key`);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).authorization).toBe(AUTH);
        // A fingerprint the server can't verify is worth nothing — Tynn derives it.
        expect(JSON.parse(init.body as string)).toEqual({ publicKey: 'PUBKEY' });
    });

    it('fetches the bundle from the nested provider-credentials route', async () => {
        const escrow = await generateEncryptionKeypair();
        const ciphertext = await seal('fake-openai-0000', escrow.publicKeyB64);
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                escrow: { publicKey: escrow.publicKeyB64, wrappedPrivateKey: 'WRAPPED' },
                credentials: [
                    { id: 'c4', provider: ANTHROPIC, kind: SUBSCRIPTION, sealedTo: 'escrow', ciphertext },
                ],
            }),
        );
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        const bundle = await client.fetchBundle();

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${PREFIX}/provider-credentials`);
        expect(init.method).toBe('GET');
        expect((init.headers as Record<string, string>).authorization).toBe(AUTH);
        expect(bundle.escrow.wrappedPrivateKeyB64).toBe('WRAPPED');
        expect(bundle.credentials[0].kind).toBe(SUBSCRIPTION);
    });

    it('PUTs a rotated ciphertext keyed on the CREDENTIAL ID, declaring sealedTo', async () => {
        const escrow = await generateEncryptionKeypair();
        const ciphertext = await seal('{"fake":true,"refresh":"fake-r"}', escrow.publicKeyB64);
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await client.putCredential('01KCRED', ciphertext);

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        // Keyed on the id: an account and a project credential share a provider,
        // so a provider-keyed PUT would overwrite whichever the server guessed.
        expect(url).toBe(`${PREFIX}/provider-credentials/01KCRED`);
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body as string)).toEqual({ ciphertext, sealedTo: 'escrow' });
    });

    it('REFUSES to PUT anything that is not a sealed box — plaintext never leaves the host', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await expect(client.putCredential('c', 'fake-not-a-real-key')).rejects.toThrow(/ciphertext/i);
        await expect(client.putCredential('c', '')).rejects.toThrow(/ciphertext/i);
        // The base64-wrapped-plaintext trap: long enough, but decodes to text.
        await expect(
            client.putCredential('c', Buffer.from('fake-secret-'.repeat(20)).toString('base64')),
        ).rejects.toThrow(/ciphertext/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('lists the owner hosts awaiting an escrow copy from the nested route', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                escrow: { publicKey: 'ESCROWPK', fingerprint: 'fp' },
                hosts: [
                    { workstationId: 'ws-new', name: 'laptop', encryptionPublicKey: 'PK1' },
                    { workstationId: 'ws-bad', name: 'no-key' },
                ],
            }),
        );
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        const pending = await client.listEscrowPending();

        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${PREFIX}/escrow/pending`);
        // The row with no published key is dropped — there is nothing to seal to.
        expect(pending).toEqual([{ workstationId: 'ws-new', encryptionPublicKeyB64: 'PK1' }]);
    });

    it('posts a wrapped escrow copy to the wrapped-keys route', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await client.wrapEscrowForHost({ targetWorkstationId: 'ws-new', ciphertext: 'WRAPPED' });

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${PREFIX}/escrow/wrapped-keys`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            targetWorkstationId: 'ws-new',
            ciphertext: 'WRAPPED',
        });
    });

    it('nests EVERY route under /{workstation}/ so the host proof can be verified', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ hosts: [] }));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await client.publishEncryptionKey({ publicKeyB64: 'PK', fingerprint: '' });
        await client.fetchBundle();
        await client.listEscrowPending();
        await client.wrapEscrowForHost({ targetWorkstationId: 't', ciphertext: 'c' });

        // Tynn verifies the signature against the ROUTE-BOUND workstation; a route
        // with no {workstation} segment has nothing to verify against and 404s.
        for (const call of fetchImpl.mock.calls) {
            expect((call as unknown as [string])[0]).toContain(`/api/v1/workstations/${WS_ID}/`);
        }
    });

    it('throws on a non-2xx WITHOUT quoting the response body', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ secretEcho: 'fake-anthropic-0000' }, 403));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await expect(client.fetchBundle()).rejects.toThrow(/403/);
        await expect(client.fetchBundle()).rejects.not.toThrow(/fake-anthropic-0000/);
    });

    it('trims a trailing slash off the base url instead of doubling it', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(
            identity,
            `${BASE}/`,
            fetchImpl as unknown as typeof fetch,
        );

        await client.publishEncryptionKey({ publicKeyB64: 'PK', fingerprint: '' });

        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${PREFIX}/encryption-key`);
    });
});

describe('provider-credential.changed push', () => {
    const channel = `private-workstation.${WS_ID}`;

    it('recognises the event on OUR channel only', () => {
        expect(isProviderCredentialChange({ event: 'provider-credential.changed', channel }, channel)).toBe(true);
        expect(
            isProviderCredentialChange(
                { event: 'provider-credential.changed', channel: 'private-workstation.other' },
                channel,
            ),
        ).toBe(false);
        expect(isProviderCredentialChange({ event: 'issuewatch.delta', channel }, channel)).toBe(false);
    });

    it('coerces all three actions', () => {
        for (const action of ['set', 'rotated', 'revoked'] as const) {
            expect(
                toProviderCredentialChange({
                    action,
                    credentialId: '01K',
                    provider: ANTHROPIC,
                    kind: API_KEY,
                    scope: 'account',
                    projectId: null,
                }),
            ).toEqual({
                action,
                credentialId: '01K',
                provider: ANTHROPIC,
                kind: API_KEY,
                scope: 'account',
                projectId: null,
            });
        }
    });

    it('drops an unusable payload rather than acting on a guess', () => {
        expect(toProviderCredentialChange(null)).toBeNull();
        expect(toProviderCredentialChange({})).toBeNull();
        expect(toProviderCredentialChange({ action: 'revoked' })).toBeNull();
        expect(toProviderCredentialChange({ credentialId: '01K' })).toBeNull();
        expect(toProviderCredentialChange({ action: 'exploded', credentialId: '01K' })).toBeNull();
        expect(toProviderCredentialChange({ action: 'revoked', credentialId: 42 })).toBeNull();
    });
});

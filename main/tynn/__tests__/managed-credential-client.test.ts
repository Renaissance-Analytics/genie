import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    ANTHROPIC_API_KEY,
    CLAUDE_SUBSCRIPTION,
    GITHUB_TOKEN,
} from '../../host-core/crypto/escrow';
import { generateEncryptionKeypair, seal, sodiumReady } from '../../host-core/crypto/sealed-box';
import {
    createManagedCredentialClient,
    isCredentialRevoke,
    parseCredentialBundle,
    toCredentialRevoke,
} from '../managed-credential-client';

/**
 * SYNTHETIC KEYS + FAKE CIPHERTEXT ONLY. Every sealed box below was produced in
 * this test from a locally generated keypair; no real credential exists here.
 */

const WS_ID = 'ws-42';
const BASE = 'https://tynn.test';
const AUTH = 'Workstation 1700000000:sig==';

const identity = { workstationId: WS_ID, authHeader: () => AUTH };

beforeAll(async () => {
    await sodiumReady();
});

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

describe('parseCredentialBundle', () => {
    it('maps Tynn snake_case onto the host bundle shape', async () => {
        const escrow = await generateEncryptionKeypair();
        const ciphertext = await seal('fake-anthropic-0000', escrow.publicKeyB64);

        const bundle = parseCredentialBundle({
            escrow: { public_key: escrow.publicKeyB64, wrapped_private_key: 'AAAA' },
            credentials: [
                { id: 'c1', provider: ANTHROPIC_API_KEY, ciphertext, updated_at: '2026-07-25T00:00:00Z' },
            ],
        });

        expect(bundle.escrow).toEqual({
            publicKeyB64: escrow.publicKeyB64,
            wrappedPrivateKeyB64: 'AAAA',
        });
        expect(bundle.credentials).toEqual([
            { id: 'c1', provider: ANTHROPIC_API_KEY, ciphertext, updatedAt: '2026-07-25T00:00:00Z' },
        ]);
    });

    it('tolerates a bundle with no escrow copy and no credentials', () => {
        expect(parseCredentialBundle({ escrow: { public_key: 'pk' } })).toEqual({
            escrow: { publicKeyB64: 'pk', wrappedPrivateKeyB64: null },
            credentials: [],
        });
        expect(parseCredentialBundle(null)).toEqual({
            escrow: { publicKeyB64: '', wrappedPrivateKeyB64: null },
            credentials: [],
        });
    });

    it('drops a credential row missing a provider or ciphertext', () => {
        const bundle = parseCredentialBundle({
            escrow: { public_key: 'pk' },
            credentials: [{ provider: GITHUB_TOKEN }, { ciphertext: 'x' }, 'nonsense'],
        });
        expect(bundle.credentials).toEqual([]);
    });
});

describe('createManagedCredentialClient', () => {
    it('publishes ONLY the public key + fingerprint, host-authed', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await client.publishEncryptionKey({ publicKeyB64: 'PUBKEY', fingerprint: 'abc123' });

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${BASE}/api/v1/workstations/${WS_ID}/encryption-key`);
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).authorization).toBe(AUTH);
        expect(JSON.parse(init.body as string)).toEqual({
            encryption_public_key: 'PUBKEY',
            fingerprint: 'abc123',
        });
    });

    it('fetches and parses this host bundle from the host-authed endpoint', async () => {
        const escrow = await generateEncryptionKeypair();
        const ciphertext = await seal('fake-openai-0000', escrow.publicKeyB64);
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                escrow: { public_key: escrow.publicKeyB64, wrapped_private_key: 'WRAPPED' },
                credentials: [{ provider: CLAUDE_SUBSCRIPTION, ciphertext }],
            }),
        );
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        const bundle = await client.fetchBundle();

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${BASE}/api/v1/workstations/${WS_ID}/credentials`);
        expect(init.method).toBe('GET');
        expect((init.headers as Record<string, string>).authorization).toBe(AUTH);
        expect(bundle.escrow.wrappedPrivateKeyB64).toBe('WRAPPED');
        expect(bundle.credentials[0].provider).toBe(CLAUDE_SUBSCRIPTION);
    });

    it('PUTs a rotated ciphertext to the per-provider endpoint', async () => {
        const escrow = await generateEncryptionKeypair();
        const ciphertext = await seal('{"fake":true}', escrow.publicKeyB64);
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await client.putCredential(CLAUDE_SUBSCRIPTION, ciphertext);

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${BASE}/api/v1/workstations/${WS_ID}/credentials/${CLAUDE_SUBSCRIPTION}`);
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body as string)).toEqual({ ciphertext });
    });

    it('REFUSES to PUT anything that is not a sealed box — a plaintext write never leaves the host', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await expect(
            client.putCredential(CLAUDE_SUBSCRIPTION, 'fake-not-a-real-key'),
        ).rejects.toThrow(/ciphertext/i);
        await expect(client.putCredential(CLAUDE_SUBSCRIPTION, '')).rejects.toThrow(/ciphertext/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('lists the owner hosts awaiting an escrow copy', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse({
                hosts: [
                    { workstation_id: 'ws-new', encryption_public_key: 'PK1' },
                    { workstation_id: 'ws-bad' },
                ],
            }),
        );
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        const pending = await client.listEscrowPending();

        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
            `${BASE}/api/v1/workstations/escrow/pending`,
        );
        // The row with no published key is dropped — there is nothing to seal to.
        expect(pending).toEqual([{ workstationId: 'ws-new', encryptionPublicKeyB64: 'PK1' }]);
    });

    it('posts a wrapped escrow copy for a peer host', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({}));
        const client = createManagedCredentialClient(identity, BASE, fetchImpl as unknown as typeof fetch);

        await client.wrapEscrowForHost({
            targetWorkstationId: 'ws-new',
            wrappedPrivateKeyB64: 'WRAPPED',
        });

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${BASE}/api/v1/workstations/escrow/wrap`);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            target_workstation_id: 'ws-new',
            wrapped_private_key: 'WRAPPED',
        });
    });

    it('throws on a non-2xx WITHOUT quoting the response body', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ secret_echo: 'fake-anthropic-0000' }, 403));
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

        await client.publishEncryptionKey({ publicKeyB64: 'PK', fingerprint: 'fp' });

        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
            `${BASE}/api/v1/workstations/${WS_ID}/encryption-key`,
        );
    });
});

describe('credential revoke push (private-workstation.{id} channel)', () => {
    const channel = `private-workstation.${WS_ID}`;

    it('recognises a credential.revoked frame on OUR channel only', () => {
        expect(isCredentialRevoke({ event: 'credential.revoked', channel }, channel)).toBe(true);
        expect(
            isCredentialRevoke({ event: 'credential.revoked', channel: 'private-workstation.other' }, channel),
        ).toBe(false);
        expect(isCredentialRevoke({ event: 'issuewatch.delta', channel }, channel)).toBe(false);
    });

    it('coerces a single-provider revoke payload', () => {
        expect(toCredentialRevoke({ provider: CLAUDE_SUBSCRIPTION })).toEqual({
            provider: CLAUDE_SUBSCRIPTION,
        });
    });

    it('coerces an all-revoke payload', () => {
        expect(toCredentialRevoke({ all: true })).toEqual({ all: true });
    });

    it('drops an unusable payload rather than revoking something arbitrary', () => {
        expect(toCredentialRevoke(null)).toBeNull();
        expect(toCredentialRevoke({})).toBeNull();
        expect(toCredentialRevoke({ provider: '' })).toBeNull();
        expect(toCredentialRevoke({ provider: 42 })).toBeNull();
        expect(toCredentialRevoke({ all: false })).toBeNull();
    });
});

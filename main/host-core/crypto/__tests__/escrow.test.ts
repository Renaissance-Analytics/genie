import { beforeAll, describe, expect, it } from 'vitest';
import { generateEncryptionKeypair, seal, sodiumReady, type EncryptionKeypair } from '../sealed-box';
import {
    ANTHROPIC,
    API_KEY,
    GITHUB,
    OPENAI,
    SUBSCRIPTION,
    openCredentialBundle,
    openEscrowKeypair,
    sealForEscrow,
    wrapEscrowForPeer,
    type CredentialBundle,
    type SealedCredential,
} from '../escrow';

/**
 * SYNTHETIC KEYS + FAKE VALUES ONLY. Every escrow/host keypair below is generated
 * by the test; every "credential" is a literal the test itself invented. No real
 * provider secret is used, and no opened value is logged — assertions compare
 * against the fake literal.
 */

const FAKE = {
    anthropic: 'fake-anthropic-0000',
    openai: 'fake-openai-0000',
    github: 'fake-gh-token-0000',
    claude: '{"fake":true,"refresh":"fake-refresh-0000"}',
};

beforeAll(async () => {
    await sodiumReady();
});

/** One credential row as Tynn serves it, sealed to the escrow key by default. */
async function credential(
    id: string,
    provider: string,
    kind: string,
    value: string,
    escrowPublicKeyB64: string,
    extra: Partial<SealedCredential> = {},
): Promise<SealedCredential> {
    return {
        id,
        provider,
        kind,
        scope: 'account',
        projectId: null,
        sealedTo: 'escrow',
        ciphertext: await seal(value, escrowPublicKeyB64),
        ...extra,
    };
}

async function buildBundle(
    escrow: EncryptionKeypair,
    host: EncryptionKeypair | null,
): Promise<CredentialBundle> {
    return {
        escrow: {
            publicKeyB64: escrow.publicKeyB64,
            wrappedPrivateKeyB64: host ? await wrapEscrowForPeer(escrow, host.publicKeyB64) : null,
        },
        credentials: [
            await credential('c1', ANTHROPIC, API_KEY, FAKE.anthropic, escrow.publicKeyB64),
            await credential('c2', OPENAI, API_KEY, FAKE.openai, escrow.publicKeyB64),
            await credential('c3', GITHUB, API_KEY, FAKE.github, escrow.publicKeyB64),
            await credential('c4', ANTHROPIC, SUBSCRIPTION, FAKE.claude, escrow.publicKeyB64),
        ],
    };
}

describe('openEscrowKeypair', () => {
    it('opens the escrow private key that was sealed to THIS host', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);

        const opened = await openEscrowKeypair(bundle.escrow, host);
        expect(opened).not.toBeNull();
        expect(opened!.publicKeyB64).toBe(escrow.publicKeyB64);
        expect(opened!.privateKeyB64).toBe(escrow.privateKeyB64);
    });

    it('returns null when the escrow key was sealed to a DIFFERENT host (wrong key)', async () => {
        const escrow = await generateEncryptionKeypair();
        const intendedHost = await generateEncryptionKeypair();
        const thisHost = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, intendedHost);

        expect(await openEscrowKeypair(bundle.escrow, thisHost)).toBeNull();
    });

    it('returns null when this host has no wrapped copy yet (awaiting bootstrap)', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, null);

        expect(await openEscrowKeypair(bundle.escrow, host)).toBeNull();
    });

    it('REFUSES an escrow private key that does not match the advertised public key', async () => {
        const escrow = await generateEncryptionKeypair();
        const impostor = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();

        // Tynn advertises `escrow.publicKeyB64` but hands us a wrapped key that is
        // actually the impostor's private half. Opening succeeds cryptographically;
        // the pair check must still reject it.
        const mismatched = {
            publicKeyB64: escrow.publicKeyB64,
            wrappedPrivateKeyB64: await seal(
                Buffer.from(impostor.privateKeyB64, 'base64'),
                host.publicKeyB64,
            ),
        };

        expect(await openEscrowKeypair(mismatched, host)).toBeNull();
    });
});

describe('openCredentialBundle', () => {
    it('opens every escrow-sealed credential, preserving its provider/kind/scope descriptor', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();

        const opened = await openCredentialBundle(await buildBundle(escrow, host), host);

        expect(opened.status).toBe('ok');
        expect(opened.escrowPublicKeyB64).toBe(escrow.publicKeyB64);
        expect(opened.failed).toEqual([]);
        expect(opened.credentials.map((c) => [c.id, c.provider, c.kind, c.value])).toEqual([
            ['c1', ANTHROPIC, API_KEY, FAKE.anthropic],
            ['c2', OPENAI, API_KEY, FAKE.openai],
            ['c3', GITHUB, API_KEY, FAKE.github],
            ['c4', ANTHROPIC, SUBSCRIPTION, FAKE.claude],
        ]);
        expect(opened.credentials[0]).toMatchObject({ scope: 'account', projectId: null });
    });

    it('opens a credential sealed DIRECTLY to this host (sealedTo: host)', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials = [
            {
                id: 'direct',
                provider: ANTHROPIC,
                kind: API_KEY,
                scope: 'account',
                projectId: null,
                sealedTo: 'host',
                ciphertext: await seal(FAKE.anthropic, host.publicKeyB64),
            },
        ];

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.credentials).toHaveLength(1);
        expect(opened.credentials[0].value).toBe(FAKE.anthropic);
    });

    it('opens NOTHING without the escrow key, even a host-sealed row', async () => {
        // No flow produces a host-sealed credential (Tynn 422s the only writer),
        // so a host with no escrow key genuinely has nothing it can open.
        // Bootstrap is solved by escrow DISTRIBUTION — the browser seals
        // escrow_priv to each host, a peer covers re-provisioning — not by
        // host-sealed credentials. Opening anything here would be a branch that
        // never runs, hiding the real signal: report the gap, inject nothing.
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle: CredentialBundle = {
            escrow: { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: null },
            credentials: [
                {
                    id: 'direct',
                    provider: OPENAI,
                    kind: API_KEY,
                    scope: 'account',
                    projectId: null,
                    sealedTo: 'host',
                    ciphertext: await seal(FAKE.openai, host.publicKeyB64),
                },
                await credential('escrowed', ANTHROPIC, API_KEY, FAKE.anthropic, escrow.publicKeyB64),
            ],
        };

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.status).toBe('no-escrow-key');
        expect(opened.credentials).toEqual([]);
        expect(opened.failed).toEqual([]);
    });

    it('recovers a RE-PROVISIONED host: a brand-new keypair opens the SAME credentials', async () => {
        const escrow = await generateEncryptionKeypair();
        const oldHost = await generateEncryptionKeypair();
        const original = await buildBundle(escrow, oldHost);

        // The host is wiped and re-provisioned with a fresh keypair; a live peer
        // re-wraps the escrow key to it. The credential ciphertexts are UNCHANGED.
        const newHost = await generateEncryptionKeypair();
        const rewrapped: CredentialBundle = {
            escrow: {
                publicKeyB64: escrow.publicKeyB64,
                wrappedPrivateKeyB64: await wrapEscrowForPeer(escrow, newHost.publicKeyB64),
            },
            credentials: original.credentials,
        };

        const before = await openCredentialBundle(original, newHost);
        expect(before.status).toBe('no-escrow-key');
        expect(before.credentials).toEqual([]);

        const recovered = await openCredentialBundle(rewrapped, newHost);
        expect(recovered.status).toBe('ok');
        expect(recovered.credentials.find((c) => c.id === 'c1')?.value).toBe(FAKE.anthropic);
        expect(recovered.credentials.find((c) => c.id === 'c4')?.value).toBe(FAKE.claude);
    });

    it('names the credentials that failed to open by ID, never surfacing a value', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const stranger = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials.push({
            id: 'unopenable',
            provider: ANTHROPIC,
            kind: API_KEY,
            scope: 'account',
            projectId: null,
            sealedTo: 'escrow',
            ciphertext: await seal('fake-stranger-0000', stranger.publicKeyB64),
        });

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.failed).toEqual(['unopenable']);
        expect(opened.credentials.map((c) => c.id)).not.toContain('unopenable');
        expect(JSON.stringify(opened.failed)).not.toContain('fake-stranger-0000');
    });

    it('drops a credential whose ciphertext could be plaintext (never trusts a bad store)', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials.push({
            id: 'plaintextish',
            provider: ANTHROPIC,
            kind: API_KEY,
            scope: 'account',
            projectId: null,
            sealedTo: 'escrow',
            ciphertext: Buffer.from('fake-not-a-real-key-'.repeat(10)).toString('base64'),
        });

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.failed).toContain('plaintextish');
        expect(opened.credentials.map((c) => c.id)).not.toContain('plaintextish');
    });

    it('carries project scope through so the host can resolve per-workspace overrides', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials = [
            await credential('acct', ANTHROPIC, API_KEY, FAKE.anthropic, escrow.publicKeyB64),
            await credential('proj', ANTHROPIC, API_KEY, 'fake-anthropic-proj', escrow.publicKeyB64, {
                scope: 'project',
                projectId: 'p-42',
            }),
        ];

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.credentials.find((c) => c.id === 'proj')).toMatchObject({
            scope: 'project',
            projectId: 'p-42',
            value: 'fake-anthropic-proj',
        });
    });
});

describe('write-back sealing', () => {
    it('seals a rotated value to the ESCROW key so every host — present and future — can open it', async () => {
        const escrow = await generateEncryptionKeypair();
        const hostB = await generateEncryptionKeypair();
        const rotated = '{"fake":true,"refresh":"fake-rotated-0000"}';

        const ciphertext = await sealForEscrow(rotated, escrow.publicKeyB64);

        // Host B — which never saw the rotation — opens it via its own escrow copy.
        const bundle: CredentialBundle = {
            escrow: {
                publicKeyB64: escrow.publicKeyB64,
                wrappedPrivateKeyB64: await wrapEscrowForPeer(escrow, hostB.publicKeyB64),
            },
            credentials: [
                {
                    id: 'c4',
                    provider: ANTHROPIC,
                    kind: SUBSCRIPTION,
                    scope: 'account',
                    projectId: null,
                    sealedTo: 'escrow',
                    ciphertext,
                },
            ],
        };
        const opened = await openCredentialBundle(bundle, hostB);
        expect(opened.credentials[0].value).toBe(rotated);
    });

    it('refuses to seal an empty value (never writes back nothing)', async () => {
        const escrow = await generateEncryptionKeypair();
        await expect(sealForEscrow('', escrow.publicKeyB64)).rejects.toThrow(/empty/i);
    });
});

describe('wrapEscrowForPeer (new-host bootstrap)', () => {
    it('seals the escrow PRIVATE key to a peer pubkey, openable only by that peer', async () => {
        const escrow = await generateEncryptionKeypair();
        const newHost = await generateEncryptionKeypair();
        const bystander = await generateEncryptionKeypair();

        const wrapped = await wrapEscrowForPeer(escrow, newHost.publicKeyB64);

        expect(
            await openEscrowKeypair(
                { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: wrapped },
                newHost,
            ),
        ).toMatchObject({ publicKeyB64: escrow.publicKeyB64 });
        expect(
            await openEscrowKeypair(
                { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: wrapped },
                bystander,
            ),
        ).toBeNull();
    });

    it('refuses to wrap for a malformed peer public key', async () => {
        const escrow = await generateEncryptionKeypair();
        await expect(wrapEscrowForPeer(escrow, 'not-a-key')).rejects.toThrow(/public key/i);
    });
});

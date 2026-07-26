import { beforeAll, describe, expect, it } from 'vitest';
import { generateEncryptionKeypair, seal, sodiumReady, type EncryptionKeypair } from '../sealed-box';
import {
    ANTHROPIC_API_KEY,
    CLAUDE_SUBSCRIPTION,
    GITHUB_TOKEN,
    OPENAI_API_KEY,
    openCredentialBundle,
    openEscrowKeypair,
    sealForEscrow,
    wrapEscrowForPeer,
    type CredentialBundle,
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

/** Build the bundle Tynn would return: escrow priv sealed to `host`, each
 *  credential sealed to the escrow PUBLIC key. */
async function buildBundle(
    escrow: EncryptionKeypair,
    host: EncryptionKeypair | null,
): Promise<CredentialBundle> {
    return {
        escrow: {
            publicKeyB64: escrow.publicKeyB64,
            wrappedPrivateKeyB64: host
                ? await seal(Buffer.from(escrow.privateKeyB64, 'base64'), host.publicKeyB64)
                : null,
        },
        credentials: [
            { provider: ANTHROPIC_API_KEY, ciphertext: await seal(FAKE.anthropic, escrow.publicKeyB64) },
            { provider: OPENAI_API_KEY, ciphertext: await seal(FAKE.openai, escrow.publicKeyB64) },
            { provider: GITHUB_TOKEN, ciphertext: await seal(FAKE.github, escrow.publicKeyB64) },
            { provider: CLAUDE_SUBSCRIPTION, ciphertext: await seal(FAKE.claude, escrow.publicKeyB64) },
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
    it('opens every credential sealed to the escrow key (escrow recovery end to end)', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.status).toBe('ok');
        expect(opened.escrowPublicKeyB64).toBe(escrow.publicKeyB64);
        expect(opened.values[ANTHROPIC_API_KEY]).toBe(FAKE.anthropic);
        expect(opened.values[OPENAI_API_KEY]).toBe(FAKE.openai);
        expect(opened.values[GITHUB_TOKEN]).toBe(FAKE.github);
        expect(opened.values[CLAUDE_SUBSCRIPTION]).toBe(FAKE.claude);
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

        expect(await openCredentialBundle(original, newHost)).toMatchObject({ status: 'no-escrow-key' });
        const recovered = await openCredentialBundle(rewrapped, newHost);
        expect(recovered.status).toBe('ok');
        expect(recovered.values[ANTHROPIC_API_KEY]).toBe(FAKE.anthropic);
        expect(recovered.values[CLAUDE_SUBSCRIPTION]).toBe(FAKE.claude);
    });

    it('reports no-escrow-key (no values) when the wrapped copy is missing', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();

        const opened = await openCredentialBundle(await buildBundle(escrow, null), host);

        expect(opened.status).toBe('no-escrow-key');
        expect(opened.values).toEqual({});
    });

    it('names the providers that failed to open WITHOUT surfacing any value', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const stranger = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        // One credential was sealed to a key the escrow can't open.
        bundle.credentials.push({
            provider: 'unopenable',
            ciphertext: await seal('fake-stranger-0000', stranger.publicKeyB64),
        });

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.status).toBe('ok');
        expect(opened.failed).toEqual(['unopenable']);
        expect(opened.values.unopenable).toBeUndefined();
    });

    it('drops a credential whose ciphertext could be plaintext (never trusts a bad store)', async () => {
        const escrow = await generateEncryptionKeypair();
        const host = await generateEncryptionKeypair();
        const bundle = await buildBundle(escrow, host);
        bundle.credentials.push({ provider: 'plaintextish', ciphertext: 'fake-not-a-real-key' });

        const opened = await openCredentialBundle(bundle, host);

        expect(opened.failed).toContain('plaintextish');
        expect(opened.values.plaintextish).toBeUndefined();
    });
});

describe('write-back sealing', () => {
    it('seals a rotated value to the ESCROW key so every host — present and future — can open it', async () => {
        const escrow = await generateEncryptionKeypair();
        const hostA = await generateEncryptionKeypair();
        const hostB = await generateEncryptionKeypair();
        const rotated = '{"fake":true,"refresh":"fake-rotated-0000"}';

        const ciphertext = await sealForEscrow(rotated, escrow.publicKeyB64);

        // Host B — which never saw the rotation — opens it via its own escrow copy.
        const bundle: CredentialBundle = {
            escrow: {
                publicKeyB64: escrow.publicKeyB64,
                wrappedPrivateKeyB64: await wrapEscrowForPeer(escrow, hostB.publicKeyB64),
            },
            credentials: [{ provider: CLAUDE_SUBSCRIPTION, ciphertext }],
        };
        const opened = await openCredentialBundle(bundle, hostB);
        expect(opened.values[CLAUDE_SUBSCRIPTION]).toBe(rotated);

        // And it is NOT openable by a host key directly — it is escrow-sealed.
        const hostASealed = await openCredentialBundle(
            { escrow: { publicKeyB64: escrow.publicKeyB64, wrappedPrivateKeyB64: null }, credentials: [] },
            hostA,
        );
        expect(hostASealed.status).toBe('no-escrow-key');
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

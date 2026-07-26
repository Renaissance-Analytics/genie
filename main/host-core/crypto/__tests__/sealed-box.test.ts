import { beforeAll, describe, expect, it } from 'vitest';
import {
    SEAL_OVERHEAD_BYTES,
    derivePublicKey,
    fingerprintPublicKey,
    generateEncryptionKeypair,
    isPlausibleSealedBox,
    seal,
    sealOpen,
    sealOpenText,
    sodiumReady,
} from '../sealed-box';

/**
 * SYNTHETIC KEYS ONLY. Every keypair here is generated in-process by the test and
 * every "credential" is an obviously fake string. No real provider secret exists
 * anywhere in this suite, and no decrypted value is ever printed — assertions
 * compare against the synthetic literal the test itself created.
 */

const FAKE_CREDENTIAL = 'fake-not-a-real-key-0000';

beforeAll(async () => {
    await sodiumReady();
});

describe('sealed box (libsodium crypto_box_seal)', () => {
    it('round-trips a value sealed to a public key and opened with its private key', async () => {
        const kp = await generateEncryptionKeypair();
        const ciphertext = await seal(FAKE_CREDENTIAL, kp.publicKeyB64);
        expect(await sealOpenText(ciphertext, kp)).toBe(FAKE_CREDENTIAL);
    });

    it('FAILS to open with the WRONG keypair (returns null, never throws)', async () => {
        const target = await generateEncryptionKeypair();
        const attacker = await generateEncryptionKeypair();
        const ciphertext = await seal(FAKE_CREDENTIAL, target.publicKeyB64);

        expect(await sealOpen(ciphertext, attacker)).toBeNull();
        expect(await sealOpenText(ciphertext, attacker)).toBeNull();
    });

    it('FAILS to open a tampered ciphertext (Poly1305 integrity)', async () => {
        const kp = await generateEncryptionKeypair();
        const ciphertext = await seal(FAKE_CREDENTIAL, kp.publicKeyB64);
        const raw = Buffer.from(ciphertext, 'base64');
        raw[raw.length - 1] ^= 0xff;

        expect(await sealOpen(raw.toString('base64'), kp)).toBeNull();
    });

    it('FAILS to open garbage that is not a sealed box at all', async () => {
        const kp = await generateEncryptionKeypair();
        expect(await sealOpen('not-base64-!!!', kp)).toBeNull();
        expect(await sealOpen('', kp)).toBeNull();
        expect(await sealOpen(Buffer.from('short').toString('base64'), kp)).toBeNull();
    });

    it('never leaks the plaintext into the ciphertext and adds the 48-byte seal overhead', async () => {
        const kp = await generateEncryptionKeypair();
        const ciphertext = await seal(FAKE_CREDENTIAL, kp.publicKeyB64);
        const raw = Buffer.from(ciphertext, 'base64');

        expect(raw.toString('utf8')).not.toContain(FAKE_CREDENTIAL);
        expect(ciphertext).not.toContain(FAKE_CREDENTIAL);
        expect(raw.length).toBe(FAKE_CREDENTIAL.length + SEAL_OVERHEAD_BYTES);
    });

    it('produces a DIFFERENT ciphertext each time (fresh ephemeral sender key)', async () => {
        const kp = await generateEncryptionKeypair();
        const a = await seal(FAKE_CREDENTIAL, kp.publicKeyB64);
        const b = await seal(FAKE_CREDENTIAL, kp.publicKeyB64);

        expect(a).not.toBe(b);
        expect(await sealOpenText(a, kp)).toBe(await sealOpenText(b, kp));
    });

    it('seals binary payloads (the Claude credential JSON blob) losslessly', async () => {
        const kp = await generateEncryptionKeypair();
        const blob = Buffer.from(JSON.stringify({ fake: true, token: 'fake-oauth-000' }), 'utf8');
        const opened = await sealOpen(await seal(blob, kp.publicKeyB64), kp);

        expect(opened && Buffer.from(opened).equals(blob)).toBe(true);
    });

    it('emits 32-byte raw X25519 keys as padded standard base64', async () => {
        const kp = await generateEncryptionKeypair();
        expect(Buffer.from(kp.publicKeyB64, 'base64')).toHaveLength(32);
        expect(Buffer.from(kp.privateKeyB64, 'base64')).toHaveLength(32);
        expect(kp.publicKeyB64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    });

    it('rejects a malformed recipient public key rather than sealing to nothing', async () => {
        await expect(seal(FAKE_CREDENTIAL, 'too-short')).rejects.toThrow(/public key/i);
    });

    it('fingerprints a public key as stable sha256 hex of its raw bytes', async () => {
        const kp = await generateEncryptionKeypair();
        const fp = fingerprintPublicKey(kp.publicKeyB64);

        expect(fp).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprintPublicKey(kp.publicKeyB64)).toBe(fp);
        expect(fingerprintPublicKey((await generateEncryptionKeypair()).publicKeyB64)).not.toBe(fp);
    });

    it('derives the public key from a private key, so a mismatched pair is detectable', async () => {
        const kp = await generateEncryptionKeypair();
        const other = await generateEncryptionKeypair();

        expect(await derivePublicKey(kp.privateKeyB64)).toBe(kp.publicKeyB64);
        expect(await derivePublicKey(other.privateKeyB64)).not.toBe(kp.publicKeyB64);
        expect(await derivePublicKey('bogus')).toBeNull();
    });

    it('recognises a plausible sealed box so a plaintext write can be refused', async () => {
        const kp = await generateEncryptionKeypair();
        expect(isPlausibleSealedBox(await seal(FAKE_CREDENTIAL, kp.publicKeyB64))).toBe(true);
        // A plaintext credential accidentally sent as "ciphertext" is too short
        // to be a sealed box (32B ephemeral pk + 16B MAC = 48B floor).
        expect(isPlausibleSealedBox(Buffer.from(FAKE_CREDENTIAL).toString('base64'))).toBe(false);
        expect(isPlausibleSealedBox(FAKE_CREDENTIAL)).toBe(false);
        expect(isPlausibleSealedBox('')).toBe(false);
    });
});

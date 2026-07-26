import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setSecretEncryptor } from '../../../secrets/store';
import { derivePublicKey, sodiumReady } from '../sealed-box';
import {
    ENC_KEY_ENC_SETTING,
    ENC_PUBLIC_KEY_SETTING,
    clearHostEncryptionKeypair,
    ensureHostEncryptionKey,
    readHostEncryptionKeypair,
    storeHostEncryptionKeypair,
    type EncryptionKeyPublisher,
} from '../host-encryption-key';

/**
 * SYNTHETIC KEYS ONLY — every keypair is generated in-process by the code under
 * test; nothing here is or wraps a real credential. The fake encryptor is a
 * deliberately reversible marker so a test can prove the persisted blob is NOT
 * the raw private key; it is not, and must never be mistaken for, real crypto.
 */

function fakeEncryptor(available = true) {
    return {
        isAvailable: () => available,
        encrypt: (b: Buffer) => Buffer.concat([Buffer.from('ENC:'), b]),
        decrypt: (b: Buffer) => b.subarray(4),
    };
}

/** An in-memory stand-in for the settings row the real store writes to. */
function memoryStore() {
    const rows: Record<string, string> = {};
    return {
        rows,
        read: () => ({
            publicKeyB64: rows[ENC_PUBLIC_KEY_SETTING] || undefined,
            privateKeyEnc: rows[ENC_KEY_ENC_SETTING] || undefined,
        }),
        write: (patch: Record<string, string>) => Object.assign(rows, patch),
    };
}

beforeAll(async () => {
    await sodiumReady();
});

afterEach(() => setSecretEncryptor(null));

describe('storeHostEncryptionKeypair / readHostEncryptionKeypair', () => {
    it('persists the private key ENCRYPTED and reads the pair back intact', async () => {
        setSecretEncryptor(fakeEncryptor());
        const store = memoryStore();
        const kp = {
            publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
            privateKeyB64: Buffer.alloc(32, 9).toString('base64'),
        };

        storeHostEncryptionKeypair(kp, store.write);

        expect(store.rows[ENC_KEY_ENC_SETTING]).toBeTruthy();
        expect(store.rows[ENC_KEY_ENC_SETTING]).not.toBe(kp.privateKeyB64);
        expect(store.rows[ENC_PUBLIC_KEY_SETTING]).toBe(kp.publicKeyB64);
        expect(readHostEncryptionKeypair(store.read)).toEqual(kp);
    });

    it('FAILS CLOSED when OS encryption is unavailable — never writes the key in the clear', () => {
        setSecretEncryptor(fakeEncryptor(false));
        const store = memoryStore();

        expect(() =>
            storeHostEncryptionKeypair(
                {
                    publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
                    privateKeyB64: Buffer.alloc(32, 2).toString('base64'),
                },
                store.write,
            ),
        ).toThrow(/encryption is unavailable/i);
        expect(store.rows).toEqual({});
    });

    it('reads null when nothing is stored, or when the blob cannot be decrypted', () => {
        setSecretEncryptor(fakeEncryptor());
        expect(readHostEncryptionKeypair(() => ({}))).toBeNull();
        expect(
            readHostEncryptionKeypair(() => ({
                publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
                privateKeyEnc: undefined,
            })),
        ).toBeNull();

        setSecretEncryptor({
            isAvailable: () => true,
            encrypt: (b: Buffer) => b,
            decrypt: () => {
                throw new Error('written under a different keychain key');
            },
        });
        expect(
            readHostEncryptionKeypair(() => ({
                publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
                privateKeyEnc: 'anything',
            })),
        ).toBeNull();
    });

    it('clears a stored keypair so the next ensure generates a fresh one', () => {
        setSecretEncryptor(fakeEncryptor());
        const store = memoryStore();
        storeHostEncryptionKeypair(
            {
                publicKeyB64: Buffer.alloc(32, 3).toString('base64'),
                privateKeyB64: Buffer.alloc(32, 4).toString('base64'),
            },
            store.write,
        );

        clearHostEncryptionKeypair(store.write);

        expect(readHostEncryptionKeypair(store.read)).toBeNull();
    });
});

describe('ensureHostEncryptionKey', () => {
    function publisher(): EncryptionKeyPublisher & { calls: Array<Record<string, string>> } {
        const calls: Array<Record<string, string>> = [];
        return {
            calls,
            publishEncryptionKey: vi.fn(async (input) => {
                calls.push({ ...input });
            }),
        };
    }

    it('generates an X25519 pair on first run, persists it, and publishes ONLY the public half', async () => {
        setSecretEncryptor(fakeEncryptor());
        const store = memoryStore();
        const pub = publisher();

        const result = await ensureHostEncryptionKey(pub, { read: store.read, write: store.write });

        expect(result.status).toBe('created');
        expect(result.published).toBe(true);
        const stored = readHostEncryptionKeypair(store.read)!;
        expect(result.publicKeyB64).toBe(stored.publicKeyB64);
        expect(await derivePublicKey(stored.privateKeyB64)).toBe(stored.publicKeyB64);

        expect(pub.calls).toHaveLength(1);
        expect(pub.calls[0].publicKeyB64).toBe(stored.publicKeyB64);
        expect(pub.calls[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
        // The private half is NEVER part of the published payload.
        expect(JSON.stringify(pub.calls[0])).not.toContain(stored.privateKeyB64);
    });

    it('is idempotent — a second run reuses the SAME key and re-publishes it', async () => {
        setSecretEncryptor(fakeEncryptor());
        const store = memoryStore();
        const pub = publisher();

        const first = await ensureHostEncryptionKey(pub, { read: store.read, write: store.write });
        const second = await ensureHostEncryptionKey(pub, { read: store.read, write: store.write });

        expect(second.status).toBe('exists');
        expect(second.publicKeyB64).toBe(first.publicKeyB64);
        expect(pub.calls.map((c) => c.publicKeyB64)).toEqual([first.publicKeyB64, first.publicKeyB64]);
    });

    it('KEEPS the generated key when publishing fails, so the next boot re-publishes the same one', async () => {
        setSecretEncryptor(fakeEncryptor());
        const store = memoryStore();
        const failing: EncryptionKeyPublisher = {
            publishEncryptionKey: vi.fn(async () => {
                throw new Error('tynn unreachable');
            }),
        };

        const result = await ensureHostEncryptionKey(failing, { read: store.read, write: store.write });

        expect(result.status).toBe('created');
        expect(result.published).toBe(false);
        const stored = readHostEncryptionKeypair(store.read);
        expect(stored).not.toBeNull();
        expect(stored!.publicKeyB64).toBe(result.publicKeyB64);

        const retry = await ensureHostEncryptionKey(publisher(), { read: store.read, write: store.write });
        expect(retry.status).toBe('exists');
        expect(retry.publicKeyB64).toBe(result.publicKeyB64);
        expect(retry.published).toBe(true);
    });

    it('refuses to generate at all when the key could not be stored encrypted', async () => {
        setSecretEncryptor(fakeEncryptor(false));
        const store = memoryStore();
        const pub = publisher();

        await expect(
            ensureHostEncryptionKey(pub, { read: store.read, write: store.write }),
        ).rejects.toThrow(/encryption is unavailable/i);
        expect(pub.calls).toEqual([]);
        expect(store.rows).toEqual({});
    });
});

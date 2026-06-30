import { afterEach, describe, it, expect } from 'vitest';
import {
    setSecretEncryptor,
    secretEncryptionAvailable,
    encryptSecret,
    decryptSecret,
} from '../store';

/** A trivial reversible fake encryptor (NOT real crypto) — prefixes a marker so
 *  a test can prove the on-disk blob differs from the plaintext. */
function fakeEncryptor(available = true) {
    return {
        isAvailable: () => available,
        encrypt: (b: Buffer) => Buffer.concat([Buffer.from('ENC:'), b]),
        decrypt: (b: Buffer) => b.subarray(4),
    };
}

afterEach(() => setSecretEncryptor(null));

describe('secrets/store (the Encryptor port seam)', () => {
    it('FAILS CLOSED with no encryptor set — never returns plaintext', () => {
        setSecretEncryptor(null);
        expect(secretEncryptionAvailable()).toBe(false);
        expect(encryptSecret('rpk_secret')).toBeNull();
        expect(decryptSecret('anything')).toBeNull();
    });

    it('FAILS CLOSED when the encryptor reports unavailable', () => {
        setSecretEncryptor(fakeEncryptor(false));
        expect(secretEncryptionAvailable()).toBe(false);
        expect(encryptSecret('rpk_secret')).toBeNull();
    });

    it('round-trips through an available encryptor, and the blob is NOT the plaintext', () => {
        setSecretEncryptor(fakeEncryptor(true));
        expect(secretEncryptionAvailable()).toBe(true);
        const blob = encryptSecret('rpk_secret.tok');
        expect(blob).not.toBeNull();
        expect(blob).not.toContain('rpk_secret.tok'); // base64 of ENC:rpk_…
        expect(decryptSecret(blob!)).toBe('rpk_secret.tok');
    });

    it('decrypt returns null on a blob from a different key (encrypt throws)', () => {
        setSecretEncryptor({
            isAvailable: () => true,
            encrypt: (b: Buffer) => b,
            decrypt: () => {
                throw new Error('bad key');
            },
        });
        expect(decryptSecret('Zm9v')).toBeNull();
    });
});

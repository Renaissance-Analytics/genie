import { afterEach, describe, it, expect } from 'vitest';
import {
    setSecretEncryptor,
    secretEncryptionAvailable,
    encryptSecret,
    decryptSecret,
    encryptSecretResult,
    decryptSecretResult,
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

/**
 * The null both failures collapse into is what made genie#578 undiagnosable —
 * and worse, unrecoverable: a caller cannot tell "there is no key RIGHT NOW"
 * (transient; the blob on disk is still good) from "this blob will never
 * decrypt" (the key changed), so it treats both as "start fresh" and overwrites
 * a store it could have kept. The outcome-typed variants restore the
 * distinction; `encryptSecret`/`decryptSecret` stay as the null-returning
 * wrappers for callers that genuinely don't care which it was.
 */
describe('outcome-typed variants — "not right now" vs "never"', () => {
    it('reports UNAVAILABLE (not failure) when no encryptor is set', () => {
        setSecretEncryptor(null);
        expect(decryptSecretResult('Zm9v')).toEqual({ ok: false, reason: 'unavailable' });
        expect(encryptSecretResult('tok')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('reports UNAVAILABLE when the encryptor is set but reports itself unavailable', () => {
        setSecretEncryptor(fakeEncryptor(false));
        expect(decryptSecretResult('Zm9v')).toEqual({ ok: false, reason: 'unavailable' });
        expect(encryptSecretResult('tok')).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('reports FAILED when the encryptor is available but the blob will not decrypt', () => {
        setSecretEncryptor({
            isAvailable: () => true,
            encrypt: (b: Buffer) => b,
            decrypt: () => {
                throw new Error('bad key');
            },
        });
        expect(decryptSecretResult('Zm9v')).toEqual({ ok: false, reason: 'failed' });
    });

    it('reports FAILED when an available encryptor throws on encrypt', () => {
        setSecretEncryptor({
            isAvailable: () => true,
            encrypt: () => {
                throw new Error('keyring gone mid-write');
            },
            decrypt: (b: Buffer) => b,
        });
        expect(encryptSecretResult('tok')).toEqual({ ok: false, reason: 'failed' });
    });

    it('carries the value on success', () => {
        setSecretEncryptor(fakeEncryptor(true));
        const enc = encryptSecretResult('rpk_secret.tok');
        expect(enc.ok).toBe(true);
        if (!enc.ok) throw new Error('unreachable');
        expect(decryptSecretResult(enc.value)).toEqual({ ok: true, value: 'rpk_secret.tok' });
    });

    it('treats an EMPTY blob as unavailable-free failure, never a silent success', () => {
        setSecretEncryptor(fakeEncryptor(true));
        expect(decryptSecretResult('')).toEqual({ ok: false, reason: 'failed' });
    });
});

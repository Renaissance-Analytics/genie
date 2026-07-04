import { describe, expect, it } from 'vitest';
import {
    canonicalJson,
    keyIdForPublicKey,
    generateSigningKeyPair,
    computeBundleIntegrity,
    signingPayload,
    signManifest,
    verifyDetached,
    type BundleFile,
} from '../signing';

/**
 * Plugin SIGNING primitives (Phase 3). PURE crypto — no Electron / DB / fs.
 * Covers the properties the trust model relies on: canonical determinism, key
 * fingerprinting, sign→verify round-trip, and tamper/wrong-key REJECTION.
 */

function file(path: string, s: string): BundleFile {
    return { path, bytes: Buffer.from(s, 'utf8') };
}

describe('canonicalJson', () => {
    it('is order-independent (sorted keys) + drops undefined', () => {
        expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
        expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
        expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
    });
    it('preserves array order', () => {
        expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    });
});

describe('keyIdForPublicKey', () => {
    it('derives a stable id from the key (same key → same id)', () => {
        const kp = generateSigningKeyPair();
        expect(kp.keyId).toBe(keyIdForPublicKey(kp.publicKeyPem));
        expect(kp.keyId).toMatch(/^ed25519-/);
    });
    it('differs between distinct keys', () => {
        expect(generateSigningKeyPair().keyId).not.toBe(generateSigningKeyPair().keyId);
    });
});

describe('computeBundleIntegrity', () => {
    it('is deterministic + order-independent', () => {
        const a = computeBundleIntegrity([file('a.js', 'x'), file('b.js', 'y')]);
        const b = computeBundleIntegrity([file('b.js', 'y'), file('a.js', 'x')]);
        expect(a).toBe(b);
        expect(a).toMatch(/^sha256-[0-9a-f]{64}$/);
    });
    it('changes when a file byte changes', () => {
        const a = computeBundleIntegrity([file('a.js', 'x')]);
        const b = computeBundleIntegrity([file('a.js', 'X')]);
        expect(a).not.toBe(b);
    });
    it('changes when a file is added/removed', () => {
        const a = computeBundleIntegrity([file('a.js', 'x')]);
        const b = computeBundleIntegrity([file('a.js', 'x'), file('b.js', 'y')]);
        expect(a).not.toBe(b);
    });
});

describe('signingPayload', () => {
    it('excludes `signature` but retains `integrity`', () => {
        const payload = signingPayload({ id: 'x', integrity: 'sha256-abc', signature: 'SIG' });
        expect(payload).toContain('sha256-abc');
        expect(payload).not.toContain('SIG');
    });
});

describe('sign + verify round-trip', () => {
    const base = {
        id: 'com.example.p',
        namespace: 'p',
        name: 'P',
        version: '1.0.0',
        integrity: 'sha256-deadbeef',
        publisher: { name: 'Example', keyId: 'k' },
    };

    it('a validly-signed manifest verifies against its key', () => {
        const kp = generateSigningKeyPair();
        const signed = signManifest(base, kp.privateKeyPem);
        expect(signed.signature).toBeTruthy();
        expect(verifyDetached(signingPayload(signed), signed.signature!, kp.publicKeyPem)).toBe(true);
    });

    it('REJECTS a tampered manifest (integrity swapped after signing)', () => {
        const kp = generateSigningKeyPair();
        const signed = signManifest(base, kp.privateKeyPem);
        const tampered = { ...signed, integrity: 'sha256-0000' };
        expect(verifyDetached(signingPayload(tampered), signed.signature!, kp.publicKeyPem)).toBe(false);
    });

    it('REJECTS the WRONG key', () => {
        const signer = generateSigningKeyPair();
        const other = generateSigningKeyPair();
        const signed = signManifest(base, signer.privateKeyPem);
        expect(verifyDetached(signingPayload(signed), signed.signature!, other.publicKeyPem)).toBe(false);
    });

    it('REJECTS a garbage / empty signature (fail-closed, no throw)', () => {
        const kp = generateSigningKeyPair();
        expect(verifyDetached(signingPayload(base), '', kp.publicKeyPem)).toBe(false);
        expect(verifyDetached(signingPayload(base), 'not-base64!!', kp.publicKeyPem)).toBe(false);
        expect(verifyDetached(signingPayload(base), 'AAAA', 'not a pem')).toBe(false);
    });
});

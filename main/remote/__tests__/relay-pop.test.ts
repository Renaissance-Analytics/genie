import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { PopKeypair, popSignedInput } from '../relay-pop';

/**
 * PoP crypto core (P4.5, member side): an ephemeral Ed25519 keypair whose public
 * JWK binds the grant and whose private key signs the host's challenge. These
 * lock the JWK shape, the canonical signed-input, and that the produced proof
 * verifies under the advertised public key (and not under a different key).
 */

describe('popSignedInput', () => {
    it('is SHA-256(nonce || workstationId || sid) over UTF-8 bytes', () => {
        const out = popSignedInput('nonce-1', 'ws-7', 'sid-9');
        const expected = crypto
            .createHash('sha256')
            .update(Buffer.concat([Buffer.from('nonce-1'), Buffer.from('ws-7'), Buffer.from('sid-9')]))
            .digest();
        expect(out.equals(expected)).toBe(true);
        expect(out).toHaveLength(32);
    });

    it('is deterministic and order-sensitive', () => {
        expect(popSignedInput('a', 'b', 'c').equals(popSignedInput('a', 'b', 'c'))).toBe(true);
        // Reordering the values changes the concatenated byte sequence → digest.
        expect(popSignedInput('a', 'b', 'c').equals(popSignedInput('c', 'b', 'a'))).toBe(false);
        // A different nonce → different digest (the anti-replay property).
        expect(popSignedInput('n1', 'ws', 'sid').equals(popSignedInput('n2', 'ws', 'sid'))).toBe(false);
    });
});

describe('PopKeypair', () => {
    it('exports an OKP/Ed25519 public JWK', () => {
        const kp = PopKeypair.generate();
        expect(kp.publicJwk.kty).toBe('OKP');
        expect(kp.publicJwk.crv).toBe('Ed25519');
        expect(typeof kp.publicJwk.x).toBe('string');
        expect(kp.publicJwk.x.length).toBeGreaterThan(0);
    });

    it('produces a proof that verifies under its public JWK', () => {
        const kp = PopKeypair.generate();
        const proof = kp.prove('the-nonce', 'ws-1', 'sid-1');

        expect(proof.jwk).toEqual(kp.publicJwk);
        const pub = crypto.createPublicKey({ key: proof.jwk as crypto.JsonWebKey, format: 'jwk' });
        const ok = crypto.verify(
            null,
            popSignedInput('the-nonce', 'ws-1', 'sid-1'),
            pub,
            Buffer.from(proof.sig, 'base64url'),
        );
        expect(ok).toBe(true);
    });

    it('signature does not verify for a different challenge', () => {
        const kp = PopKeypair.generate();
        const proof = kp.prove('nonce-A', 'ws-1', 'sid-1');
        const pub = crypto.createPublicKey({ key: proof.jwk as crypto.JsonWebKey, format: 'jwk' });
        const ok = crypto.verify(
            null,
            popSignedInput('nonce-B', 'ws-1', 'sid-1'),
            pub,
            Buffer.from(proof.sig, 'base64url'),
        );
        expect(ok).toBe(false);
    });

    it('refuses to prove after discard (private key wiped)', () => {
        const kp = PopKeypair.generate();
        kp.discard();
        expect(() => kp.prove('n', 'ws', 'sid')).toThrow(/discarded/);
    });

    it('each connection gets a distinct key', () => {
        expect(PopKeypair.generate().publicJwk.x).not.toBe(PopKeypair.generate().publicJwk.x);
    });
});

import { verify, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GEN_CA_SUBJECT } from '../src/core/gen-ca.js';
import { osTrustStore, pemThumbprints, thumbprintOf, x509Issuer } from '../src/main/gen-ca.js';

// Read the certificate's outer DER fields independently of the builder. OpenSSL verifies the
// actual TBS/signature bytes below; a fingerprint match alone cannot satisfy these checks.
function field(bytes: Buffer, at: number): { encoded: Buffer; body: Buffer; end: number } {
    const first = bytes[at + 1]!;
    const count = first < 128 ? 0 : first & 127;
    const size = count === 0 ? first : bytes.subarray(at + 2, at + 2 + count).reduce((n, b) => n * 256 + b, 0);
    const start = at + 2 + count;
    const end = start + size;
    if (end > bytes.length) throw new Error('truncated certificate');
    return { encoded: bytes.subarray(at, end), body: bytes.subarray(start, end), end };
}

describe('certificate signatures and OS thumbprint identifiers are separate', () => {
    for (const kind of ['CA', 'leaf'] as const) {
        it(`${kind}: SHA-256 signs the certificate; SHA-1 only identifies its OS-store entry`, async () => {
            const now = Date.now();
            const ca = x509Issuer.ca(now);
            const material = kind === 'CA' ? ca : x509Issuer.leaf(ca, ['security-proof.gen'], now);
            const cert = new X509Certificate(material.certPem);
            const signer = new X509Certificate(ca.certPem);
            const outer = field(cert.raw, 0);
            const tbs = field(outer.body, 0);
            const algorithm = field(outer.body, tbs.end);
            const signature = field(outer.body, algorithm.end);

            // sha256WithRSAEncryption, including its NULL parameters. Check the signature,
            // not just the advertised OID or X509Certificate.verify's algorithm selection.
            expect(algorithm.encoded.toString('hex'), 'signature algorithm is RSA with SHA-256').toBe('300d06092a864886f70d01010b0500');
            expect(signature.body[0]).toBe(0);
            expect(verify('sha256', tbs.encoded, signer.publicKey, signature.body.subarray(1)), 'actual certificate signature verifies with SHA-256').toBe(true);
            expect(verify('sha1', tbs.encoded, signer.publicKey, signature.body.subarray(1)), 'actual certificate signature does not verify with SHA-1').toBe(false);
            expect(cert.verify(signer.publicKey)).toBe(true);
            expect(signer.subject).toContain(GEN_CA_SUBJECT.commonName);

            const identifier = thumbprintOf(cert);
            expect(identifier).toBe(cert.fingerprint.replaceAll(':', ''));
            expect(identifier).toMatch(/^[0-9A-F]{40}$/);
            expect(identifier).not.toBe(cert.fingerprint256.replaceAll(':', ''));
            expect(pemThumbprints(material.certPem)).toEqual([identifier]);
            const present = osTrustStore('linux', async () => { throw new Error('bundle lookup must be read-only'); }, () => material.certPem);
            const absent = osTrustStore('linux', async () => { throw new Error('bundle lookup must be read-only'); }, () => '');
            await expect(present.has(identifier)).resolves.toBe(true);
            await expect(absent.has(identifier)).resolves.toBe(false);
        });
    }
});

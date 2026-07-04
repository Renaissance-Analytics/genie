import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { SessionCa } from '../site-ca';

/**
 * Serve-local-sites Phase D — the per-session Genie CA (design §4/§5). We assert
 * the trust guarantees WITHOUT Electron: a leaf issued by a session CA chains to
 * THAT CA (and is a usable TLS server cert), and a leaf from a DIFFERENT session's
 * CA fails closed — the crypto layer of the per-connection `.gen` isolation.
 */
describe('SessionCa', () => {
    it('issues a leaf that chains to its own CA and is TLS-usable', () => {
        const ca = new SessionCa();
        const leaf = ca.issueLeaf('tynn.gen');

        const leafX = new X509Certificate(leaf.certPem);
        const caX = new X509Certificate(ca.caPem);
        expect(leafX.checkIssued(caX)).toBe(true);
        expect(leafX.verify(caX.publicKey)).toBe(true);
        // Covers the .gen name via SAN (what Chromium matches on).
        expect(leafX.subjectAltName).toContain('DNS:tynn.gen');
        // The leaf + key make a valid TLS server secure context.
        expect(tls.createSecureContext({ cert: leaf.certPem, key: leaf.keyPem })).toBeTruthy();
    });

    it('verifyLeaf accepts its OWN leaf and rejects another session CA’s leaf', () => {
        const caA = new SessionCa();
        const caB = new SessionCa();
        const leafA = caA.issueLeaf('tynn.gen');
        const leafB = caB.issueLeaf('tynn.gen'); // SAME .gen name, different session CA

        // Each session trusts only its own CA's leaf — hostA's tynn.gen ≠ hostB's.
        expect(caA.verifyLeaf(leafA.certPem)).toBe(true);
        expect(caA.verifyLeaf(leafB.certPem)).toBe(false);
        expect(caB.verifyLeaf(leafB.certPem)).toBe(true);
        expect(caB.verifyLeaf(leafA.certPem)).toBe(false);
    });

    it('verifyLeaf rejects garbage / non-cert input (fail closed)', () => {
        const ca = new SessionCa();
        expect(ca.verifyLeaf('not a certificate')).toBe(false);
        expect(ca.verifyLeaf(Buffer.from([1, 2, 3, 4]))).toBe(false);
        expect(ca.verifyLeaf('')).toBe(false);
    });

    it('caches the leaf per name (stable identity across issuances)', () => {
        const ca = new SessionCa();
        const first = ca.issueLeaf('tynn.gen');
        const second = ca.issueLeaf('TYNN.GEN'); // case-insensitive cache key
        expect(second.certPem).toBe(first.certPem);
        // A different name gets its own leaf.
        expect(ca.issueLeaf('mail.gen').certPem).not.toBe(first.certPem);
    });
});

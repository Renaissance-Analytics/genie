import { describe, expect, it, vi } from 'vitest';
import crypto, { X509Certificate } from 'node:crypto';
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

/**
 * genie#78. The serial number is the ONE random field in these certs, and a DER
 * INTEGER must be POSITIVE and MINIMALLY encoded. node-forge's DER writer strips
 * exactly ONE redundant pad byte, so a serial that began `00 00 <msb-clear>`
 * reached OpenSSL as `00 <msb-clear>` — still non-minimal. Every consumer
 * (`new X509Certificate`, `tls.createSecureContext`) then threw
 * `error:068000DD:asn1 encoding routines::illegal padding`. Measured at ~1 cert in
 * 500, which is exactly the intermittency seen here and in site-shim.test.ts.
 */
describe('SessionCa serial encoding (genie#78)', () => {
    /**
     * Force the pathological draw. `crypto.randomBytes` is the ONLY randomness the
     * serial comes from — keygen and signing use OpenSSL's own RNG — so pinning its
     * leading bytes makes the once-in-500 case happen every time. The remaining
     * bytes stay random so each cert still gets a distinct serial.
     */
    function withLeadingSerialBytes<T>(first: number, second: number, run: () => T): T {
        const realRandomBytes = crypto.randomBytes;
        const spy = vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => {
            const bytes = Buffer.from(realRandomBytes(size));
            bytes[0] = first;
            bytes[1] = second;
            return bytes;
        }) as typeof crypto.randomBytes);
        try {
            return run();
        } finally {
            spy.mockRestore();
        }
    }

    it('builds a usable CA + leaf when the serial draws a leading zero byte', () => {
        const { ca, leaf } = withLeadingSerialBytes(0x00, 0x03, () => {
            const session = new SessionCa();
            return { ca: session, leaf: session.issueLeaf('tynn.gen') };
        });

        expect(() => new X509Certificate(ca.caPem)).not.toThrow();
        expect(() => new X509Certificate(leaf.certPem)).not.toThrow();
        expect(ca.verifyLeaf(leaf.certPem)).toBe(true);
        // What the shim does with every issued leaf (site-proxy.ts secureContextFor).
        expect(tls.createSecureContext({ cert: leaf.certPem, key: leaf.keyPem })).toBeTruthy();
    });

    it('encodes every leading-byte draw as a valid DER INTEGER', () => {
        const ca = new SessionCa();
        // 0x00 is the redundant-pad case, 0x7f/0x80 straddle the sign bit, and 0xff
        // is the negative-pad branch of the same encoder.
        const edges = [0x00, 0x01, 0x7f, 0x80, 0xff];
        for (const first of edges) {
            for (const second of edges) {
                const certPem = withLeadingSerialBytes(first, second, () =>
                    // A fresh name each time — issueLeaf caches per name.
                    ca.issueLeaf(`s${first}-${second}.gen`).certPem,
                );
                const label = `serial draw ${first}/${second}`;
                expect(() => new X509Certificate(certPem), label).not.toThrow();
                expect(ca.verifyLeaf(certPem), label).toBe(true);
            }
        }
    });
});

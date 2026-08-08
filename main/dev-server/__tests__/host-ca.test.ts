import { describe, expect, it, vi } from 'vitest';
import crypto, { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import {
    generateGenCa,
    issueGenLeaf,
    loadOrCreateGenCa,
    trustStoreInstallCommand,
} from '../host-ca';

/**
 * The stable host-native `.gen` CA (story #238, task #674). Unlike the per-session
 * Testing-Browser CA, this one is PERSISTED and installed into the OS trust store
 * (owner-approved) so the machine's REAL browser trusts `https://<name>.gen`, and
 * it issues ONE multi-SAN leaf covering every live `.gen` for the host Caddy. The
 * crypto + persistence orchestration are pure/injected ⇒ testable here; the
 * elevated trust-store install is validated on a real machine.
 */
describe('host-ca — stable Genie local CA', () => {
    it('generates a self-signed CA usable as a signing anchor', () => {
        const ca = generateGenCa();
        const x = new X509Certificate(ca.caPem);
        expect(x.ca).toBe(true);
        expect(x.subject).toBe(x.issuer); // self-signed
        expect(x.verify(x.publicKey)).toBe(true);
        expect(ca.caKeyPem).toContain('PRIVATE KEY');
    });

    it('issues a multi-SAN leaf that chains to the CA and is TLS-usable', () => {
        const ca = generateGenCa();
        const leaf = issueGenLeaf(ca, ['moic.gen', 'app.gen']);
        const leafX = new X509Certificate(leaf.certPem);
        const caX = new X509Certificate(ca.caPem);
        expect(leafX.checkIssued(caX)).toBe(true);
        expect(leafX.verify(caX.publicKey)).toBe(true);
        expect(leafX.ca).toBe(false);
        // Every name is a DNS SAN — what the browser matches on.
        expect(leafX.subjectAltName).toContain('DNS:moic.gen');
        expect(leafX.subjectAltName).toContain('DNS:app.gen');
        expect(tls.createSecureContext({ cert: leaf.certPem, key: leaf.keyPem })).toBeTruthy();
    });

    it('a leaf verifies against its OWN CA but NOT a different one (isolation)', () => {
        const a = generateGenCa();
        const b = generateGenCa();
        const leaf = new X509Certificate(issueGenLeaf(a, ['x.gen']).certPem);
        expect(leaf.verify(new X509Certificate(a.caPem).publicKey)).toBe(true);
        expect(leaf.verify(new X509Certificate(b.caPem).publicKey)).toBe(false);
    });

    it('sorts + dedupes SANs and sets CN to the first name', () => {
        const ca = generateGenCa();
        const leaf = new X509Certificate(issueGenLeaf(ca, ['b.gen', 'a.gen', 'a.gen']).certPem);
        expect(leaf.subjectAltName).toBe('DNS:a.gen, DNS:b.gen');
        expect(leaf.subject).toContain('CN=a.gen');
    });

    it('refuses an empty name set or an injectable/non-.gen name', () => {
        const ca = generateGenCa();
        expect(() => issueGenLeaf(ca, [])).toThrow();
        expect(() => issueGenLeaf(ca, ['evil.gen\n0.0.0.0 bank.com'])).toThrow();
        expect(() => issueGenLeaf(ca, ['notgen.test'])).toThrow();
    });

    it('encodes a valid cert even when the serial draws a leading zero byte (genie#78)', () => {
        const real = crypto.randomBytes;
        const spy = vi.spyOn(crypto, 'randomBytes').mockImplementation(((n: number) => {
            const b = Buffer.from(real(n));
            b[0] = 0x00;
            b[1] = 0x00;
            return b;
        }) as typeof crypto.randomBytes);
        try {
            const ca = generateGenCa();
            const leaf = issueGenLeaf(ca, ['x.gen']);
            expect(() => new X509Certificate(ca.caPem)).not.toThrow();
            expect(() => new X509Certificate(leaf.certPem)).not.toThrow();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('loadOrCreateGenCa — persistence', () => {
    it('generates + persists when the store is empty', async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        const { material, created } = await loadOrCreateGenCa({
            readCert: async () => null,
            readKey: async () => null,
            write,
        });
        expect(created).toBe(true);
        expect(write).toHaveBeenCalledOnce();
        expect(material.caPem).toContain('CERTIFICATE');
    });

    it('returns the existing CA without regenerating when one is stored + valid', async () => {
        const existing = generateGenCa();
        const write = vi.fn();
        const { material, created } = await loadOrCreateGenCa({
            readCert: async () => existing.caPem,
            readKey: async () => existing.caKeyPem,
            write,
        });
        expect(created).toBe(false);
        expect(write).not.toHaveBeenCalled();
        expect(material.caPem).toBe(existing.caPem);
    });

    it('regenerates when the stored cert is garbage', async () => {
        const write = vi.fn().mockResolvedValue(undefined);
        const { created } = await loadOrCreateGenCa({
            readCert: async () => 'not a cert',
            readKey: async () => 'nope',
            write,
        });
        expect(created).toBe(true);
        expect(write).toHaveBeenCalledOnce();
    });
});

describe('trustStoreInstallCommand — per platform (elevation)', () => {
    it('uses certutil -addstore Root on Windows', () => {
        const c = trustStoreInstallCommand('C:/pd/genie/gen-ca.crt', 'win32');
        expect(c.cmd).toBe('certutil');
        expect(c.args).toEqual(['-addstore', '-f', 'Root', 'C:/pd/genie/gen-ca.crt']);
        expect(c.needsElevation).toBe(true);
    });

    it('uses security add-trusted-cert on macOS', () => {
        const c = trustStoreInstallCommand('/tmp/gen-ca.crt', 'darwin');
        expect(c.cmd).toBe('security');
        expect(c.args).toContain('add-trusted-cert');
        expect(c.needsElevation).toBe(true);
    });

    it('installs into the CA anchors on Linux', () => {
        const c = trustStoreInstallCommand('/tmp/gen-ca.crt', 'linux');
        expect(c.needsElevation).toBe(true);
        expect(c.cmd.length).toBeGreaterThan(0);
        expect(c.args).toContain('/tmp/gen-ca.crt');
    });
});

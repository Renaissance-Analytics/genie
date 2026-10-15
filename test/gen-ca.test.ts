import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GEN_CA_SUBJECT, RENEW_MARGIN_MS } from '../src/core/gen-ca.js';
import { GenCa, osTrustStore, pemThumbprints, thumbprintOf, x509Issuer, type CertIssuer } from '../src/main/gen-ca.js';
import { issueCa, issueLeaf } from '../src/main/x509.js';

/**
 * GENIE'S `.gen` CA ON DISK (main/gen-ca.ts + the node:crypto X.509 builder, main/x509.ts). Real files in a temp dir
 * and real certificates — the point is that they VERIFY — with the issuer wrapped so every issuance is COUNTED:
 *
 * - adoption order own > Genie 1's > new, with Genie 1's files untouched (md5) and its key copied, restricted, recorded;
 * - the leaf re-issued when the host set changes or within 30 days of expiry, and not otherwise (not on a restart);
 * - a generated leaf verifies against its CA (and not against another), Genie 1's PKCS#1 CA included;
 * - the trust store asked by thumbprint, read-only, with positive and negative controls.
 */

const DAY = 24 * 60 * 60 * 1000;
const md5 = (path: string) => createHash('md5').update(readFileSync(path)).digest('hex');

function counting(): CertIssuer & { cas: number; leaves: number } {
    const c: CertIssuer & { cas: number; leaves: number } = {
        cas: 0,
        leaves: 0,
        ca: (now) => { c.cas++; return x509Issuer.ca(now); },
        leaf: (ca, hosts, now) => { c.leaves++; return x509Issuer.leaf(ca, hosts, now); },
    };
    return c;
}

/** A Genie 1 `host-gen` folder: its CA as Genie 1 wrote it — the key in PKCS#1 (`BEGIN RSA PRIVATE KEY`), CRLF endings. */
function genie1Folder(path: string): { cert: string; key: string; thumbprint: string } {
    mkdirSync(path, { recursive: true });
    const now = Date.now();
    const issued = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(now - 60 * DAY), notAfter: new Date(now + 3600 * DAY) });
    const pkcs1 = createPrivateKey(issued.keyPem).export({ type: 'pkcs1', format: 'pem' }) as string;
    const cert = join(path, 'gen-ca.crt');
    const key = join(path, 'gen-ca.key');
    writeFileSync(cert, issued.certPem.replace(/\n/g, '\r\n'));
    writeFileSync(key, pkcs1.replace(/\n/g, '\r\n'));
    // Genie 1's leaf sits beside it and is none of Genie 2's business.
    writeFileSync(join(path, 'gen-leaf.crt'), 'genie 1 leaf');
    return { cert, key, thumbprint: thumbprintOf(new X509Certificate(issued.certPem)) };
}

let root: string;
let own: string;
let clock: number;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'genie2-gen-ca-'));
    own = join(root, 'genie-home', 'runtime', 'gen-ca');
    clock = Date.now();
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const open = (v1Dirs: readonly string[], issuer: CertIssuer) => GenCa.open({ dir: own, v1Dirs, now: () => clock, issuer });

describe('which CA, on disk', () => {
    it('no own CA, Genie 1’s present: ADOPTED by copying — cert and key byte for byte, key restricted, adoption recorded, Genie 1’s files untouched, nothing issued', () => {
        const v1 = join(root, 'AppData', 'genie', 'host-gen');
        const g1 = genie1Folder(v1);
        const before = [md5(g1.cert), md5(g1.key), md5(join(v1, 'gen-leaf.crt'))];
        const issuer = counting();

        const ca = open([join(root, 'nowhere', 'host-gen'), v1], issuer);

        expect(ca.source).toBe('adopted-v1');
        expect(ca.thumbprint).toBe(g1.thumbprint);
        expect(issuer.cas).toBe(0);
        expect(md5(join(own, 'ca.crt'))).toBe(before[0]);
        expect(md5(join(own, 'ca.key'))).toBe(before[1]);
        if (process.platform !== 'win32') expect(statSync(join(own, 'ca.key')).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(join(own, 'adopted.json'), 'utf8'))).toMatchObject({ from: v1, thumbprint: g1.thumbprint });
        // Genie 1's folder exactly as it was.
        expect([md5(g1.cert), md5(g1.key), md5(join(v1, 'gen-leaf.crt'))]).toEqual(before);

        // The next start finds it as Genie 2's own: no second adoption, nothing issued.
        const again = open([v1], issuer);
        expect(again.source).toBe('own');
        expect(again.thumbprint).toBe(g1.thumbprint);
        expect(issuer.cas).toBe(0);
    });

    it('own > Genie 1’s: with both present, Genie 2’s own CA is used and Genie 1’s is not copied', () => {
        const issuer = counting();
        const first = open([], issuer);
        expect(first.source).toBe('created');
        const ownBytes = md5(join(own, 'ca.crt'));
        const v1 = join(root, 'AppData', 'genie', 'host-gen');
        const g1 = genie1Folder(v1);

        const ca = open([v1], issuer);
        expect(ca.source).toBe('own');
        expect(ca.thumbprint).toBe(first.thumbprint);
        expect(ca.thumbprint).not.toBe(g1.thumbprint);
        expect(md5(join(own, 'ca.crt'))).toBe(ownBytes);
        expect(existsSync(join(own, 'adopted.json'))).toBe(false);
        expect(issuer.cas).toBe(1);
    });

    it('neither: a NEW CA — "Genie Local Development CA", O=Genie, a CA, ten years, key restricted — issued once', () => {
        const issuer = counting();
        const ca = open([join(root, 'no-genie-1', 'host-gen')], issuer);
        expect(ca.source).toBe('created');
        expect(issuer.cas).toBe(1);
        const cert = new X509Certificate(readFileSync(join(own, 'ca.crt')));
        expect(cert.ca).toBe(true);
        expect(cert.subject).toContain('CN=Genie Local Development CA');
        expect(cert.subject).toContain('O=Genie');
        expect(cert.issuer).toBe(cert.subject);
        expect(cert.verify(cert.publicKey)).toBe(true);
        expect(Date.parse(cert.validTo) - clock).toBeGreaterThan(3649 * DAY);
        expect(thumbprintOf(cert)).toBe(ca.thumbprint);
        if (process.platform !== 'win32') expect(statSync(join(own, 'ca.key')).mode & 0o777).toBe(0o600);
    });

    it('a CA within 30 days of expiry is renewed (a new one, so trust must be asked again)', () => {
        const issuer = counting();
        const first = open([], issuer);
        const notAfter = Date.parse(new X509Certificate(readFileSync(join(own, 'ca.crt'))).validTo);
        clock = notAfter - RENEW_MARGIN_MS + DAY;
        const renewed = open([], issuer);
        expect(renewed.source).toBe('created');
        expect(renewed.thumbprint).not.toBe(first.thumbprint);
        expect(issuer.cas).toBe(2);
    });
});

describe('the leaf', () => {
    it('issued for the hosts; NOT re-issued for the same set (any order), nor on a restart; re-issued when the set changes and within 30 days of expiry — counted', () => {
        const issuer = counting();
        const ca = open([], issuer);
        expect(ca.leafFor(['tynn.gen']).issued).toBe('missing');
        expect(issuer.leaves).toBe(1);
        expect(ca.leafFor(['tynn.gen']).issued).toBeNull();
        expect(issuer.leaves).toBe(1);
        expect(ca.leafFor(['tynn.gen', 'docs.gen']).issued).toBe('hosts-changed');
        expect(issuer.leaves).toBe(2);
        expect(ca.leafFor(['docs.gen', 'TYNN.gen']).issued).toBeNull();
        expect(issuer.leaves).toBe(2);

        // A restart reads the leaf on disk and keeps it.
        const restarted = open([], issuer);
        expect(restarted.leafFor(['docs.gen', 'tynn.gen']).issued).toBeNull();
        expect(issuer.leaves).toBe(2);

        const notAfter = Date.parse(new X509Certificate(readFileSync(join(own, 'leaf.crt'))).validTo);
        clock = notAfter - RENEW_MARGIN_MS - DAY;
        expect(restarted.leafFor(['docs.gen', 'tynn.gen']).issued).toBeNull();
        clock = notAfter - RENEW_MARGIN_MS + DAY;
        expect(restarted.leafFor(['docs.gen', 'tynn.gen']).issued).toBe('expiring');
        expect(issuer.leaves).toBe(3);
        if (process.platform !== 'win32') expect(statSync(join(own, 'leaf.key')).mode & 0o777).toBe(0o600);
    });

    it('a leaf left by a different CA is re-issued', () => {
        const issuer = counting();
        open([], issuer).leafFor(['tynn.gen']);
        // Another CA takes over the folder (renewal): the old leaf is not its leaf.
        clock = Date.parse(new X509Certificate(readFileSync(join(own, 'ca.crt'))).validTo) - RENEW_MARGIN_MS + DAY;
        const renewed = open([], issuer);
        expect(renewed.source).toBe('created');
        expect(renewed.leafFor(['tynn.gen']).issued).toBe('other-ca');
    });
});

describe('a generated leaf verifies against its CA (node:crypto X509Certificate)', () => {
    const checkLeaf = (caPem: string | Buffer, leafPem: string | Buffer, hosts: string[]) => {
        const ca = new X509Certificate(caPem);
        const leaf = new X509Certificate(leafPem);
        expect(leaf.verify(ca.publicKey)).toBe(true);
        expect(leaf.checkIssued(ca)).toBe(true);
        expect(leaf.issuer).toBe(ca.subject);
        expect(leaf.ca).toBe(false);
        for (const h of hosts) expect(leaf.checkHost(h)).toBe(h);
        expect(leaf.subjectAltName).toBe(hosts.map((h) => `DNS:${h}`).join(', '));
        expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1');
        const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY;
        expect(days).toBeGreaterThan(397);
        expect(days).toBeLessThan(398);
    };

    it('Genie 2’s own CA: verifies, names every host, serverAuth, 397 days — and does NOT verify against another CA (negative control)', () => {
        const ca = open([], x509Issuer);
        const files = ca.leafFor(['web.acme.gen', 'docs.gen', 'tynn.gen']);
        checkLeaf(readFileSync(ca.certPath), readFileSync(files.certPath), ['docs.gen', 'tynn.gen', 'web.acme.gen']);
        const other = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(), notAfter: new Date(Date.now() + 10 * DAY) });
        expect(new X509Certificate(readFileSync(files.certPath)).verify(new X509Certificate(other.certPem).publicKey)).toBe(false);
        expect(new X509Certificate(readFileSync(files.certPath)).checkHost('example.com')).toBeUndefined();
    });

    it('Genie 1’s adopted CA (PKCS#1 key, CRLF files): the leaf it signs verifies against Genie 1’s certificate, issuer copied byte for byte', () => {
        const v1 = join(root, 'AppData', 'genie', 'host-gen');
        const g1 = genie1Folder(v1);
        const ca = open([v1], x509Issuer);
        expect(ca.source).toBe('adopted-v1');
        const files = ca.leafFor(['tynn.gen']);
        checkLeaf(readFileSync(g1.cert), readFileSync(files.certPath), ['tynn.gen']);
    });

    it('the builder directly: a leaf for one host from a fresh CA verifies', () => {
        const now = Date.now();
        const ca = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(now - DAY), notAfter: new Date(now + 3650 * DAY) });
        const leaf = issueLeaf(ca, ['tynn.gen'], new Date(now - DAY), new Date(now + 396 * DAY));
        expect(new X509Certificate(leaf.certPem).verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
    });
});

describe('the OS trust store, asked by thumbprint (read-only)', () => {
    it('windows: one PowerShell Test-Path over both Root stores for THIS thumbprint; True → trusted, False → not, an error is an error', async () => {
        const asked: string[][] = [];
        let answer = { exitCode: 0, stdout: 'True\r\n' };
        const store = osTrustStore('win32', async (command, args) => { asked.push([command, ...args]); return answer; });
        const thumb = 'AB'.repeat(20);
        expect(await store.has(thumb)).toBe(true);
        expect(asked).toHaveLength(1);
        expect(asked[0]![0]).toBe('powershell');
        expect(asked[0]!.at(-1)).toBe(`(Test-Path -LiteralPath 'Cert:\\LocalMachine\\Root\\${thumb}') -or (Test-Path -LiteralPath 'Cert:\\CurrentUser\\Root\\${thumb}')`);
        answer = { exitCode: 0, stdout: 'False\r\n' };
        expect(await store.has(thumb)).toBe(false);
        answer = { exitCode: 1, stdout: 'powershell : access denied' };
        await expect(store.has(thumb)).rejects.toThrow(/exited 1/);
    });

    it('linux: the bundles are hashed; the CA in a bundle reads trusted, absent reads not (positive and negative control)', async () => {
        const ca = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(), notAfter: new Date(Date.now() + 10 * DAY) });
        const other = issueCa({ commonName: 'Example Root', organization: 'Example', notBefore: new Date(), notAfter: new Date(Date.now() + 10 * DAY) });
        const thumb = thumbprintOf(new X509Certificate(ca.certPem));
        expect(pemThumbprints(`${other.certPem}${ca.certPem}`)).toEqual([thumbprintOf(new X509Certificate(other.certPem)), thumb]);
        const withIt = osTrustStore('linux', async () => { throw new Error('no command on linux'); }, (p) => (p === '/etc/ssl/certs/ca-certificates.crt' ? `${other.certPem}${ca.certPem}` : null));
        const without = osTrustStore('linux', async () => { throw new Error('no command on linux'); }, (p) => (p === '/etc/ssl/certs/ca-certificates.crt' ? other.certPem : null));
        await expect(withIt.has(thumb)).resolves.toBe(true);
        await expect(without.has(thumb)).resolves.toBe(false);
    });
});

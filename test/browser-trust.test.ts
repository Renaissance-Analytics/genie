import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CERT_ACCEPT, CERT_REFUSE, CERT_USE_CHROMIUM } from '../src/core/browser-origins.js';
import { GEN_CA_SUBJECT } from '../src/core/gen-ca.js';
import { GenLeafContexts, genCertificateVerifier } from '../src/main/browser-trust.js';
import { issueCa, issueLeaf } from '../src/main/x509.js';

/**
 * THE GENIE BROWSER TRUSTS GENIE'S CA FOR `.gen` HOSTS — AND NOTHING MORE (S7). Real certificates from Genie's own
 * X.509 builder: Genie's CA, an unrelated CA, and an IMPOSTOR CA that copies Genie's CA name exactly (so only the
 * signature tells them apart). The verifier is what the pane session's setCertificateVerifyProc answers with.
 * Counted: two accepts, every refusal by number, and the non-.gen control.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15);
const valid = [new Date(NOW - DAY), new Date(NOW + 300 * DAY)] as const;

const genie = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 3650 * DAY) });
const other = issueCa({ commonName: 'Example Other CA', organization: 'Example', notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 3650 * DAY) });
const impostor = issueCa({ ...GEN_CA_SUBJECT, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 3650 * DAY) });

const genieLeaf = issueLeaf(genie, ['site-a.gen', 'site-b.gen'], ...valid);
const otherLeafGen = issueLeaf(other, ['site-a.gen'], ...valid);
const impostorLeafGen = issueLeaf(impostor, ['site-a.gen'], ...valid);
const genieLeafNonGen = issueLeaf(genie, ['example.com'], ...valid);
const genieLeafExpired = issueLeaf(genie, ['site-a.gen'], new Date(NOW - 400 * DAY), new Date(NOW - DAY));
const otherLeafWeb = issueLeaf(other, ['example.com'], ...valid);

const verify = genCertificateVerifier(genie.certPem, () => NOW);
const check = (hostname: string, certificatePem: string) => verify({ hostname, certificatePem });

describe('the certificate check', () => {
    it('ACCEPTS a leaf from Genie’s CA for each .gen host it names — exactly two', () => {
        const answers = [check('site-a.gen', genieLeaf.certPem), check('site-b.gen', genieLeaf.certPem)];
        expect(answers.filter((v) => v === CERT_ACCEPT)).toHaveLength(2);
    });

    it('REFUSES every other certificate for a .gen host — counted', () => {
        const refused = [
            // another CA's leaf for a .gen name
            check('site-a.gen', otherLeafGen.certPem),
            // a CA with Genie's exact NAME but another key: the name matches, the signature does not
            check('site-a.gen', impostorLeafGen.certPem),
            // Genie's leaf, but for a .gen host it does not name
            check('site-c.gen', genieLeaf.certPem),
            // Genie's leaf, expired
            check('site-a.gen', genieLeafExpired.certPem),
            // Genie's CA certificate itself presented as a server certificate
            check('site-a.gen', genie.certPem),
            // not a certificate at all
            check('site-a.gen', '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----'),
        ];
        expect(refused).toEqual(Array(6).fill(CERT_REFUSE));
    });

    it('a Genie-CA certificate for a NON-.gen host is refused — Genie’s root never vouches outside .gen', () => {
        expect(check('example.com', genieLeafNonGen.certPem)).toBe(CERT_REFUSE);
    });

    it('control: any other certificate for a non-.gen host keeps Chromium’s own verdict — nothing is accepted by us', () => {
        expect(check('example.com', otherLeafWeb.certPem)).toBe(CERT_USE_CHROMIUM);
        expect(check('example.org', otherLeafWeb.certPem)).toBe(CERT_USE_CHROMIUM);
    });

    it('the check is built from a CA, and refuses to be built from a leaf', () => {
        expect(() => genCertificateVerifier(genieLeaf.certPem)).toThrow(/not a CA/);
    });
});

describe('the tunnel’s TLS context (GenLeafContexts)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-browser-trust-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const certPath = join(dir, 'leaf.crt');
    const keyPath = join(dir, 'leaf.key');

    it('no context for a host no running site has; one context for the routes; a new one only when the leaf on disk changed', () => {
        const asked: string[][] = [];
        let current = genieLeaf;
        const source = {
            leafFor: (hosts: readonly string[]) => {
                asked.push([...hosts]);
                writeFileSync(certPath, current.certPem);
                writeFileSync(keyPath, current.keyPem);
                return { certPath, keyPath };
            },
        };
        let routes = [{ host: 'site-a.gen', target: '127.0.0.1:4101' }, { host: 'site-b.gen', target: '127.0.0.1:4102' }];
        const contexts = new GenLeafContexts(source, () => routes);

        expect(contexts.forHost('ghost.gen')).toBeNull();
        expect(asked).toEqual([]);
        const first = contexts.forHost('site-a.gen');
        expect(first).not.toBeNull();
        expect(contexts.forHost('site-b.gen')).toBe(first);
        expect(asked).toEqual([['site-a.gen', 'site-b.gen'], ['site-a.gen', 'site-b.gen']]);

        // The leaf was re-issued (a site added): a different certificate → a different context.
        routes = [...routes, { host: 'site-c.gen', target: '127.0.0.1:4103' }];
        current = issueLeaf(genie, ['site-a.gen', 'site-b.gen', 'site-c.gen'], ...valid);
        const second = contexts.forHost('site-c.gen');
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
    });
});

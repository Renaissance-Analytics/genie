import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { phpTrustFiles } from '../src/core/php-trust.js';
import { phpWorkerEnvWithTrust } from '../src/main/php-trust-host.js';

/**
 * A PHP SITE TRUSTS GENIE'S OWN CERTIFICATE AUTHORITY (moic acceptance W5b, 2026-10-17). The app's server side reaching
 * an https `.gen` address — `websockets.gen` for Laravel's broadcaster, another site's API — failed TLS verification
 * ("operation failed") while the same connection unverified got through: PHP's `openssl.cafile` was empty, so PHP used
 * the system bundle, which holds Genie's CA only if the person's OS store does (and on Windows, PHP's bundle is a
 * root-store export from Check and repair that can predate trusting it).
 *
 * So every PHP worker Genie runs gets an ini Genie owns — loaded LAST through PHP_INI_SCAN_DIR, after the toolchain's —
 * whose `openssl.cafile` and `curl.cainfo` name a bundle of the system roots PLUS Genie's CA. The person's php.ini is
 * never written. Certificates are invented fixtures (not real keys).
 */

const GENIE_CA = '-----BEGIN CERTIFICATE-----\nR0VOSUUtQ0EtRVhBTVBMRQ==\n-----END CERTIFICATE-----\n';
const SYSTEM = '-----BEGIN CERTIFICATE-----\nU1lTVEVNLVJPT1QtMQ==\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nU1lTVEVNLVJPT1QtMg==\n-----END CERTIFICATE-----\n';
const certs = (pem: string) => pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;

describe('the bundle and the ini', () => {
    it("the bundle is the system roots plus Genie's CA; the ini points openssl AND curl at it", () => {
        const f = phpTrustFiles({ genCaPem: GENIE_CA, systemRootsPem: SYSTEM, dir: '/data/php-trust', platform: 'linux' });
        expect(certs(f.bundle)).toBe(3);
        expect(f.bundle).toContain('R0VOSUUtQ0EtRVhBTVBMRQ==');
        expect(f.bundle).toContain('U1lTVEVNLVJPT1QtMQ==');
        expect(f.ini).toContain(`openssl.cafile = "${f.bundlePath}"`);
        expect(f.ini).toContain(`curl.cainfo = "${f.bundlePath}"`);
        expect(f.iniPath.startsWith(f.confDir)).toBe(true);
    });

    it("Genie's CA is in it ONCE, even when the system roots already hold it; with no system roots it is Genie's alone", () => {
        expect(certs(phpTrustFiles({ genCaPem: GENIE_CA, systemRootsPem: SYSTEM + GENIE_CA, dir: '/d', platform: 'linux' }).bundle)).toBe(3);
        expect(certs(phpTrustFiles({ genCaPem: GENIE_CA, systemRootsPem: null, dir: '/d', platform: 'linux' }).bundle)).toBe(1);
    });
});

describe("a PHP worker's environment", () => {
    function fakeFs() {
        const files = new Map<string, string>();
        return { files, fs: { readText: (p: string) => files.get(p) ?? null, writeText: (p: string, t: string) => { files.set(p, t); } } };
    }

    it("adds Genie's trust directory LAST in PHP_INI_SCAN_DIR — after the toolchain's — and writes the files", () => {
        const { files, fs } = fakeFs();
        const env = phpWorkerEnvWithTrust({ base: { PHP_INI_SCAN_DIR: ':/data/toolchain/php/conf.d' }, genCaPem: () => GENIE_CA, systemRoots: () => SYSTEM, dir: '/data/php-trust', platform: 'linux', fs });
        expect(env.PHP_INI_SCAN_DIR).toBe(':/data/toolchain/php/conf.d:/data/php-trust/conf.d');
        const ini = [...files.entries()].find(([p]) => p.endsWith('.ini'));
        expect(ini?.[1]).toMatch(/openssl\.cafile = ".*genie-ca-bundle\.pem"/);
        expect(certs([...files.entries()].find(([p]) => p.endsWith('.pem'))?.[1] ?? '')).toBe(3);
    });

    it("with nothing set before, the value starts with the separator (PHP's own scan dir still read); Windows uses ;", () => {
        const { fs } = fakeFs();
        expect(phpWorkerEnvWithTrust({ base: {}, genCaPem: () => GENIE_CA, systemRoots: () => null, dir: '/t', platform: 'linux', fs }).PHP_INI_SCAN_DIR).toBe(':/t/conf.d');
        const win = phpWorkerEnvWithTrust({ base: {}, genCaPem: () => GENIE_CA, systemRoots: () => null, dir: 'C:\\t', platform: 'win32', fs }).PHP_INI_SCAN_DIR ?? '';
        expect(win.startsWith(';')).toBe(true);
    });

    it('CONTROL: no Genie CA (it could not be opened) adds nothing and writes nothing — the base env as it was', () => {
        const { files, fs } = fakeFs();
        expect(phpWorkerEnvWithTrust({ base: { A: '1' }, genCaPem: () => null, systemRoots: () => SYSTEM, dir: '/t', platform: 'linux', fs })).toEqual({ A: '1' });
        expect(files.size).toBe(0);
    });

    it('compose gives every PHP worker this environment', () => {
        const compose = readFileSync('src/main/compose.ts', 'utf8');
        expect(compose).toMatch(/phpWorkerEnv: \(\) => phpWorkerEnvWithTrust\(/);
    });
});

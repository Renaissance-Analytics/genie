import { posix, win32 } from 'node:path';

/**
 * PHP TRUSTS GENIE'S OWN CERTIFICATE AUTHORITY (moic acceptance W5b, 2026-10-17). A PHP app's server side reaching an
 * https `.gen` address — `websockets.gen` for Laravel's broadcaster, another site's API — failed TLS verification: PHP's
 * `openssl.cafile` was empty, so it used the system bundle, which holds Genie's CA only when the person's OS store does.
 *
 * The bundle Genie gives PHP: the system roots (whatever the platform holds; none is allowed) PLUS Genie's CA, once. The
 * ini names it for both openssl (`file_get_contents('https://…')`, Guzzle's stream handler) and curl. Loaded through
 * PHP_INI_SCAN_DIR, after anything else — the person's php.ini is never written.
 */
export function phpTrustFiles(input: { genCaPem: string; systemRootsPem: string | null; dir: string; platform: NodeJS.Platform }): { bundlePath: string; bundle: string; confDir: string; iniPath: string; ini: string } {
    const body = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    const roots = (input.systemRootsPem ?? '').trim();
    const genie = input.genCaPem.trim();
    const already = roots !== '' && body(roots).includes(body(genie));
    const bundle = `${[roots, already ? '' : genie].filter((x) => x !== '').join('\n')}\n`;
    // The GIVEN platform's separator, never the host's (the beta.29 Windows VM verify: `:\t\conf.d` for a linux worker).
    const join = input.platform === 'win32' ? win32.join : posix.join;
    const bundlePath = join(input.dir, 'genie-ca-bundle.pem');
    const confDir = join(input.dir, 'conf.d');
    const iniPath = join(confDir, 'zzz-genie-trust.ini');
    const ini = [
        '; Written by Genie: the system roots plus Genie\'s own certificate authority, so a site\'s PHP can reach https .gen',
        '; addresses (websockets.gen, another site) verified. Your php.ini is untouched; this file is loaded last.',
        `curl.cainfo = "${bundlePath}"`,
        `openssl.cafile = "${bundlePath}"`,
        '',
    ].join('\n');
    return { bundlePath, bundle, confDir, iniPath, ini };
}

/** Where a platform keeps its system CA bundle (the first that exists is read). Windows has none on disk. */
export const SYSTEM_CA_BUNDLES: readonly string[] = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/ca-bundle.pem', '/etc/ssl/cert.pem'];

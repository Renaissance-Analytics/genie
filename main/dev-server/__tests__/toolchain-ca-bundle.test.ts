import { describe, expect, it } from 'vitest';
import { caBundleText, caBundlePath, joinFor, phpIniContents } from '../toolchain-versions';

/**
 * Genie's PHP could not make an outbound HTTPS request AT ALL.
 *
 * Reported from another workspace, and reproduced here against the real API with
 * Genie's own `toolchain/php/8.4.24`:
 *
 *   no cert config   -> FAIL errno=60 "unable to get local issuer certificate"
 *   with a CA bundle -> OK http=405
 *
 * The Windows PHP zip ships no CA bundle, and its compiled-in default points at
 * `C:\Program Files\Common Files\SSL/cert.pem`, which does not exist. Genie's
 * generated `php.ini` named no `curl.cainfo` and no `openssl.cafile`, not even
 * commented out — so every hosted PHP site failed every TLS handshake, to every
 * host. Node and Python were checked and are fine: both carry their own trust.
 *
 * It hides well. A developer's own PHP (Herd, XAMPP) has a bundle configured, so
 * the CLI and `artisan serve` work; only `hostServe: php` — the mode you would
 * use for anything real — fails.
 *
 * Genie exports the MACHINE's root store rather than shipping a bundle. A
 * shipped `cacert.pem` goes stale between releases and, worse, omits the
 * corporate roots a machine behind a TLS-inspecting proxy needs — on such a
 * machine a bundled Mozilla list fails where the OS store succeeds.
 */
describe('the CA bundle a Genie PHP needs', () => {
    const CERT_A = 'MIIBkTCB+w==';
    const CERT_B = 'MIIBkjCB/A==';

    it('assembles PEM blocks from raw DER, one per root', () => {
        const pem = caBundleText([
            { subject: 'CN=Root A', der: CERT_A },
            { subject: 'CN=Root B', der: CERT_B },
        ]);

        expect(pem.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(2);
        expect(pem.match(/-----END CERTIFICATE-----/g)).toHaveLength(2);
        expect(pem).toContain(CERT_A);
        expect(pem).toContain(CERT_B);
        // The subject rides along as a comment so the file is diagnosable by eye
        // — "which roots does this trust" is the first question when a handshake
        // fails behind a corporate proxy.
        expect(pem).toContain('CN=Root A');
    });

    it('refuses to build a bundle with no certificates in it', () => {
        // An empty `cacert.pem` is WORSE than none: curl opens it, finds no
        // issuer, and fails with the same errno 60 — while the ini now claims a
        // bundle is configured, so the next person stops looking here.
        expect(caBundleText([])).toBe('');
    });
});

describe('php.ini points at the bundle, but only when there is one', () => {
    const DIR = 'C:/genie/toolchain/php/8.4.24';

    it('names curl.cainfo AND openssl.cafile when a bundle exists', () => {
        // Both, not one — though only `curl.cainfo` is load-bearing on the
        // build Genie ships. Measured, rather than assumed: with no bundle at
        // all, curl fails errno 60 while `file_get_contents('https://…')`
        // still reaches the host, so PHP's stream layer is finding trust by
        // some other route on this build. `openssl.cafile` is set anyway so
        // every openssl consumer resolves to the SAME anchors, instead of the
        // answer depending on which build detail happens to rescue it.
        const ini = phpIniContents(DIR, 'win32', caBundlePath(DIR, 'win32'));

        expect(ini).toContain(`curl.cainfo = "${caBundlePath(DIR, 'win32')}"`);
        expect(ini).toContain(`openssl.cafile = "${caBundlePath(DIR, 'win32')}"`);
    });

    it('names NEITHER when no bundle could be produced', () => {
        // Pointing at a file that does not exist is a different, worse failure:
        // curl errno 77 "error setting certificate file". Leaving both unset
        // reproduces today's behaviour exactly, which is the correct fallback.
        const ini = phpIniContents(DIR, 'win32', null);

        expect(ini).not.toContain('curl.cainfo');
        expect(ini).not.toContain('openssl.cafile');
    });

    it('keeps every other setting when the bundle is added', () => {
        // Positive control: the assertions above pass just as happily against an
        // ini generator that returned an empty string.
        const ini = phpIniContents(DIR, 'win32', caBundlePath(DIR, 'win32'));

        expect(ini).toContain('extension=curl');
        expect(ini).toContain('extension=openssl');
        expect(ini).toContain('memory_limit = 512M');
    });

    it('puts the bundle inside the version directory, so Remove takes it', () => {
        // Beside the binary, not in a shared location: two PHP versions are
        // independent installs, and deleting one must not strip the other's
        // trust.
        expect(caBundlePath(DIR, 'win32')).toBe(joinFor('win32', DIR, 'cacert.pem'));
    });
});

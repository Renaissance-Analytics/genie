import { describe, expect, it } from 'vitest';
import { macSigningVerdict } from '../mac-signing-verdict.mjs';

/**
 * Whether the macOS build is REALLY signed and notarized — checked, not assumed.
 *
 * Every release so far has produced an unsigned mac app and reported success.
 * electron-builder prints one line about it (`skipped macOS application code
 * signing`) in the middle of a few thousand, the job goes green, the release
 * publishes, and the first person to learn the app is unsigned is a user whose
 * Gatekeeper refuses to open it. macOS auto-update fails too: Squirrel.Mac
 * rejects an ad-hoc signature outright.
 *
 * That is the failure-that-reports-success shape this repo already treats as
 * worse than a hard stop, so the release says which of the four states it is
 * in, every time.
 *
 * The verdict is deliberately SEPARATE from the secrets question. An unsigned
 * build is expected while there is no certificate — it is not a build failure
 * and must not fail the release, or nothing ships until someone buys one. But
 * secrets present + signing absent is a real misconfiguration: someone paid for
 * a certificate and the build quietly ignored it, which nothing else would
 * catch.
 */

describe('macSigningVerdict', () => {
    const NOTARIZED =
        'Authority=Developer ID Application: Example Corp (AB12CD34EF)\n' +
        'Authority=Developer ID Certification Authority\n' +
        'TeamIdentifier=AB12CD34EF';

    it('reports a signed + notarized build as good', () => {
        const v = macSigningVerdict({
            codesign: NOTARIZED,
            spctl: 'source=Notarized Developer ID\naccepted',
            hadSecrets: true,
        });
        expect(v.state).toBe('signed-notarized');
        expect(v.ok).toBe(true);
    });

    it('catches a build signed but NOT notarized', () => {
        // Gatekeeper still blocks this on a machine that has never seen the
        // app, and Squirrel.Mac still refuses the update.
        const v = macSigningVerdict({
            codesign: NOTARIZED,
            spctl: 'rejected\nsource=Unnotarized Developer ID',
            hadSecrets: true,
        });
        expect(v.state).toBe('signed-not-notarized');
        expect(v.ok).toBe(false);
    });

    it('calls an ad-hoc signature what it is, not "signed"', () => {
        // `Signature=adhoc` is what the after-pack step applies to node-pty's
        // spawn-helper. It satisfies `codesign -dv` and satisfies nothing else,
        // so matching on "is there a signature" would call this a pass.
        const v = macSigningVerdict({
            codesign: 'Signature=adhoc\nCodeDirectory v=20400',
            spctl: 'rejected',
            hadSecrets: false,
        });
        expect(v.state).toBe('adhoc');
        expect(v.ok).toBe(true); // no certificate yet — expected, not a failure
    });

    it('treats an unsigned build as EXPECTED while no certificate exists', () => {
        // The release must still ship. Failing here would mean nothing ever
        // releases until someone buys a Developer ID.
        const v = macSigningVerdict({
            codesign: 'code object is not signed at all',
            spctl: 'rejected',
            hadSecrets: false,
        });
        expect(v.state).toBe('unsigned');
        expect(v.ok).toBe(true);
        expect(v.message).toMatch(/no signing certificate/i);
    });

    it('FAILS when secrets were provided and the build came out unsigned', () => {
        // The case nothing else catches: a certificate exists, someone is
        // paying for it, and the build silently ignored it.
        const v = macSigningVerdict({
            codesign: 'code object is not signed at all',
            spctl: 'rejected',
            hadSecrets: true,
        });
        expect(v.state).toBe('unsigned');
        expect(v.ok).toBe(false);
        expect(v.message).toMatch(/secrets/i);
    });

    it('does not mistake the word "Developer ID" in a rejection for a signature', () => {
        // spctl prints the authority it WOULD have wanted when it rejects.
        const v = macSigningVerdict({
            codesign: 'code object is not signed at all',
            spctl: 'rejected\nsource=no usable signature (Developer ID)',
            hadSecrets: false,
        });
        expect(v.state).toBe('unsigned');
    });
});

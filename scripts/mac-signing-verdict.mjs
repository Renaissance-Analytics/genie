/**
 * Is the built macOS app really signed and notarized?
 *
 * Releases have been publishing an unsigned mac app and reporting success:
 * electron-builder prints one `skipped macOS application code signing` line
 * among thousands, the job goes green, and the first person to find out is a
 * user whose Gatekeeper refuses to open it. macOS auto-update fails for the
 * same reason — Squirrel.Mac rejects an ad-hoc signature outright.
 *
 * So the release states which of four things it produced, every time.
 *
 * The verdict is separate from the SECRETS question on purpose. An unsigned
 * build is expected while there is no Developer ID certificate; failing on it
 * would mean nothing ships until someone buys one. Secrets present and signing
 * absent is the real fault — a certificate exists and the build ignored it —
 * and nothing else in the pipeline would notice.
 *
 * PURE: takes the two command outputs, returns a verdict. The caller runs
 * `codesign` and `spctl`.
 */

/**
 * @param {{ codesign: string, spctl: string, hadSecrets: boolean }} input
 * @returns {{ state: 'signed-notarized'|'signed-not-notarized'|'adhoc'|'unsigned', ok: boolean, message: string }}
 */
export function macSigningVerdict({ codesign, spctl, hadSecrets }) {
    const cs = String(codesign ?? '');
    const sp = String(spctl ?? '');

    // A real Developer ID signature names its authority. Matched on `codesign`
    // only: `spctl` prints the authority it WANTED when it rejects, so reading
    // that as evidence of a signature gets it exactly backwards.
    const developerId = /Authority=Developer ID Application:/.test(cs);
    // Ad-hoc is what the after-pack step applies to node-pty's spawn-helper. It
    // satisfies `codesign -dv` and nothing else, so "is there a signature" is
    // the wrong question to ask.
    const adhoc = !developerId && /Signature\s*=\s*adhoc/i.test(cs);
    const notarized = /source=Notarized Developer ID/.test(sp) || /\baccepted\b/.test(sp);

    if (developerId && notarized) {
        return {
            state: 'signed-notarized',
            ok: true,
            message: 'Signed with a Developer ID and notarized. Gatekeeper and auto-update both work.',
        };
    }
    if (developerId) {
        return {
            state: 'signed-not-notarized',
            ok: false,
            message:
                'Signed with a Developer ID but NOT notarized. Gatekeeper blocks this on a machine ' +
                'that has not seen it before, and Squirrel.Mac refuses the update. Check ' +
                'APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID.',
        };
    }

    const state = adhoc ? 'adhoc' : 'unsigned';
    if (hadSecrets) {
        return {
            state,
            ok: false,
            message:
                `Signing secrets are set but the build came out ${state}. The certificate was ` +
                'ignored — check that MAC_CSC_LINK is a base64 .p12 and MAC_CSC_KEY_PASSWORD matches it.',
        };
    }
    return {
        state,
        ok: true,
        message:
            `Build is ${state} because there is no signing certificate — MAC_CSC_LINK is not set. ` +
            'Expected, and not a build failure: macOS users must right-click → Open, and macOS ' +
            'auto-update will not work until a Developer ID is configured.',
    };
}

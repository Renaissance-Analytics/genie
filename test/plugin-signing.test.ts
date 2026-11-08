import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { packageSigningBytes } from '../src/core/plugin-integrity.js';
import { installDecision, verifyPluginSignature } from '../src/core/plugins.js';

/**
 * SIGNED BY DEFAULT (§6.7), OVER THE WHOLE PACKAGE (ADF B4). A publisher signs the package's digest (Ed25519 over
 * `genie-package/1 sha256:<digest>`); Genie verifies against the publisher keys it holds, each under its C1 id (`sha256:`
 * + hex SHA-256 of the key's SPKI DER). Unsigned, or signed by a key Genie does not know: NOT installable, except under
 * developer mode, labelled unsigned. A signature that is there and does not verify is TAMPERED: never installed, with
 * developer mode on or off.
 */
const pair = generateKeyPairSync('ed25519');
const KEY_ID = `sha256:${createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`;
const keys = { [KEY_ID]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const bytes = packageSigningBytes('b'.repeat(64));
const signature = sign(null, bytes, pair.privateKey).toString('base64');

describe('verifyPluginSignature', () => {
    it('a valid signature by a known key is signed; changed bytes or a garbage signature are TAMPERED; an unknown key or none is unsigned — each with its own reason', () => {
        expect(verifyPluginSignature({ bytes, signature, keyId: KEY_ID }, keys)).toEqual({ signed: true, keyId: KEY_ID });
        expect(verifyPluginSignature({ bytes: packageSigningBytes('c'.repeat(64)), signature, keyId: KEY_ID }, keys)).toEqual({ signed: false, tampered: true, reason: 'the signature does not match the package: a file changed, was added or was removed after signing' });
        expect(verifyPluginSignature({ bytes, signature: 'not base64 ed25519', keyId: KEY_ID }, keys)).toMatchObject({ signed: false, tampered: true });
        expect(verifyPluginSignature({ bytes, signature, keyId: 'sha256:someone-else' }, keys)).toEqual({ signed: false, tampered: false, reason: 'Genie does not know publisher key "sha256:someone-else"' });
        expect(verifyPluginSignature({ bytes, signature: null, keyId: KEY_ID }, keys)).toEqual({ signed: false, tampered: false, reason: 'no signature file (genie-plugin.sig) beside the manifest' });
    });
});

describe('installDecision', () => {
    it('signed installs; unsigned is refused unless developer mode is on, and then it is labelled; tampered is refused either way', () => {
        expect(installDecision({ signed: true, keyId: KEY_ID }, { developerMode: false })).toEqual({ install: true, label: `signed by ${KEY_ID}` });
        expect(installDecision({ signed: false, tampered: false, reason: 'no signature file (genie-plugin.sig) beside the manifest' }, { developerMode: false })).toEqual({ install: false, reason: 'unsigned plugins are not installed: no signature file (genie-plugin.sig) beside the manifest. Turn on developer mode to run a local unsigned plugin, labelled as such.' });
        expect(installDecision({ signed: false, tampered: false, reason: 'x' }, { developerMode: true })).toEqual({ install: true, label: 'UNSIGNED — developer mode' });
        for (const developerMode of [false, true]) {
            expect(installDecision({ signed: false, tampered: true, reason: 'the signature does not match the package' }, { developerMode })).toEqual({ install: false, reason: 'refused as tampered: the signature does not match the package. A package changed after it was signed never runs, with publisher checks on or off.' });
        }
    });
});

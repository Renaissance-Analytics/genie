import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { installDecision, verifyPluginSignature } from '../src/core/plugins.js';

/**
 * SIGNED BY DEFAULT (§6.7). A plugin's manifest bytes are signed (Ed25519) by its publisher; Genie
 * verifies against the publisher keys it carries. Unsigned, tampered, or signed by a key Genie does not
 * know → NOT installable, except a local dev install, which is allowed only when the person turned
 * developer mode on and is then labelled unsigned everywhere it shows.
 */

const pair = generateKeyPairSync('ed25519');
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keys = { 'example-2026': publicPem };
const bytes = Buffer.from(JSON.stringify({ id: 'com.example.p', name: 'P', version: '1.0.0', publisher: { name: 'Example Co', keyId: 'example-2026' } }));
const signature = sign(null, bytes, pair.privateKey).toString('base64');

describe('verifyPluginSignature', () => {
    it('a valid signature by a known key is signed; tampered bytes, a wrong key, a garbage signature, or no signature are not — each with its own reason', () => {
        expect(verifyPluginSignature({ bytes, signature, keyId: 'example-2026' }, keys)).toEqual({ signed: true, keyId: 'example-2026' });
        expect(verifyPluginSignature({ bytes: Buffer.concat([bytes, Buffer.from(' ')]), signature, keyId: 'example-2026' }, keys)).toEqual({ signed: false, reason: 'the signature does not match the manifest — the bytes changed after signing' });
        expect(verifyPluginSignature({ bytes, signature, keyId: 'someone-else' }, keys)).toEqual({ signed: false, reason: 'Genie does not know publisher key "someone-else"' });
        expect(verifyPluginSignature({ bytes, signature: 'not base64 ed25519', keyId: 'example-2026' }, keys)).toMatchObject({ signed: false, reason: expect.stringMatching(/does not match|not a valid signature/) });
        expect(verifyPluginSignature({ bytes, signature: null, keyId: 'example-2026' }, keys)).toEqual({ signed: false, reason: 'no signature file (genie-plugin.sig) beside the manifest' });
    });
});

describe('installDecision', () => {
    it('signed installs; unsigned is refused unless developer mode is on, and then it is labelled', () => {
        expect(installDecision({ signed: true, keyId: 'example-2026' }, { developerMode: false })).toEqual({ install: true, label: 'signed by example-2026' });
        expect(installDecision({ signed: false, reason: 'no signature file (genie-plugin.sig) beside the manifest' }, { developerMode: false })).toEqual({ install: false, reason: 'unsigned plugins are not installed: no signature file (genie-plugin.sig) beside the manifest. Turn on developer mode to run a local unsigned plugin, labelled as such.' });
        expect(installDecision({ signed: false, reason: 'x' }, { developerMode: true })).toEqual({ install: true, label: 'UNSIGNED — developer mode' });
    });
});

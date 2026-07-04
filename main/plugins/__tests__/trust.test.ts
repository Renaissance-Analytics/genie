import { describe, expect, it } from 'vitest';
import {
    evaluateManifestTrust,
    evaluateMarketplaceTrust,
    pluginRowIsSurfaceable,
    restrictGrantsForTrust,
    trustStoreFromKeys,
    type TrustedKey,
} from '../trust';
import { generateSigningKeyPair, signManifest, type Ed25519KeyPair } from '../signing';
import type { PluginManifest, MarketplaceManifest } from '../manifest';

/**
 * Plugin TRUST evaluation (Phase 3, the security crux). A valid signature from a
 * trusted key over an untampered bundle is `trusted`; everything else is
 * `unsigned` (gated) or `untrusted` (refused). PURE — pass a fake trust store.
 */

const INTEGRITY = 'sha256-deadbeef';

function trustedKey(kp: Ed25519KeyPair, official = true): TrustedKey {
    return { keyId: kp.keyId, publicKeyPem: kp.publicKeyPem, label: 'Test Publisher', official };
}

/** A manifest signed by `kp`, declaring `integrity` + the key's id. */
function signedManifest(kp: Ed25519KeyPair, over: Partial<PluginManifest> = {}): PluginManifest {
    const base: PluginManifest = {
        id: 'com.example.deck',
        namespace: 'deck',
        name: 'Deck',
        version: '1.0.0',
        integrity: INTEGRITY,
        publisher: { name: 'Example', keyId: kp.keyId },
        ...over,
    };
    return signManifest(base as unknown as Record<string, unknown>, kp.privateKeyPem) as unknown as PluginManifest;
}

describe('evaluateManifestTrust', () => {
    it('TRUSTS a valid signature from a trusted key over a matching bundle', () => {
        const kp = generateSigningKeyPair();
        const store = trustStoreFromKeys([trustedKey(kp)]);
        const v = evaluateManifestTrust(signedManifest(kp), store, { recomputedIntegrity: INTEGRITY });
        expect(v.status).toBe('trusted');
        expect(v.official).toBe(true);
    });

    it('marks a manifest with NO signature as unsigned', () => {
        const store = trustStoreFromKeys([]);
        const m = { id: 'x', namespace: 'x', name: 'X', version: '1.0.0' } as PluginManifest;
        expect(evaluateManifestTrust(m, store, { recomputedIntegrity: INTEGRITY }).status).toBe('unsigned');
    });

    it('REFUSES (untrusted) a signature from a key NOT in the store', () => {
        const signer = generateSigningKeyPair();
        const store = trustStoreFromKeys([trustedKey(generateSigningKeyPair())]); // a DIFFERENT key
        const v = evaluateManifestTrust(signedManifest(signer), store, { recomputedIntegrity: INTEGRITY });
        expect(v.status).toBe('untrusted');
        expect(v.reason).toMatch(/untrusted key/i);
    });

    it('REFUSES (untrusted) when the code integrity does NOT match (tampered code)', () => {
        const kp = generateSigningKeyPair();
        const store = trustStoreFromKeys([trustedKey(kp)]);
        const v = evaluateManifestTrust(signedManifest(kp), store, { recomputedIntegrity: 'sha256-DIFFERENT' });
        expect(v.status).toBe('untrusted');
        expect(v.reason).toMatch(/integrity/i);
    });

    it('REFUSES (untrusted) a manifest tampered AFTER signing', () => {
        const kp = generateSigningKeyPair();
        const store = trustStoreFromKeys([trustedKey(kp)]);
        const signed = signedManifest(kp);
        // Flip a signed field WITHOUT re-signing → signature no longer verifies.
        const tampered = { ...signed, name: 'Evil' } as PluginManifest;
        const v = evaluateManifestTrust(tampered, store, { recomputedIntegrity: INTEGRITY });
        expect(v.status).toBe('untrusted');
        expect(v.reason).toMatch(/signature verification failed/i);
    });

    it('short-circuits first-party bundled plugins to trusted', () => {
        const store = trustStoreFromKeys([]);
        const m = { id: 'ai.genie.hello', namespace: 'hello', name: 'Hello', version: '1.0.0' } as PluginManifest;
        expect(evaluateManifestTrust(m, store, { firstParty: true }).status).toBe('trusted');
    });
});

describe('evaluateMarketplaceTrust', () => {
    it('trusts a validly-signed index; refuses a wrong-key one', () => {
        const kp = generateSigningKeyPair();
        const store = trustStoreFromKeys([trustedKey(kp)]);
        const idx: MarketplaceManifest = {
            id: 'com.example.mkt',
            name: 'Market',
            plugins: [{ id: 'com.example.deck', name: 'Deck', repo: 'https://x/y.git' }],
            publisher: { name: 'Example', keyId: kp.keyId },
        };
        const signed = signManifest(idx as unknown as Record<string, unknown>, kp.privateKeyPem) as unknown as MarketplaceManifest;
        expect(evaluateMarketplaceTrust(signed, store).status).toBe('trusted');
        expect(evaluateMarketplaceTrust({ ...signed, name: 'Tampered' }, store).status).toBe('untrusted');
        expect(evaluateMarketplaceTrust(idx, store).status).toBe('unsigned'); // no signature
    });
});

describe('pluginRowIsSurfaceable (the fail-closed runtime gate)', () => {
    const base = { enabled: true, trust: 'trusted' as const, dev_approved: false };
    it('surfaces a trusted, enabled plugin', () => {
        expect(pluginRowIsSurfaceable(base)).toBe(true);
    });
    it('never surfaces a disabled plugin', () => {
        expect(pluginRowIsSurfaceable({ ...base, enabled: false })).toBe(false);
    });
    it('never surfaces an untrusted plugin', () => {
        expect(pluginRowIsSurfaceable({ ...base, trust: 'untrusted' })).toBe(false);
    });
    it('surfaces an unsigned plugin ONLY when dev-approved', () => {
        expect(pluginRowIsSurfaceable({ ...base, trust: 'unsigned', dev_approved: false })).toBe(false);
        expect(pluginRowIsSurfaceable({ ...base, trust: 'unsigned', dev_approved: true })).toBe(true);
    });
});

describe('restrictGrantsForTrust', () => {
    const grants = { fs: { workspace: true }, network: { 'api.example.com': true }, genieApi: { openFileForUser: true } };
    it('keeps everything for a trusted plugin', () => {
        expect(restrictGrantsForTrust('trusted', grants).network).toEqual({ 'api.example.com': true });
    });
    it('strips network for unsigned/untrusted (restricted run)', () => {
        expect(restrictGrantsForTrust('unsigned', grants).network).toEqual({});
        expect(restrictGrantsForTrust('unsigned', grants).fs).toEqual({ workspace: true }); // fs kept
    });
});

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    computeBundleIntegrity,
    keyIdForPublicKey,
    generateSigningKeyPair,
    signingPayload,
    verifyDetached,
} from '../signing';
import { collectBundleFiles } from '../bundle-files';
import {
    evaluateManifestTrust,
    trustStoreFromKeys,
    productionTrustStore,
    BUNDLED_TRUSTED_KEYS,
    type TrustedKey,
} from '../trust';
import type { PluginManifest } from '../manifest';

/**
 * CI SIGNER ↔ APP VERIFIER round-trip (Phase 3, the shippability gate).
 *
 * Proves the deliverable end to end: the standalone CI signer
 * (`scripts/sign-plugin.mjs`) writes a `signature` + `publisher.keyId` + `integrity`
 * that the APP's own trust evaluation (`evaluateManifestTrust` → `verifyDetached`)
 * ACCEPTS when the public key is trusted, and REFUSES when the code is tampered,
 * the manifest is tampered, or a different key signs. The signer and verifier
 * share ONE crypto core (`signing-core`) + ONE bundle walk (`bundle-files`), so
 * this is a true cross-boundary check, not a re-implementation.
 *
 * It also asserts the OWNER's real embedded public key resolves under the
 * published keyId — the live trust root Genie ships with.
 */

const SCRIPT = path.resolve(__dirname, '../../../scripts/sign-plugin.mjs');
const OWNER_KEY_ID = 'ed25519-bHc2Rt62EgjmpE5Fd7-QsJeNi36BsAwckJ4bEyx4BCE';

const tmpDirs: string[] = [];
afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Materialise a small fixture plugin (manifest + a couple of code files). */
function makeFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-plugin-sign-'));
    tmpDirs.push(dir);
    fs.writeFileSync(
        path.join(dir, 'genie-plugin.json'),
        JSON.stringify(
            {
                id: 'com.example.roundtrip',
                namespace: 'rt',
                name: 'Round Trip',
                version: '1.0.0',
                publisher: { name: 'Example Co' },
                entry: { tools: 'tools.cjs' },
                mcpTools: [{ name: 'hello', description: 'say hi', inputSchema: { type: 'object' } }],
            },
            null,
            2,
        ),
    );
    fs.writeFileSync(path.join(dir, 'tools.cjs'), 'module.exports = { hello: () => "hi" };\n');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib', 'util.js'), '// util\n');
    return dir;
}

/** Run the real CI signer against `dir` with the given private key. */
function runSigner(dir: string, privateKeyPem: string, expectKeyId?: string): void {
    execFileSync(
        process.execPath,
        [SCRIPT, dir, ...(expectKeyId ? ['--expect-key-id', expectKeyId] : [])],
        { env: { ...process.env, GENIE_PLUGIN_SIGNING_KEY: privateKeyPem }, stdio: 'pipe' },
    );
}

function readManifest(dir: string): PluginManifest {
    return JSON.parse(fs.readFileSync(path.join(dir, 'genie-plugin.json'), 'utf8')) as PluginManifest;
}

/** Recompute integrity the way the app installer does (shared walk + hash). */
function recomputeIntegrity(dir: string): string {
    return computeBundleIntegrity(collectBundleFiles(dir));
}

function keyFor(pub: string, official = true): TrustedKey {
    return { keyId: keyIdForPublicKey(pub), publicKeyPem: pub, label: 'Test Publisher', official };
}

describe('sign-plugin.mjs → app trust round-trip', () => {
    it('a script-signed plugin is TRUSTED by the app when its key is in the store', () => {
        const kp = generateSigningKeyPair();
        const dir = makeFixture();
        runSigner(dir, kp.privateKeyPem, kp.keyId);

        const manifest = readManifest(dir);
        // The signer stamped the derived keyId + a real integrity + signature.
        expect(manifest.publisher?.keyId).toBe(kp.keyId);
        expect(manifest.integrity).toMatch(/^sha256-[0-9a-f]{64}$/);
        expect(manifest.signature).toBeTruthy();

        // Raw verifier accepts, and the full trust evaluation resolves `trusted`.
        expect(
            verifyDetached(
                signingPayload(manifest as unknown as Record<string, unknown>),
                manifest.signature!,
                kp.publicKeyPem,
            ),
        ).toBe(true);

        const store = trustStoreFromKeys([keyFor(kp.publicKeyPem)]);
        const verdict = evaluateManifestTrust(manifest, store, { recomputedIntegrity: recomputeIntegrity(dir) });
        expect(verdict.status).toBe('trusted');
        expect(verdict.official).toBe(true);
    });

    it('REFUSES (untrusted) when a CODE file is tampered after signing', () => {
        const kp = generateSigningKeyPair();
        const dir = makeFixture();
        runSigner(dir, kp.privateKeyPem);
        const manifest = readManifest(dir);

        // Alter a signed code file → recomputed integrity no longer matches.
        fs.writeFileSync(path.join(dir, 'tools.cjs'), 'module.exports = { hacked: true };\n');

        const store = trustStoreFromKeys([keyFor(kp.publicKeyPem)]);
        const verdict = evaluateManifestTrust(manifest, store, { recomputedIntegrity: recomputeIntegrity(dir) });
        expect(verdict.status).toBe('untrusted');
        expect(verdict.reason).toMatch(/integrity/i);
    });

    it('REFUSES (untrusted) when the MANIFEST is tampered after signing', () => {
        const kp = generateSigningKeyPair();
        const dir = makeFixture();
        runSigner(dir, kp.privateKeyPem);
        const manifest = readManifest(dir);

        // Flip a signed field without re-signing → signature no longer verifies.
        const tampered = { ...manifest, name: 'Evil' } as PluginManifest;
        const store = trustStoreFromKeys([keyFor(kp.publicKeyPem)]);
        const verdict = evaluateManifestTrust(tampered, store, { recomputedIntegrity: recomputeIntegrity(dir) });
        expect(verdict.status).toBe('untrusted');
        expect(verdict.reason).toMatch(/signature verification failed/i);
    });

    it('REFUSES (untrusted) when a DIFFERENT key is trusted (wrong key)', () => {
        const signer = generateSigningKeyPair();
        const other = generateSigningKeyPair();
        const dir = makeFixture();
        runSigner(dir, signer.privateKeyPem);
        const manifest = readManifest(dir);

        const store = trustStoreFromKeys([keyFor(other.publicKeyPem)]); // signer's key NOT present
        const verdict = evaluateManifestTrust(manifest, store, { recomputedIntegrity: recomputeIntegrity(dir) });
        expect(verdict.status).toBe('untrusted');
        expect(verdict.reason).toMatch(/untrusted key/i);
    });

    it('the signer REFUSES to sign when --expect-key-id does not match the key', () => {
        const kp = generateSigningKeyPair();
        const dir = makeFixture();
        expect(() => runSigner(dir, kp.privateKeyPem, 'ed25519-not-the-right-id')).toThrow();
        // Manifest must be untouched — no signature written on a mismatch.
        expect(readManifest(dir).signature).toBeUndefined();
    });
});

describe("the owner's live trust root", () => {
    it("resolves the OWNER's public key under the published keyId", () => {
        const entry = BUNDLED_TRUSTED_KEYS.find((k) => k.keyId === OWNER_KEY_ID);
        expect(entry, 'BUNDLED_TRUSTED_KEYS must contain the Genie Official key').toBeTruthy();
        expect(entry!.official).toBe(true);
        expect(entry!.label).toBe('Genie Official');
        // The embedded keyId must be the true fingerprint of the embedded PEM.
        expect(keyIdForPublicKey(entry!.publicKeyPem)).toBe(OWNER_KEY_ID);
        // The LIVE production store the app uses resolves it too.
        expect(productionTrustStore().resolve(OWNER_KEY_ID)?.official).toBe(true);
    });
});

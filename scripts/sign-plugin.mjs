// @ts-check
/**
 * sign-plugin.mjs — sign a Genie plugin's `genie-plugin.json` in CI.
 *
 * Dep-free Node (built-in `crypto` / `fs` / `path` only). It REUSES the app's own
 * signing algorithm by importing the SHARED dep-free core
 * (`../main/plugins/signing-core.mjs`) — the exact same `computeBundleIntegrity` /
 * `signingPayload` / `canonicalJson` / `keyIdForPublicKey` / `signManifest` that
 * `main/plugins/signing.ts` re-exports and the app's `verifyDetached` checks
 * against. So a signature this script writes VERIFIES under the app by
 * construction; there is no second copy of the crypto to drift.
 *
 * WHAT IT DOES (shares the app's exact modules, so it matches byte-for-byte):
 *   1. read the private key PEM from `GENIE_PLUGIN_SIGNING_KEY` (an env secret —
 *      NEVER a file in the repo);
 *   2. derive the public key + its `keyId` fingerprint from the private key;
 *   3. collect the plugin's CODE files via the SHARED `collectBundleFiles`
 *      (`../main/plugins/bundle-files.mjs`, the same walk `install.ts` uses):
 *      every file EXCEPT `.git/`, `node_modules/`, the manifest, and any `*.sig`;
 *   4. compute the `sha256-…` bundle integrity over those files;
 *   5. set `integrity` + `publisher.keyId` on the manifest, then write a detached
 *      Ed25519 `signature` over the canonical manifest (signature field stripped,
 *      integrity retained);
 *   6. write the signed manifest back to `genie-plugin.json`.
 *
 * USAGE:
 *   GENIE_PLUGIN_SIGNING_KEY="$(cat key.pem)" \
 *     node scripts/sign-plugin.mjs [pluginDir] [--expect-key-id <id>] [--publisher-name <name>] [--publisher-url <url>]
 *
 *   pluginDir            plugin root holding genie-plugin.json (default: cwd)
 *   --expect-key-id      fail unless the signing key derives to THIS keyId
 *                        (guards against a mis-set secret signing with the wrong
 *                        key — e.g. the official `ed25519-bHc2Rt62Eg…` id)
 *   --publisher-name     set publisher.name when the manifest lacks one
 *   --publisher-url      set publisher.url
 *
 * Exit code 0 on success; non-zero (with a clear message) on any failure —
 * fail-closed, so CI never publishes an unsigned/mis-signed plugin.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    computeBundleIntegrity,
    keyIdForPublicKey,
    signManifest,
} from '../main/plugins/signing-core.mjs';
import { collectBundleFiles, PLUGIN_MANIFEST_FILENAME } from '../main/plugins/bundle-files.mjs';

/** @param {string} msg */
function fail(msg) {
    console.error(`sign-plugin: ${msg}`);
    process.exit(1);
}

/** Minimal flag parser: positional pluginDir + `--flag value` options. */
function parseArgs(argv) {
    /** @type {{ pluginDir: string, expectKeyId?: string, publisherName?: string, publisherUrl?: string }} */
    const out = { pluginDir: '' };
    const rest = argv.slice(2);
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--expect-key-id') out.expectKeyId = rest[++i];
        else if (a === '--publisher-name') out.publisherName = rest[++i];
        else if (a === '--publisher-url') out.publisherUrl = rest[++i];
        else if (a.startsWith('--')) fail(`unknown flag: ${a}`);
        else if (!out.pluginDir) out.pluginDir = a;
        else fail(`unexpected argument: ${a}`);
    }
    if (!out.pluginDir) out.pluginDir = process.cwd();
    return out;
}

function main() {
    const args = parseArgs(process.argv);

    const privateKeyPem = process.env.GENIE_PLUGIN_SIGNING_KEY;
    if (!privateKeyPem || !privateKeyPem.includes('PRIVATE KEY')) {
        fail('GENIE_PLUGIN_SIGNING_KEY is not set to a PEM private key (env secret).');
        return;
    }

    // Derive the PUBLIC key + keyId from the private key — the signer never
    // self-declares an id; the id is a fingerprint of the actual key.
    let publicKeyPem;
    let keyId;
    try {
        publicKeyPem = crypto
            .createPublicKey(crypto.createPrivateKey(/** @type {string} */ (privateKeyPem)))
            .export({ type: 'spki', format: 'pem' })
            .toString();
        keyId = keyIdForPublicKey(publicKeyPem);
    } catch (e) {
        fail(`invalid GENIE_PLUGIN_SIGNING_KEY: ${(e instanceof Error ? e.message : String(e))}`);
        return;
    }

    if (args.expectKeyId && args.expectKeyId !== keyId) {
        fail(`signing key mismatch: derived ${keyId} but --expect-key-id was ${args.expectKeyId}. Refusing to sign with the wrong key.`);
        return;
    }

    const manifestPath = path.join(args.pluginDir, PLUGIN_MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
        fail(`no ${PLUGIN_MANIFEST_FILENAME} found at ${path.resolve(args.pluginDir)}`);
        return;
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        fail(`${PLUGIN_MANIFEST_FILENAME} is not valid JSON: ${(e instanceof Error ? e.message : String(e))}`);
        return;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        fail(`${PLUGIN_MANIFEST_FILENAME} must be a JSON object.`);
        return;
    }

    // Resolve the publisher block: keep any existing name/url, stamp the keyId.
    const existingPublisher = (manifest.publisher && typeof manifest.publisher === 'object') ? manifest.publisher : {};
    const publisherName = args.publisherName ?? existingPublisher.name;
    if (!publisherName || typeof publisherName !== 'string') {
        fail('publisher.name is required — set it in the manifest or pass --publisher-name.');
        return;
    }
    manifest.publisher = {
        ...existingPublisher,
        name: publisherName,
        ...(args.publisherUrl ? { url: args.publisherUrl } : {}),
        keyId,
    };

    // Compute code integrity over the SIGNED surface, then sign the canonical
    // manifest (which now carries integrity + publisher.keyId).
    const integrity = computeBundleIntegrity(collectBundleFiles(args.pluginDir));
    manifest.integrity = integrity;

    const signed = signManifest(manifest, /** @type {string} */ (privateKeyPem));

    fs.writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + '\n');

    console.log(`sign-plugin: signed ${manifest.id ?? '(no id)'} v${manifest.version ?? '?'}`);
    console.log(`  keyId     ${keyId}`);
    console.log(`  integrity ${integrity}`);
    console.log(`  manifest  ${manifestPath}`);
}

// Only run when invoked directly (not when imported).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}

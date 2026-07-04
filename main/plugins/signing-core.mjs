/**
 * Plugin SIGNING primitives — the DEP-FREE, SHARED core (Plugin System, Phase 3).
 *
 * This is the SINGLE SOURCE OF TRUTH for the sign/verify algorithm. It is a plain
 * ESM module (`.mjs`) using only Node's built-in `crypto` — NO Electron, NO fs, NO
 * TypeScript — so the EXACT SAME bytes back three very different consumers:
 *
 *   1. the desktop app  — `main/plugins/signing.ts` re-exports this module, so the
 *      app's `verifyDetached` / trust evaluation run this code (webpack bundles it
 *      into `background.js`);
 *   2. the CI signer    — `scripts/sign-plugin.mjs` (ESM) imports this module
 *      directly, with zero install, so a signature it produces VERIFIES under the
 *      app's verifier by construction (same function, not a copy);
 *   3. the unit tests   — the round-trip test drives this module.
 *
 * Because all three share this one file, there is no duplication to drift and no
 * "the signer and the verifier disagree on a byte" class of bug.
 *
 * **Why ESM (`.mjs`), not CommonJS.** nextron/webpack bundles the Electron MAIN
 * process into an ES-Module `background.js`; a bundled `module.exports = …` core
 * makes the ESM loader throw at boot ("ES Modules may not assign module.exports").
 * Authoring this shared core as native ESM (real `export` bindings, `.mjs` so it
 * loads as ESM regardless of the package `type`) keeps it valid in ALL of: the
 * webpack main bundle, plain-Node `import` (`sign-plugin.mjs`), and vitest.
 *
 * The scheme (see `signing.ts` for the full rationale):
 *   - identity is Ed25519 (publisher holds the private key; the public key +
 *     derived `keyId` fingerprint live in Genie's trust store);
 *   - `integrity` = `sha256-<hex>` over the plugin's CODE files (everything except
 *     the manifest + any detached `.sig`);
 *   - `signature` = detached base64 Ed25519 over the CANONICAL manifest with its
 *     own `signature` field stripped (and `integrity` retained, so the signature
 *     transitively binds the code bytes too).
 *
 * @typedef {{ keyId: string, publicKeyPem: string, privateKeyPem: string }} Ed25519KeyPair
 * @typedef {{ path: string, bytes: Uint8Array }} BundleFile
 */

import crypto from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, arrays order-preserved,
 * `undefined` members dropped (matching JSON). Two structurally-equal manifests
 * serialise byte-identically regardless of authoring key order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
    return JSON.stringify(sortDeep(value));
}

/** @param {unknown} value @returns {unknown} */
function sortDeep(value) {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
        const src = value;
        const out = {};
        for (const key of Object.keys(src).sort()) {
            if (src[key] === undefined) continue;
            out[key] = sortDeep(src[key]);
        }
        return out;
    }
    return value;
}

/** Lowercase-hex sha256 of a byte buffer. @param {Uint8Array} bytes @returns {string} */
function sha256Hex(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** base64url (no padding) of a byte buffer. @param {Buffer} bytes @returns {string} */
function base64url(bytes) {
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A stable, collision-resistant fingerprint of a public key — the DER (SPKI) of
 * the key, sha256'd, base64url'd. Two PEM encodings of the SAME key yield the
 * same keyId.
 * @param {string} publicKeyPem
 * @returns {string}
 */
export function keyIdForPublicKey(publicKeyPem) {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return `ed25519-${base64url(crypto.createHash('sha256').update(der).digest())}`;
}

/** Generate a fresh Ed25519 keypair (+ its keyId). For owner tooling + tests. @returns {Ed25519KeyPair} */
export function generateSigningKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    return { keyId: keyIdForPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

/**
 * Deterministic integrity hash over the plugin's CODE files. The caller supplies
 * the file set already filtered to the SIGNED surface (excludes the manifest,
 * `.git`, and any detached `.sig`) so signer + verifier agree. Files are sorted
 * by path; each contributes `path\0<sha256hex>\n`, and the concatenation is
 * hashed. Returns `sha256-<hex>`.
 * @param {BundleFile[]} files
 * @returns {string}
 */
export function computeBundleIntegrity(files) {
    const lines = files
        .map((f) => ({ path: f.path.replace(/\\/g, '/'), bytes: f.bytes }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((f) => `${f.path}\0${sha256Hex(f.bytes)}\n`)
        .join('');
    return `sha256-${sha256Hex(Buffer.from(lines, 'utf8'))}`;
}

/**
 * The exact bytes a signature covers: the canonical manifest with its own
 * `signature` field stripped. `integrity` is DELIBERATELY retained.
 * @param {Record<string, unknown>} manifest
 * @returns {string}
 */
export function signingPayload(manifest) {
    const { signature: _drop, ...rest } = manifest;
    return canonicalJson(rest);
}

/**
 * Sign a manifest: returns a NEW object with `signature` set to the base64
 * Ed25519 signature over {@link signingPayload}. The manifest should already
 * carry its final `integrity` + `publisher.keyId` before signing.
 * @param {Record<string, unknown>} manifest
 * @param {string} privateKeyPem
 * @returns {Record<string, unknown> & { signature: string }}
 */
export function signManifest(manifest, privateKeyPem) {
    const payload = signingPayload(manifest);
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem));
    return { ...manifest, signature: sig.toString('base64') };
}

/**
 * Verify a detached base64 Ed25519 signature over `payload` against a PEM public
 * key. Returns false (never throws) on any malformed input — fail-closed.
 * @param {string} payload
 * @param {string} signatureB64
 * @param {string} publicKeyPem
 * @returns {boolean}
 */
export function verifyDetached(payload, signatureB64, publicKeyPem) {
    try {
        if (!signatureB64) return false;
        return crypto.verify(
            null,
            Buffer.from(payload, 'utf8'),
            crypto.createPublicKey(publicKeyPem),
            Buffer.from(signatureB64, 'base64'),
        );
    } catch {
        return false;
    }
}

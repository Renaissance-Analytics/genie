/**
 * Plugin SIGNING primitives (Plugin System, Phase 3 — §5.5 / §12.3).
 *
 * PURE crypto (Node `crypto` only, no Electron, no fs) so the sign/verify rules
 * are unit-testable and identical on desktop + a headless host. The scheme:
 *
 *   - **Identity is Ed25519.** A publisher holds an Ed25519 keypair; the PUBLIC
 *     key (+ a derived `keyId` fingerprint) lives in Genie's trust store
 *     (`trust.ts`), the PRIVATE key never leaves the signing authority.
 *   - **`integrity`** is a deterministic hash of the plugin's CODE files (every
 *     bundle file EXCEPT the manifest — the manifest is covered by the signature
 *     instead, so there is no integrity↔signature cycle). Format: `sha256-<hex>`.
 *   - **`signature`** is a detached Ed25519 signature over the CANONICAL manifest
 *     with its own `signature` field removed. Because that canonical form INCLUDES
 *     `integrity`, a valid signature transitively binds the code bytes too:
 *       · tamper a code file  → recomputed `integrity` ≠ manifest.integrity → refuse
 *       · tamper the manifest → canonical bytes change → signature fails → refuse
 *       · no private key      → cannot produce a signature that verifies → refuse
 *
 * Verification (in `trust.ts`) therefore needs BOTH: recomputed integrity ==
 * declared integrity, AND the signature verifies against a TRUSTED public key.
 * This module supplies the crypto; the trust decision + key resolution is
 * `trust.ts`, and the enforcement points are install / enable / surface.
 */

import crypto from 'crypto';

/** An Ed25519 keypair (PEM) + its derived keyId. */
export interface Ed25519KeyPair {
    keyId: string;
    publicKeyPem: string;
    privateKeyPem: string;
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays order-preserved,
 * `undefined` members dropped (matching JSON). Two structurally-equal manifests
 * therefore serialise byte-identically regardless of authoring key order, so a
 * signature made over one verifies over the other.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
        const src = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(src).sort()) {
            if (src[key] === undefined) continue;
            out[key] = sortDeep(src[key]);
        }
        return out;
    }
    return value;
}

/** Lowercase-hex sha256 of a byte buffer. */
function sha256Hex(bytes: Uint8Array): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** base64url (no padding) of a byte buffer. */
function base64url(bytes: Buffer): string {
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A stable, collision-resistant fingerprint of a public key — the DER (SPKI) of
 * the key, sha256'd, base64url'd. Two PEM encodings of the SAME key yield the
 * same keyId (the DER is canonical), so a manifest's `publisher.keyId` can be
 * matched against a trust-store entry without PEM-string fiddliness.
 */
export function keyIdForPublicKey(publicKeyPem: string): string {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return `ed25519-${base64url(crypto.createHash('sha256').update(der).digest())}`;
}

/** Generate a fresh Ed25519 keypair (+ its keyId). For owner tooling + tests. */
export function generateSigningKeyPair(): Ed25519KeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    return { keyId: keyIdForPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

/** One bundle file for integrity hashing: its bundle-relative path + its bytes. */
export interface BundleFile {
    /** Forward-slashed, bundle-relative path (e.g. 'tools.cjs', 'lib/x.js'). */
    path: string;
    bytes: Uint8Array;
}

/**
 * Deterministic integrity hash over the plugin's CODE files. The caller supplies
 * the file set already filtered to the SIGNED surface (excludes the manifest,
 * `.git`, and any detached `.sig`) so signer + verifier agree. Files are sorted
 * by path; each contributes `path\0<sha256hex>\n`, and the concatenation is
 * hashed. Returns `sha256-<hex>` (SRI-flavoured), or `sha256-<hex of empty>` for
 * an empty set.
 */
export function computeBundleIntegrity(files: BundleFile[]): string {
    const lines = files
        .map((f) => ({ path: f.path.replace(/\\/g, '/'), bytes: f.bytes }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((f) => `${f.path}\0${sha256Hex(f.bytes)}\n`)
        .join('');
    return `sha256-${sha256Hex(Buffer.from(lines, 'utf8'))}`;
}

/**
 * The exact bytes a signature covers: the canonical manifest with its own
 * `signature` field stripped (so the signature never signs itself). `integrity`
 * is DELIBERATELY retained, so the signature binds the code hash too.
 */
export function signingPayload(manifest: Record<string, unknown>): string {
    const { signature: _drop, ...rest } = manifest as Record<string, unknown> & { signature?: unknown };
    return canonicalJson(rest);
}

/**
 * Sign a manifest object in place-of-copy: returns a NEW object with `signature`
 * set to the base64 Ed25519 signature over {@link signingPayload}. Owner tooling
 * (and tests) use this; production plugins arrive pre-signed. The manifest should
 * already carry the final `integrity` + `publisher.keyId` before signing.
 */
export function signManifest<T extends Record<string, unknown>>(
    manifest: T,
    privateKeyPem: string,
): T & { signature: string } {
    const payload = signingPayload(manifest);
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem));
    return { ...manifest, signature: sig.toString('base64') };
}

/**
 * Verify a detached base64 Ed25519 signature over `payload` against a PEM public
 * key. Returns false (never throws) on any malformed input — fail-closed.
 */
export function verifyDetached(payload: string, signatureB64: string, publicKeyPem: string): boolean {
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

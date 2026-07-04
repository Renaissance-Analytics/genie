/**
 * Type declarations for the dep-free CommonJS signing core (`signing-core.js`).
 *
 * The runtime lives in `signing-core.js` (plain Node `crypto`, no Electron) so
 * the desktop app, the CI signer (`scripts/sign-plugin.mjs`), and the unit tests
 * all execute the identical bytes. These declarations give the TypeScript side
 * (`signing.ts`, which re-exports this module) full types over that runtime.
 */

/** An Ed25519 keypair (PEM) + its derived keyId. */
export interface Ed25519KeyPair {
    keyId: string;
    publicKeyPem: string;
    privateKeyPem: string;
}

/** One bundle file for integrity hashing: its bundle-relative path + its bytes. */
export interface BundleFile {
    /** Forward-slashed, bundle-relative path (e.g. 'tools.cjs', 'lib/x.js'). */
    path: string;
    bytes: Uint8Array;
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays order-preserved,
 * `undefined` members dropped (matching JSON).
 */
export function canonicalJson(value: unknown): string;

/**
 * A stable, collision-resistant fingerprint of a public key — the DER (SPKI) of
 * the key, sha256'd, base64url'd (`ed25519-<base64url>`).
 */
export function keyIdForPublicKey(publicKeyPem: string): string;

/** Generate a fresh Ed25519 keypair (+ its keyId). For owner tooling + tests. */
export function generateSigningKeyPair(): Ed25519KeyPair;

/**
 * Deterministic integrity hash (`sha256-<hex>`) over the plugin's CODE files —
 * the file set already filtered to the SIGNED surface (excludes the manifest,
 * `.git`, and any detached `.sig`).
 */
export function computeBundleIntegrity(files: BundleFile[]): string;

/**
 * The exact bytes a signature covers: the canonical manifest with its own
 * `signature` field stripped (and `integrity` retained).
 */
export function signingPayload(manifest: Record<string, unknown>): string;

/**
 * Sign a manifest: returns a NEW object with `signature` set to the base64
 * Ed25519 signature over {@link signingPayload}.
 */
export function signManifest<T extends Record<string, unknown>>(
    manifest: T,
    privateKeyPem: string,
): T & { signature: string };

/**
 * Verify a detached base64 Ed25519 signature over `payload` against a PEM public
 * key. Returns false (never throws) on any malformed input — fail-closed.
 */
export function verifyDetached(payload: string, signatureB64: string, publicKeyPem: string): boolean;

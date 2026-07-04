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
 *
 * **Single source of truth.** The algorithm itself lives in the dep-free
 * CommonJS `./signing-core` (Node `crypto` only — no Electron, no TypeScript) so
 * the EXACT SAME bytes back the desktop app (this re-export), the CI signer
 * (`scripts/sign-plugin.mjs`, which imports `signing-core` directly), and the
 * unit tests. A signature the CI script produces therefore verifies here by
 * construction — there is no second copy of the crypto to drift out of sync.
 */

export {
    canonicalJson,
    keyIdForPublicKey,
    generateSigningKeyPair,
    computeBundleIntegrity,
    signingPayload,
    signManifest,
    verifyDetached,
} from './signing-core';

export type { Ed25519KeyPair, BundleFile } from './signing-core';

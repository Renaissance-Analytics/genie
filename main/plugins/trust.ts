/**
 * Plugin TRUST model (Plugin System, Phase 3 — §5.5 / §7.2 / §12.3).
 *
 * Turns a plugin's signature + integrity + publisher key into a TRUST VERDICT the
 * install / enable / surface paths enforce. Three outcomes, all fail-closed:
 *
 *   - **trusted**   — a valid Ed25519 signature from a key in the trust store,
 *                     over a manifest whose declared `integrity` matches the
 *                     recomputed code hash. Runs unrestricted (subject to its
 *                     granted capabilities).
 *   - **unsigned**  — no signature at all. REFUSED unless the user turns on
 *                     Developer Mode and knowingly consents; even then it runs in
 *                     a RESTRICTED mode (no network egress — {@link restrictGrants}).
 *   - **untrusted** — a signature is present but does NOT verify: wrong/unknown
 *                     key, tampered manifest, or tampered code (integrity
 *                     mismatch). ALWAYS refused, never restricted-run. A red flag.
 *
 * The trust ROOT is the trust store: BUNDLED keys ship with Genie (the signed
 * production registry's publisher key — owner-populated, see BUNDLED_TRUSTED_KEYS)
 * plus USER keys a developer explicitly adds. First-party BUNDLED plugins are
 * trusted by construction (they are materialised from Genie's own signed app
 * bundle — their trust root is the app signature itself).
 *
 * The pure core (`evaluateManifestTrust`, `pluginRowIsSurfaceable`) has NO
 * Electron / DB / fs dependency so it is unit-testable; key storage + the
 * Developer-Mode flag lazy-load their backing stores.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { getAllSettings } from '../db';
import { verifyDetached, signingPayload, keyIdForPublicKey } from './signing';
import type { PluginManifest, MarketplaceManifest } from './manifest';

/**
 * `outdated` is not produced by signature evaluation — it is set by the install /
 * revalidation layer when a STORED manifest no longer validates against a newer
 * schema (a "needs an update" state, distinct from a signature/tamper `untrusted`).
 * It is non-surfaceable like `untrusted` but reads differently to the user.
 */
export type TrustStatus = 'trusted' | 'unsigned' | 'untrusted' | 'outdated';

/** A resolved verdict for a plugin's provenance. */
export interface TrustVerdict {
    status: TrustStatus;
    /** A one-line, user-facing explanation (shown in Settings + consent copy). */
    reason: string;
    keyId?: string | null;
    publisher?: string | null;
    /** True when the signing key is an OFFICIAL (Genie/registry) key. */
    official?: boolean;
}

/** One trusted publisher key. */
export interface TrustedKey {
    keyId: string;
    publicKeyPem: string;
    label: string;
    /** An official (Genie/registry-authority) key vs a user-added developer key. */
    official: boolean;
}

/** Resolve a `keyId` to its trusted public key, or null when not trusted. */
export interface TrustStore {
    resolve(keyId: string): TrustedKey | null;
}

/**
 * BUNDLED trusted keys — the production trust ROOT that ships INSIDE Genie's
 * signed app bundle. This is now LIVE: the owner has generated the production
 * Ed25519 signing keypair, keeps the PRIVATE key OUT of the repo (a GitHub org
 * secret, `GENIE_PLUGIN_SIGNING_KEY`, consumed only by CI — see
 * `docs/plugin-signing.md` + `.github/actions/sign-genie-plugin/`), and the
 * PUBLIC half is embedded below as the OFFICIAL "Genie Official" key.
 *
 * `keyId` is DERIVED from the PEM by `keyIdForPublicKey` (the trust store never
 * trusts a self-declared id); the value below is that derived fingerprint and is
 * asserted against a recompute in `__tests__/trust.test.ts`. Any official plugin
 * whose `publisher.keyId` matches this and whose signature verifies over an
 * untampered bundle resolves to `trusted`; user-added developer keys still stack
 * on top (see `userTrustedKeys`).
 */
export const BUNDLED_TRUSTED_KEYS: TrustedKey[] = [
    {
        keyId: 'ed25519-bHc2Rt62EgjmpE5Fd7-QsJeNi36BsAwckJ4bEyx4BCE',
        publicKeyPem:
            '-----BEGIN PUBLIC KEY-----\n' +
            'MCowBQYDK2VwAyEAlk2aBKzc/0ABrUvlJLT8ELpnzwBgJjb4yzDcBXp2qgo=\n' +
            '-----END PUBLIC KEY-----\n',
        label: 'Genie Official',
        official: true,
    },
];

/** Where the user's developer-added trusted keys are stored. */
function userTrustedKeysFile(): string {
    return path.join(app.getPath('userData'), 'plugins', 'trusted-keys.json');
}

/** Read + validate the user's developer-added trusted keys (best-effort). */
export function userTrustedKeys(): TrustedKey[] {
    try {
        const file = userTrustedKeysFile();
        if (!fs.existsSync(file)) return [];
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        if (!Array.isArray(raw)) return [];
        const out: TrustedKey[] = [];
        for (const e of raw) {
            if (!e || typeof e !== 'object') continue;
            const r = e as Record<string, unknown>;
            if (typeof r.publicKeyPem !== 'string' || !r.publicKeyPem.includes('PUBLIC KEY')) continue;
            // Derive the keyId from the key itself — never trust a self-declared id.
            let keyId: string;
            try {
                keyId = keyIdForPublicKey(r.publicKeyPem);
            } catch {
                continue;
            }
            out.push({
                keyId,
                publicKeyPem: r.publicKeyPem,
                label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : 'Developer key',
                official: false, // user keys are never "official"
            });
        }
        return out;
    } catch {
        return [];
    }
}

/** Persist the user's developer-added trusted keys. */
function writeUserTrustedKeys(keys: TrustedKey[]): void {
    const file = userTrustedKeysFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify(
            keys.map((k) => ({ publicKeyPem: k.publicKeyPem, label: k.label })),
            null,
            2,
        ),
        { mode: 0o600 },
    );
}

/** Add a developer-trusted public key. Returns its derived keyId. Throws on a bad key. */
export function addUserTrustedKey(publicKeyPem: string, label?: string): string {
    const keyId = keyIdForPublicKey(publicKeyPem); // throws if not a valid public key
    const existing = userTrustedKeys().filter((k) => k.keyId !== keyId);
    writeUserTrustedKeys([...existing, { keyId, publicKeyPem, label: label?.trim() || 'Developer key', official: false }]);
    return keyId;
}

/** Remove a developer-trusted key by its keyId. */
export function removeUserTrustedKey(keyId: string): void {
    writeUserTrustedKeys(userTrustedKeys().filter((k) => k.keyId !== keyId));
}

/** Build the live trust store: bundled (official) keys ∪ user developer keys. */
export function productionTrustStore(): TrustStore {
    const all = new Map<string, TrustedKey>();
    for (const k of BUNDLED_TRUSTED_KEYS) all.set(k.keyId, k);
    for (const k of userTrustedKeys()) if (!all.has(k.keyId)) all.set(k.keyId, k);
    return { resolve: (keyId) => all.get(keyId) ?? null };
}

/** A store from an explicit key list (tests + revalidation callers). */
export function trustStoreFromKeys(keys: TrustedKey[]): TrustStore {
    const m = new Map(keys.map((k) => [k.keyId, k]));
    return { resolve: (keyId) => m.get(keyId) ?? null };
}

/** Whether the user has opted into Developer Mode (install unsigned plugins). */
export function isDeveloperMode(): boolean {
    try {
        return getAllSettings().plugins_developer_mode === 'on';
    } catch {
        return false;
    }
}

/**
 * Evaluate a manifest's trust against a store. PURE — pass the RECOMPUTED code
 * integrity (from the on-disk bundle) via `opts.recomputedIntegrity` for the full
 * check at install/enable; omit it for a signature-only re-check (revocation
 * sweeps, where the code hasn't changed). `firstParty` short-circuits to trusted
 * for Genie's own bundled plugins.
 */
export function evaluateManifestTrust(
    manifest: PluginManifest,
    store: TrustStore,
    opts: { recomputedIntegrity?: string | null; firstParty?: boolean } = {},
): TrustVerdict {
    if (opts.firstParty) {
        return { status: 'trusted', reason: 'First-party plugin bundled with Genie.', keyId: null, publisher: manifest.publisher?.name ?? 'Genie', official: true };
    }

    const signature = manifest.signature ?? null;
    const keyId = manifest.publisher?.keyId ?? null;
    const publisher = manifest.publisher?.name ?? null;

    if (!signature) {
        return { status: 'unsigned', reason: 'Not signed by any publisher.', keyId: null, publisher };
    }
    if (!keyId) {
        return { status: 'untrusted', reason: 'Signed but the manifest declares no publisher.keyId.', keyId: null, publisher };
    }
    const key = store.resolve(keyId);
    if (!key) {
        return { status: 'untrusted', reason: `Signed by an untrusted key (${keyId}). Add it under Developer Mode to trust it.`, keyId, publisher };
    }
    // Code integrity (when the bundle is available): a mismatch means the code was
    // altered after signing — treat as tampered.
    if (opts.recomputedIntegrity !== undefined) {
        if (!manifest.integrity) {
            return { status: 'untrusted', reason: 'Signed but the manifest declares no integrity hash.', keyId, publisher };
        }
        if (manifest.integrity !== opts.recomputedIntegrity) {
            return { status: 'untrusted', reason: 'Bundle integrity mismatch — the plugin code was modified after signing.', keyId, publisher };
        }
    }
    if (!verifyDetached(signingPayload(manifest as unknown as Record<string, unknown>), signature, key.publicKeyPem)) {
        return { status: 'untrusted', reason: 'Signature verification failed — the manifest was modified or the signature is invalid.', keyId, publisher };
    }
    return { status: 'trusted', reason: `Signed by ${key.label}.`, keyId, publisher, official: key.official };
}

/**
 * Evaluate a MARKETPLACE index's signature (Phase 3). Same detached-signature
 * scheme as a plugin manifest (no bundle, so no integrity step). An UNSIGNED
 * index is `unsigned` (allowed as a 3rd-party catalog, but never OFFICIAL); a
 * present-but-bad signature is `untrusted`.
 */
export function evaluateMarketplaceTrust(manifest: MarketplaceManifest, store: TrustStore): TrustVerdict {
    const signature = manifest.signature ?? null;
    const keyId = manifest.publisher?.keyId ?? null;
    const publisher = manifest.publisher?.name ?? null;
    if (!signature) return { status: 'unsigned', reason: 'Marketplace index is not signed.', keyId: null, publisher };
    if (!keyId) return { status: 'untrusted', reason: 'Signed index declares no publisher.keyId.', keyId: null, publisher };
    const key = store.resolve(keyId);
    if (!key) return { status: 'untrusted', reason: `Index signed by an untrusted key (${keyId}).`, keyId, publisher };
    if (!verifyDetached(signingPayload(manifest as unknown as Record<string, unknown>), signature, key.publicKeyPem)) {
        return { status: 'untrusted', reason: 'Marketplace index signature verification failed.', keyId, publisher };
    }
    return { status: 'trusted', reason: `Index signed by ${key.label}.`, keyId, publisher, official: key.official };
}

/** The trust shape the surface gate reads off a plugin row (pure, no crypto). */
export interface SurfaceableRow {
    enabled: boolean;
    trust: TrustStatus;
    /** The user knowingly enabled an UNSIGNED plugin under Developer Mode. */
    dev_approved: boolean;
}

/**
 * The FAIL-CLOSED runtime gate: which plugins may contribute tools / editors.
 * This is the authoritative enforcement — even a row force-flipped to
 * `enabled=1` contributes NOTHING unless it is trusted, or an unsigned plugin the
 * user explicitly dev-approved. Untrusted (tampered/wrong-key) NEVER surfaces.
 */
export function pluginRowIsSurfaceable(row: SurfaceableRow): boolean {
    if (!row.enabled) return false;
    if (row.trust === 'trusted') return true;
    if (row.trust === 'unsigned' && row.dev_approved) return true;
    return false;
}

/**
 * Unsigned plugins run RESTRICTED: strip any network grants (they may never make
 * network requests, even if a grant lingers). fs-in-workspace stays — that is the
 * generators' whole purpose. Returns a defensively-copied grants object.
 */
export function restrictGrantsForTrust<G extends { fs: Record<string, boolean>; network: Record<string, boolean>; genieApi: Record<string, boolean> }>(
    status: TrustStatus,
    grants: G,
): G {
    if (status === 'trusted') return grants;
    return { ...grants, network: {} } as G;
}

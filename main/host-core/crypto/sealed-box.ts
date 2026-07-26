import { createHash } from 'node:crypto';
import _sodium from 'libsodium-wrappers';

/**
 * The ONE sealed-box primitive for Genie's managed-credential path (design brief
 * `.ai/_discovery/tynn-managed-agent-auth-w2-crypto.md`).
 *
 * Everything on the credential path — the owner's browser, Tynn's ciphertext
 * store, this Host — speaks libsodium **`crypto_box_seal`** (X25519 +
 * XSalsa20-Poly1305, anonymous sender). A sealed box is
 * `ephemeral_pk(32) || box`, so it needs no sender key and leaks no sender
 * identity: only the holder of the recipient PRIVATE key can open it.
 *
 * Wire encoding is fixed here so both sides agree byte-for-byte:
 * - keys are **32 raw bytes**, standard padded base64 (NOT SPKI/PEM — that shape
 *   belongs to the separate Ed25519 *signing* identity in
 *   `main/tynn/workstation-identity.ts`);
 * - ciphertext is standard padded base64 of the raw sealed box.
 *
 * Why libsodium and not `node:crypto`: Node exposes X25519 but neither
 * XSalsa20-Poly1305 nor BLAKE2b-with-24-byte-output, so a `node:crypto` build
 * would mean hand-rolling the AEAD — unacceptable for the credential path. The
 * WASM build also keeps the desktop packaging free of a native rebuild.
 *
 * NOTHING in this module logs, throws with, or otherwise surfaces a plaintext
 * value: a failed open returns `null` rather than an error carrying context.
 */

/** `crypto_box_SEALBYTES` — 32-byte ephemeral public key + 16-byte Poly1305 tag. */
export const SEAL_OVERHEAD_BYTES = 48;

/** Raw X25519 key length; both halves of the pair. */
const KEY_BYTES = 32;

export interface EncryptionKeypair {
    /** Raw 32-byte X25519 public key, base64. Published to Tynn — not a secret. */
    publicKeyB64: string;
    /** Raw 32-byte X25519 private key, base64. NEVER transmitted, NEVER logged. */
    privateKeyB64: string;
}

type Sodium = typeof _sodium;

let readied: Promise<Sodium> | null = null;

/** Await libsodium's WASM init once, process-wide. Every export below awaits it,
 *  so callers only need this when they want to front-load the cost. */
export function sodiumReady(): Promise<Sodium> {
    readied ??= _sodium.ready.then(() => _sodium);
    return readied;
}

function decodeKey(b64: string, label: string): Uint8Array {
    const raw = Buffer.from(b64 ?? '', 'base64');
    if (raw.length !== KEY_BYTES) {
        throw new Error(`Invalid X25519 ${label} key: expected ${KEY_BYTES} raw bytes.`);
    }
    return new Uint8Array(raw);
}

/** Generate a fresh X25519 encryption keypair (the Host's, or an escrow key). */
export async function generateEncryptionKeypair(): Promise<EncryptionKeypair> {
    const sodium = await sodiumReady();
    const kp = sodium.crypto_box_keypair();
    return {
        publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
        privateKeyB64: Buffer.from(kp.privateKey).toString('base64'),
    };
}

/**
 * Seal `plaintext` to `recipientPublicKeyB64`. Anonymous sender: a fresh
 * ephemeral keypair per call, so sealing the same value twice yields different
 * ciphertext. Throws only for a malformed recipient key — never with the value.
 */
export async function seal(
    plaintext: string | Uint8Array,
    recipientPublicKeyB64: string,
): Promise<string> {
    const sodium = await sodiumReady();
    const pk = decodeKey(recipientPublicKeyB64, 'public');
    const message =
        typeof plaintext === 'string' ? new Uint8Array(Buffer.from(plaintext, 'utf8')) : plaintext;
    return Buffer.from(sodium.crypto_box_seal(message, pk)).toString('base64');
}

/**
 * Open a sealed box with `keypair`. Returns null — never throws, never logs —
 * when the box was sealed to a DIFFERENT key, was tampered with, or isn't a
 * sealed box at all. The caller decides what a failed open means.
 */
export async function sealOpen(
    ciphertextB64: string,
    keypair: EncryptionKeypair,
): Promise<Uint8Array | null> {
    if (!ciphertextB64) return null;
    const sodium = await sodiumReady();
    try {
        const raw = new Uint8Array(Buffer.from(ciphertextB64, 'base64'));
        if (raw.length <= SEAL_OVERHEAD_BYTES) return null;
        return sodium.crypto_box_seal_open(
            raw,
            decodeKey(keypair.publicKeyB64, 'public'),
            decodeKey(keypair.privateKeyB64, 'private'),
        );
    } catch {
        return null;
    }
}

/** {@link sealOpen} decoded as UTF-8, or null on any failure. */
export async function sealOpenText(
    ciphertextB64: string,
    keypair: EncryptionKeypair,
): Promise<string | null> {
    const opened = await sealOpen(ciphertextB64, keypair);
    return opened ? Buffer.from(opened).toString('utf8') : null;
}

/**
 * A cheap shape check: does this base64 blob even have room for a sealed box?
 * Used to REFUSE handling anything that looks like it might be plaintext (a
 * credential short enough to fit inside the 48-byte overhead can't be a box).
 * It is a guard, not a validation — only {@link sealOpen} proves a real box.
 */
export function isPlausibleSealedBox(value: string): boolean {
    if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
    return Buffer.from(value, 'base64').length > SEAL_OVERHEAD_BYTES;
}

/**
 * The X25519 public key for `privateKeyB64` (`crypto_scalarmult_base`), or null
 * when the input isn't a 32-byte key. Lets a caller PROVE a received private key
 * really belongs to an advertised public key — the escrow bundle's integrity
 * check, so a store that hands over a mismatched pair is rejected rather than
 * silently producing garbage plaintext.
 */
export async function derivePublicKey(privateKeyB64: string): Promise<string | null> {
    const sodium = await sodiumReady();
    try {
        const derived = sodium.crypto_scalarmult_base(decodeKey(privateKeyB64, 'private'));
        return Buffer.from(derived).toString('base64');
    } catch {
        return null;
    }
}

/** SHA-256 (hex) of the RAW public key bytes — the at-a-glance integrity value
 *  published alongside the key, mirroring `fingerprintSpki` for the signing key. */
export function fingerprintPublicKey(publicKeyB64: string): string {
    return createHash('sha256').update(decodeKey(publicKeyB64, 'public')).digest('hex');
}

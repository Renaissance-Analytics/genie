import { getAllSettings, setSettings, type Settings } from '../../db';
import { decryptSecret, encryptSecret, secretEncryptionAvailable } from '../../secrets/store';
import {
    fingerprintPublicKey,
    generateEncryptionKeypair,
    type EncryptionKeypair,
} from './sealed-box';

/**
 * THIS host's X25519 **encryption** identity for the managed-credential path.
 *
 * Deliberately SEPARATE from the Ed25519 *signing* identity in
 * `main/tynn/workstation-identity.ts`: that one proves "I am workstation X" on
 * every authed call; this one is what the owner's browser and the escrow key are
 * sealed TO. Different algorithm, different job, different lifetime — a signing
 * key rotation must not silently invalidate every stored ciphertext, and vice
 * versa.
 *
 * Storage follows the SAME rule as the signing key: the private half rides the
 * shared `secrets/store` `Encryptor` port and is **never written in the clear**.
 * That port is exactly the desktop-vs-cloud split the brief asks for — the
 * desktop shell injects the Electron `safeStorage` (OS keystore) impl and
 * genie-cloud injects its KMS/keyring-backed `HeadlessEncryptor`, whose state
 * lives on the persistent `genie_home` volume. So "OS keystore on desktop,
 * genie_home volume on cloud" is satisfied without a second storage mechanism
 * and without a plaintext-on-disk path to protect with file modes.
 *
 * The PUBLIC half is stored in the clear (it isn't secret) so the host can
 * re-publish it and answer "what should be sealed to me?" without decrypting.
 */

/** Settings keys — namespaced `enc` to keep them distinct from the signing key. */
export const ENC_PUBLIC_KEY_SETTING = 'workstation_enc_public_key';
export const ENC_KEY_ENC_SETTING = 'workstation_enc_key_enc';

/** The persisted fields, read from settings. Injectable for tests. */
export type EncryptionKeyReader = () => { publicKeyB64?: string; privateKeyEnc?: string };
export type EncryptionKeyWriter = (patch: Record<string, string>) => void;

function defaultRead(): { publicKeyB64?: string; privateKeyEnc?: string } {
    const s = getAllSettings() as unknown as Record<string, string>;
    return {
        publicKeyB64: s[ENC_PUBLIC_KEY_SETTING] || undefined,
        privateKeyEnc: s[ENC_KEY_ENC_SETTING] || undefined,
    };
}

function defaultWrite(patch: Record<string, string>): void {
    void setSettings(patch as Partial<Settings>);
}

/**
 * Read this host's encryption keypair, or null when none is stored or the blob
 * can't be decrypted (no encryptor, or written under a different keychain key
 * after an OS user reset). Null means "generate a fresh one" — the old
 * ciphertexts are unreadable either way, and the escrow re-wrap recovers them.
 */
export function readHostEncryptionKeypair(
    read: EncryptionKeyReader = defaultRead,
): EncryptionKeypair | null {
    const { publicKeyB64, privateKeyEnc } = read();
    if (!publicKeyB64 || !privateKeyEnc) return null;
    const privateKeyB64 = decryptSecret(privateKeyEnc);
    if (!privateKeyB64) return null;
    return { publicKeyB64, privateKeyB64 };
}

/**
 * Persist a keypair: public in the clear, private encrypted at rest. FAIL CLOSED
 * — throws rather than writing the private key unencrypted, mirroring
 * `storeWorkstationIdentity` and the GitHub token store.
 */
export function storeHostEncryptionKeypair(
    keypair: EncryptionKeypair,
    write: EncryptionKeyWriter = defaultWrite,
): void {
    const enc = secretEncryptionAvailable() ? encryptSecret(keypair.privateKeyB64) : null;
    if (enc == null) {
        throw new Error(
            'OS encryption is unavailable; refusing to store the host encryption key unencrypted. ' +
                'On Linux, install gnome-keyring / libsecret.',
        );
    }
    write({ [ENC_PUBLIC_KEY_SETTING]: keypair.publicKeyB64, [ENC_KEY_ENC_SETTING]: enc });
}

/** Drop the stored keypair so the next ensure generates + publishes a fresh one. */
export function clearHostEncryptionKeypair(write: EncryptionKeyWriter = defaultWrite): void {
    write({ [ENC_PUBLIC_KEY_SETTING]: '', [ENC_KEY_ENC_SETTING]: '' });
}

/** The single Tynn call this module makes — injected so the module stays free of
 *  the electron-bound backend and tests pass a fake. */
export interface EncryptionKeyPublisher {
    publishEncryptionKey(input: { publicKeyB64: string; fingerprint: string }): Promise<void>;
}

export interface EnsureHostEncryptionKeyDeps {
    read?: EncryptionKeyReader;
    write?: EncryptionKeyWriter;
    generate?: () => Promise<EncryptionKeypair>;
}

export interface EnsureHostEncryptionKeyResult {
    status: 'created' | 'exists';
    publicKeyB64: string;
    /** False when Tynn couldn't be reached — the key is still stored and the next
     *  ensure re-publishes the SAME key. */
    published: boolean;
}

/**
 * Idempotently ensure this host has an encryption keypair and that Tynn knows its
 * public half.
 *
 * Ordering matters and is the opposite of the enroll flow's: **store first, then
 * publish.** Publishing is an idempotent upsert, so a failed publish just means
 * the next boot re-publishes the same key. Publishing FIRST would risk the
 * reverse — a public key advertised to browsers whose private half was never
 * persisted, i.e. credentials sealed to a key nobody can ever open.
 *
 * Publish failure is reported, not thrown: a host that can't reach Tynn should
 * still boot. Failing to STORE does throw — that's the fail-closed guarantee.
 */
export async function ensureHostEncryptionKey(
    publisher: EncryptionKeyPublisher,
    deps: EnsureHostEncryptionKeyDeps = {},
): Promise<EnsureHostEncryptionKeyResult> {
    const read = deps.read ?? defaultRead;
    const write = deps.write ?? defaultWrite;
    const generate = deps.generate ?? generateEncryptionKeypair;

    const existing = readHostEncryptionKeypair(read);
    let status: 'created' | 'exists' = 'exists';
    let keypair = existing;
    if (!keypair) {
        // Check before generating so an unavailable encryptor fails without ever
        // materialising a private key we'd then have to drop.
        if (!secretEncryptionAvailable()) {
            throw new Error(
                'OS encryption is unavailable; refusing to store the host encryption key unencrypted. ' +
                    'On Linux, install gnome-keyring / libsecret.',
            );
        }
        keypair = await generate();
        storeHostEncryptionKeypair(keypair, write);
        status = 'created';
    }

    let published = true;
    try {
        await publisher.publishEncryptionKey({
            publicKeyB64: keypair.publicKeyB64,
            fingerprint: fingerprintPublicKey(keypair.publicKeyB64),
        });
    } catch {
        published = false;
    }

    return { status, publicKeyB64: keypair.publicKeyB64, published };
}

import type { Encryptor } from '@particle-academy/fancy-term-host';

/**
 * The single secrets-at-rest seam for Genie's scattered token stores (mobile
 * sessions, remote host tokens, GitHub tokens, MCP endpoint tokens). Each store
 * routed here encrypts through the INJECTED `Encryptor` port instead of touching
 * Electron `safeStorage` directly — so the desktop shell injects the
 * safeStorage-backed impl (behaviour unchanged) and the headless genie-cloud
 * build injects its KMS/keyring-backed `HeadlessEncryptor`.
 *
 * FAIL CLOSED: when no encryptor is set or it isn't available, `encryptSecret`
 * returns null and callers MUST keep the secret in memory only — NEVER persist
 * it as plaintext. This removes the old silent plaintext fallbacks.
 */

let active: Encryptor | null = null;

/** Install the active encryptor (the composition root does this once at boot
 *  from `ports.encryptor`). Pass null to clear (tests). */
export function setSecretEncryptor(enc: Encryptor | null): void {
    active = enc;
}

/** Whether secrets can be encrypted at rest right now (an encryptor is set AND
 *  reports itself available). */
export function secretEncryptionAvailable(): boolean {
    try {
        return !!active && active.isAvailable();
    } catch {
        return false;
    }
}

/**
 * WHY a crypt operation didn't happen.
 *
 * `'unavailable'` — there is no key to work with RIGHT NOW (no encryptor set, or
 *   the OS keychain reports itself unavailable). Transient: a blob already on
 *   disk is untouched and probably still good, so the caller must NOT treat this
 *   as "there was nothing there" and overwrite it.
 * `'failed'` — the encryptor is present and working, and still could not do it:
 *   the blob was written under a different key, or is corrupt. Durable.
 *
 * Collapsing these two into one null is what made genie#578 both undiagnosable
 * and destructive — the mobile auth store read "cannot decrypt" as "first run"
 * and wrote a fresh store over every paired device.
 */
export type CryptFailure = 'unavailable' | 'failed';

/** A crypt operation's outcome: the value, or WHY there isn't one. */
export type CryptResult =
    | { ok: true; value: string }
    | { ok: false; reason: CryptFailure };

/**
 * Encrypt a string to a base64 ciphertext blob, reporting WHY on failure.
 * FAIL CLOSED — a caller that gets `ok: false` must not write plaintext to disk.
 */
export function encryptSecretResult(plain: string): CryptResult {
    if (!secretEncryptionAvailable()) return { ok: false, reason: 'unavailable' };
    try {
        return { ok: true, value: active!.encrypt(Buffer.from(plain, 'utf8')).toString('base64') };
    } catch {
        return { ok: false, reason: 'failed' };
    }
}

/** Decrypt a base64 ciphertext blob, reporting WHY on failure. An empty blob is
 *  a `'failed'` — there is nothing there to read, and saying `'unavailable'`
 *  would tell the caller to preserve a file that holds nothing. */
export function decryptSecretResult(blob: string): CryptResult {
    if (!secretEncryptionAvailable()) return { ok: false, reason: 'unavailable' };
    if (!blob) return { ok: false, reason: 'failed' };
    try {
        return { ok: true, value: active!.decrypt(Buffer.from(blob, 'base64')).toString('utf8') };
    } catch {
        return { ok: false, reason: 'failed' };
    }
}

/**
 * Encrypt a string to a base64 ciphertext blob, or null when encryption is
 * unavailable (FAIL CLOSED — the caller must not write plaintext to disk).
 * The null-returning shape, for callers that act the same either way.
 */
export function encryptSecret(plain: string): string | null {
    const r = encryptSecretResult(plain);
    return r.ok ? r.value : null;
}

/** Decrypt a base64 ciphertext blob back to its string, or null when it can't be
 *  decrypted (no encryptor, or written under a different key). Callers that must
 *  distinguish those two — anything that would OVERWRITE the blob — want
 *  {@link decryptSecretResult} instead. */
export function decryptSecret(blob: string): string | null {
    const r = decryptSecretResult(blob);
    return r.ok ? r.value : null;
}

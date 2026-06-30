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
 * Encrypt a string to a base64 ciphertext blob, or null when encryption is
 * unavailable (FAIL CLOSED — the caller must not write plaintext to disk).
 */
export function encryptSecret(plain: string): string | null {
    if (!secretEncryptionAvailable()) return null;
    try {
        return active!.encrypt(Buffer.from(plain, 'utf8')).toString('base64');
    } catch {
        return null;
    }
}

/** Decrypt a base64 ciphertext blob back to its string, or null when it can't be
 *  decrypted (no encryptor, or written under a different key). */
export function decryptSecret(blob: string): string | null {
    if (!blob || !secretEncryptionAvailable()) return null;
    try {
        return active!.decrypt(Buffer.from(blob, 'base64')).toString('utf8');
    } catch {
        return null;
    }
}

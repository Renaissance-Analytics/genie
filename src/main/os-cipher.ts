/**
 * THE ONE GATE FOR EVERY SECRET GENIE KEEPS (the owner, 2026-11-01: with no keyring Genie REFUSES to store secrets and
 * explains — never a weaker plain-text fallback). The Tynn pairing key, the agents' Tynn keys, the GitHub token and the
 * workstation key all encrypt through this.
 *
 * On Linux, Chromium's `basic_text` store "encrypts" with a key compiled into every Chromium build: plaintext with extra
 * steps. `safeStorage.isEncryptionAvailable()` alone does not rule it out, so the selected backend is checked too, and
 * `encrypt` itself refuses, so a caller that forgot to ask cannot write a secret in the clear.
 *
 * The host split's P3.4 replaces Electron's safeStorage with the OS keychain (`@napi-rs/keyring`); this port's shape —
 * isAvailable / encrypt / decrypt, refusing without a keyring — is what the accounts depend on, not safeStorage.
 */

/** Electron's `safeStorage`, as much of it as the gate needs. */
export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend?(): string;
    encryptString(text: string): Buffer;
    decryptString(bytes: Buffer): string;
}

export interface OsCipher {
    isAvailable(): boolean;
    encrypt(text: string): Buffer;
    decrypt(bytes: Buffer): string;
}

/** The refusal, in words a person acts on (the keyring card says how to fix it). */
export const NO_KEYRING = 'Genie needs a keyring to keep your sign-ins safe, and none is available, so nothing was saved.';

/** Electron's names for Linux backends that really encrypt. */
const REAL_LINUX_BACKENDS: ReadonlySet<string> = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/** PURE (given the port): may a secret be kept right now? */
export function canKeepSecrets(ss: SafeStorageLike, platform: NodeJS.Platform): boolean {
    if (!ss.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    return REAL_LINUX_BACKENDS.has(ss.getSelectedStorageBackend?.() ?? 'unknown');
}

export function osCipher(ss: SafeStorageLike, platform: NodeJS.Platform): OsCipher {
    return {
        isAvailable: () => canKeepSecrets(ss, platform),
        encrypt: (text) => {
            if (!canKeepSecrets(ss, platform)) throw new Error(NO_KEYRING);
            return ss.encryptString(text);
        },
        decrypt: (bytes) => ss.decryptString(bytes),
    };
}

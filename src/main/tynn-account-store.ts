import { readFile, rm, writeFile } from 'node:fs/promises';
import type { SecretStore } from './tynn-account.js';

/**
 * WHERE THE TYNN KEY IS KEPT: one file, encrypted by the OS through Electron's safeStorage (DPAPI on Windows, the
 * keychain on macOS, the secret service on Linux). Where the OS cannot encrypt, `write` refuses — the key is never written
 * in the clear (TynnAccount turns the refusal into a sign-in that says why).
 */
export interface Encryptor {
    isAvailable(): boolean;
    encrypt(text: string): Buffer;
    decrypt(bytes: Buffer): string;
}

export function encryptedFileStore(file: string, crypto: Encryptor): SecretStore {
    return {
        read: async () => {
            let bytes: Buffer;
            try {
                bytes = await readFile(file);
            } catch {
                return null;
            }
            return crypto.decrypt(bytes);
        },
        write: async (value) => {
            if (!crypto.isAvailable()) throw new Error('the operating system offers no encryption for secrets here');
            await writeFile(file, crypto.encrypt(value), { mode: 0o600 });
        },
        clear: async () => {
            await rm(file, { force: true });
        },
    };
}

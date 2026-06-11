import { safeStorage } from 'electron';
import { getAllSettings, setSettings } from '../db';
import { GENIE_GITHUB_CLIENT_ID } from '../config';

/**
 * GitHub access token storage. The raw token never lands in plain text
 * on disk — Electron's safeStorage encrypts it via the OS keychain
 * (Keychain on macOS, DPAPI on Windows, libsecret on Linux), and we
 * persist only the base64'd ciphertext in our settings table.
 *
 * When the OS doesn't expose encryption (rare; some headless Linux
 * VMs), we refuse to write — better a failed connect than a
 * cleartext token in the SQLite file.
 *
 * The username is stored separately, in clear, so the UI can label the
 * connection ("Connected as glenn") without decrypting on every render.
 */

const TOKEN_KEY = 'github_token_enc';
const USER_KEY = 'github_user';

export function isStorageAvailable(): boolean {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

export function saveToken(token: string, username: string): void {
    if (!isStorageAvailable()) {
        throw new Error(
            'OS encryption is unavailable; refusing to store a GitHub token unencrypted. ' +
                'On Linux, install gnome-keyring / libsecret.',
        );
    }
    const enc = safeStorage.encryptString(token).toString('base64');
    setSettings({ [TOKEN_KEY]: enc, [USER_KEY]: username } as Record<string, string>);
}

export function getToken(): string | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    const enc = settings[TOKEN_KEY];
    if (!enc || !isStorageAvailable()) return null;
    try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
        // Token was written with a different key — possible after a
        // user reset. Treat as disconnected.
        return null;
    }
}

export function getUsername(): string | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    return settings[USER_KEY] ?? null;
}

export function clearToken(): void {
    setSettings({ [TOKEN_KEY]: '', [USER_KEY]: '' } as Record<string, string>);
}

export function getClientId(): string {
    // Settings override wins so devs can point Genie at their own OAuth
    // App without rebuilding. Falls back to the build-time constant
    // (set in main/config.ts) for normal packaged installs.
    const settings = getAllSettings() as unknown as Record<string, string>;
    const override = settings.github_client_id?.trim();
    return override || GENIE_GITHUB_CLIENT_ID;
}

export function getBuiltInClientId(): string {
    return GENIE_GITHUB_CLIENT_ID;
}

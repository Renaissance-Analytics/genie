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
const REFRESH_KEY = 'github_refresh_enc';
const ACCESS_EXP_KEY = 'github_token_exp_ms';
const REFRESH_EXP_KEY = 'github_refresh_exp_ms';
const USER_KEY = 'github_user';
const REAUTH_KEY = 'github_needs_reauth';

export function isStorageAvailable(): boolean {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

/**
 * The pieces of a user-to-server token grant we persist. When the App has
 * "User-to-server token expiration" OPTED OUT, GitHub returns only
 * `accessToken` (non-expiring) and the refresh/expiry fields are absent — the
 * stored token then lives until the user disconnects/revokes. When expiration
 * is ON, GitHub also returns a `refreshToken` (valid ~6 months) plus the
 * lifetimes, and the API client silently refreshes the 8h access token rather
 * than forcing the user to reconnect.
 */
export interface TokenSet {
    accessToken: string;
    refreshToken?: string | null;
    /** Access-token lifetime in seconds (GitHub's `expires_in`). */
    expiresInSec?: number | null;
    /** Refresh-token lifetime in seconds (`refresh_token_expires_in`). */
    refreshTokenExpiresInSec?: number | null;
}

function encrypt(value: string): string {
    return safeStorage.encryptString(value).toString('base64');
}

function decrypt(enc: string | undefined): string | null {
    if (!enc || !isStorageAvailable()) return null;
    try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
        // Written with a different key — possible after an OS user reset.
        return null;
    }
}

/** Persist a full token grant, computing absolute expiry instants from the
 *  relative lifetimes GitHub returns. Clears any prior "reauth needed" flag —
 *  a fresh grant means the session is healthy again. */
export function saveTokenSet(set: TokenSet, username: string): void {
    if (!isStorageAvailable()) {
        throw new Error(
            'OS encryption is unavailable; refusing to store a GitHub token unencrypted. ' +
                'On Linux, install gnome-keyring / libsecret.',
        );
    }
    const now = Date.now();
    setSettings({
        [TOKEN_KEY]: encrypt(set.accessToken),
        [REFRESH_KEY]: set.refreshToken ? encrypt(set.refreshToken) : '',
        [ACCESS_EXP_KEY]: set.expiresInSec ? String(now + set.expiresInSec * 1000) : '',
        [REFRESH_EXP_KEY]: set.refreshTokenExpiresInSec
            ? String(now + set.refreshTokenExpiresInSec * 1000)
            : '',
        [USER_KEY]: username,
        [REAUTH_KEY]: '',
    } as Record<string, string>);
}

/** Back-compat helper for a bare (non-expiring) token + username. */
export function saveToken(token: string, username: string): void {
    saveTokenSet({ accessToken: token }, username);
}

export function getToken(): string | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    return decrypt(settings[TOKEN_KEY]);
}

export function getRefreshToken(): string | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    return decrypt(settings[REFRESH_KEY]);
}

/** Absolute epoch-ms when the access token expires, or null if non-expiring. */
export function getAccessExpiryMs(): number | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    const v = settings[ACCESS_EXP_KEY];
    return v ? Number(v) : null;
}

/** Absolute epoch-ms when the refresh token expires, or null if none. */
export function getRefreshExpiryMs(): number | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    const v = settings[REFRESH_EXP_KEY];
    return v ? Number(v) : null;
}

export function getUsername(): string | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    return settings[USER_KEY] ?? null;
}

/** Flag the stored session as dead (refresh exhausted / token revoked) so the
 *  UI can prompt a one-time reconnect instead of failing silently. */
export function markReauthNeeded(): void {
    setSettings({ [REAUTH_KEY]: '1' } as Record<string, string>);
}

export function needsReauth(): boolean {
    const settings = getAllSettings() as unknown as Record<string, string>;
    return settings[REAUTH_KEY] === '1';
}

/** Clear the reauth flag. Call after a SUCCESSFUL authenticated request: a 2xx
 *  proves the stored session is alive, so a stale flag — left by a transient or
 *  preemptive refresh failure, or a one-off 401 on some other endpoint — must
 *  self-heal instead of pinning the "GitHub session expired" banner while reads
 *  actually work. No-op (no write) when the flag isn't set. */
export function clearReauthNeeded(): void {
    if (needsReauth()) setSettings({ [REAUTH_KEY]: '' } as Record<string, string>);
}

export function clearToken(): void {
    setSettings({
        [TOKEN_KEY]: '',
        [REFRESH_KEY]: '',
        [ACCESS_EXP_KEY]: '',
        [REFRESH_EXP_KEY]: '',
        [USER_KEY]: '',
        [REAUTH_KEY]: '',
    } as Record<string, string>);
}

export function getClientId(): string {
    // Settings override wins so devs can point Genie at their own OAuth
    // App without rebuilding. Falls back to the build-time constant
    // (set in main/config.ts) for normal packaged installs.
    return getClientIdOverride() || GENIE_GITHUB_CLIENT_ID;
}

/** The raw override (empty when none). Exposed so the UI can surface a
 *  stale override — a common Device Flow failure: early alphas (before
 *  the ID was baked in) prompted users to paste their own client ID, and
 *  a wrong/stale value here silently wins over the bundled one. */
export function getClientIdOverride(): string {
    const settings = getAllSettings() as unknown as Record<string, string>;
    return settings.github_client_id?.trim() ?? '';
}

export function clearClientIdOverride(): void {
    setSettings({ github_client_id: '' } as unknown as Record<string, string>);
}

export function getBuiltInClientId(): string {
    return GENIE_GITHUB_CLIENT_ID;
}

import { getAllSettings, setSettings } from '../db';
import { GENIE_GITHUB_CLIENT_ID, GENIE_GITHUB_CLIENT_SECRET } from '../config';
import {
    encryptSecret,
    decryptSecret,
    secretEncryptionAvailable,
} from '../secrets/store';

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
const REAUTH_REASON_KEY = 'github_reauth_reason';
const REAUTH_DETAIL_KEY = 'github_reauth_detail';
const REAUTH_AT_KEY = 'github_reauth_at_ms';

export type GitHubReauthReasonCode =
    | 'missing_refresh_token'
    | 'refresh_token_undecryptable'
    | 'refresh_token_expired'
    | 'refresh_token_rejected'
    | 'refresh_client_secret_missing'
    | 'access_token_rejected';

export interface GitHubReauthFailure {
    code: GitHubReauthReasonCode;
    occurredAt: number;
    /** Redacted provider error code only; never a token or raw response. */
    detailCode?: string;
}

export function isStorageAvailable(): boolean {
    return secretEncryptionAvailable();
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
    const blob = encryptSecret(value);
    if (blob == null) {
        // Caller (saveTokenSet) already guards on isStorageAvailable(); this is
        // the fail-closed backstop so a token is NEVER written in clear.
        throw new Error('OS encryption is unavailable; refusing to store a token unencrypted.');
    }
    return blob;
}

function decrypt(enc: string | undefined): string | null {
    // decryptSecret returns null when unavailable or written under a different
    // key (e.g. after an OS user reset).
    return enc ? decryptSecret(enc) : null;
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
        [REAUTH_REASON_KEY]: '',
        [REAUTH_DETAIL_KEY]: '',
        [REAUTH_AT_KEY]: '',
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
    return getRefreshTokenState().token;
}

/** Distinguish an absent refresh credential from ciphertext the current OS
 *  keyring cannot decrypt. Both return no token, but require different recovery
 *  guidance and must remain distinguishable after an update/restart. */
export function getRefreshTokenState(): {
    token: string | null;
    state: 'available' | 'missing' | 'undecryptable';
} {
    const settings = getAllSettings() as unknown as Record<string, string>;
    const encrypted = settings[REFRESH_KEY];
    if (!encrypted) return { token: null, state: 'missing' };
    const token = decrypt(encrypted);
    return token
        ? { token, state: 'available' }
        : { token: null, state: 'undecryptable' };
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
export function markReauthNeeded(
    failure: Omit<GitHubReauthFailure, 'occurredAt'> & { occurredAt?: number },
): void {
    const detailCode = failure.detailCode?.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) ?? '';
    setSettings({
        [REAUTH_KEY]: '1',
        [REAUTH_REASON_KEY]: failure.code,
        [REAUTH_DETAIL_KEY]: detailCode,
        [REAUTH_AT_KEY]: String(failure.occurredAt ?? Date.now()),
    } as Record<string, string>);
}

export function needsReauth(): boolean {
    const settings = getAllSettings() as unknown as Record<string, string>;
    return settings[REAUTH_KEY] === '1';
}

export function getReauthFailure(): GitHubReauthFailure | null {
    const settings = getAllSettings() as unknown as Record<string, string>;
    if (settings[REAUTH_KEY] !== '1') return null;
    const code = settings[REAUTH_REASON_KEY] as GitHubReauthReasonCode | undefined;
    const valid: GitHubReauthReasonCode[] = [
        'missing_refresh_token',
        'refresh_token_undecryptable',
        'refresh_token_expired',
        'refresh_token_rejected',
        'refresh_client_secret_missing',
        'access_token_rejected',
    ];
    if (!code || !valid.includes(code)) return null;
    const occurredAt = Number(settings[REAUTH_AT_KEY]);
    return {
        code,
        occurredAt: Number.isFinite(occurredAt) ? occurredAt : 0,
        ...(settings[REAUTH_DETAIL_KEY] ? { detailCode: settings[REAUTH_DETAIL_KEY] } : {}),
    };
}

export function reauthFailureMessage(failure: GitHubReauthFailure | null): string | null {
    if (!failure) return null;
    switch (failure.code) {
        case 'missing_refresh_token':
            return 'The saved authorization has no refresh credential. Reconnect GitHub to create a new grant.';
        case 'refresh_token_undecryptable':
            return 'Genie cannot decrypt the saved refresh credential with the current OS keychain. Reconnect GitHub to replace it.';
        case 'refresh_token_expired':
            return 'The saved GitHub refresh credential expired. Reconnect GitHub to renew authorization.';
        case 'refresh_token_rejected':
            return 'GitHub rejected the saved refresh credential. Reconnect GitHub to authorize a new one.';
        case 'refresh_client_secret_missing':
            // NOT "reconnect" (genie#263). Reconnecting WORKS — and then fails
            // again at the next refresh, because the device grant needs no
            // client secret and the refresh grant does. Sending someone round
            // that loop three times is what this issue was filed about.
            //
            // It also does not send them to a Settings field: there is none, and
            // inventing a destination is the same dead end wearing better copy.
            // Nothing on this machine can fix it, so the message says so — the
            // fix is in the Genie build or the GitHub App's own settings.
            return 'GitHub refused to renew the authorization: this Genie has no GitHub App client secret to send, and the refresh step requires one. Reconnecting will sign you back in, but it will expire again in a few hours. This needs fixing in Genie itself, not on your machine — please report it.';
        case 'access_token_rejected':
            return 'GitHub rejected the refreshed access token. Reconnect GitHub; the saved grant may have been revoked.';
    }
}

/** Clear the reauth flag. Call after a SUCCESSFUL authenticated request: a 2xx
 *  proves the stored session is alive, so a stale flag — left by a transient or
 *  preemptive refresh failure, or a one-off 401 on some other endpoint — must
 *  self-heal instead of pinning the "GitHub session expired" banner while reads
 *  actually work. No-op (no write) when the flag isn't set. */
export function clearReauthNeeded(): void {
    if (needsReauth()) {
        setSettings({
            [REAUTH_KEY]: '',
            [REAUTH_REASON_KEY]: '',
            [REAUTH_DETAIL_KEY]: '',
            [REAUTH_AT_KEY]: '',
        } as Record<string, string>);
    }
}

export function clearToken(): void {
    setSettings({
        [TOKEN_KEY]: '',
        [REFRESH_KEY]: '',
        [ACCESS_EXP_KEY]: '',
        [REFRESH_EXP_KEY]: '',
        [USER_KEY]: '',
        [REAUTH_KEY]: '',
        [REAUTH_REASON_KEY]: '',
        [REAUTH_DETAIL_KEY]: '',
        [REAUTH_AT_KEY]: '',
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

/**
 * The App's client secret, or `''` when none is configured (genie#263).
 *
 * Build-time only, on purpose — there is deliberately no settings override here,
 * unlike {@link getClientIdOverride} beside it. The Client ID is public and
 * lives in the settings table in clear; a secret must not. This file's whole
 * premise is that a credential never lands on disk in plain text (see the header
 * — tokens go through `safeStorage`), and adding a plaintext `github_client_secret`
 * row to satisfy one error message would undo that for the sake of a
 * convenience. A per-machine override therefore belongs in the ENCRYPTED store
 * alongside the tokens, with UI to match, and that is a change worth making
 * deliberately rather than as a side effect of this fix.
 *
 * Empty is a normal, supported state, not a misconfiguration: it is what every
 * install has today, and it is CORRECT for an App with user-token expiration
 * turned off, where nothing ever refreshes. See {@link GENIE_GITHUB_CLIENT_SECRET}
 * for the two ways to close the gap.
 */
export function getClientSecret(): string {
    return GENIE_GITHUB_CLIENT_SECRET;
}

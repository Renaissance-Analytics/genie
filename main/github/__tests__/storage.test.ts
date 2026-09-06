import { afterEach, describe, expect, it, vi } from 'vitest';

const settings: Record<string, string> = {};

vi.mock('../../db', () => ({
    getAllSettings: () => ({ ...settings }),
    setSettings: (patch: Record<string, string>) => Object.assign(settings, patch),
}));

vi.mock('../../secrets/store', () => ({
    secretEncryptionAvailable: () => true,
    encryptSecret: (plain: string) => Buffer.from(plain).toString('base64'),
    decryptSecret: (blob: string) =>
        blob === 'undecryptable' ? null : Buffer.from(blob, 'base64').toString('utf8'),
}));

import {
    clearReauthNeeded,
    getReauthFailure,
    getRefreshTokenState,
    markReauthNeeded,
    reauthFailureMessage,
} from '../storage';

afterEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
});

describe('GitHub refresh failure persistence', () => {
    it('survives a restart-shaped reread with only redacted code + timestamp', () => {
        markReauthNeeded({
            code: 'refresh_token_rejected',
            detailCode: 'bad refresh/token:<secret>',
            occurredAt: 1_786_000_000_000,
        });

        expect(getReauthFailure()).toEqual({
            code: 'refresh_token_rejected',
            detailCode: 'badrefreshtokensecret',
            occurredAt: 1_786_000_000_000,
        });
        expect(reauthFailureMessage(getReauthFailure())).toContain('Reconnect GitHub');

        clearReauthNeeded();
        expect(getReauthFailure()).toBeNull();
    });

    it('survives a restart as a code the reader can still resolve (genie#263)', () => {
        // A reason code that round-trips but is not in `getReauthFailure`'s
        // allow-list reads back as null, and the banner then says nothing at
        // all — a silent failure in the code path whose entire job is to explain
        // one. Adding a member to the union does not by itself add it there.
        markReauthNeeded({
            code: 'refresh_client_secret_missing',
            detailCode: 'incorrect_client_credentials',
            occurredAt: 1_788_246_208_462,
        });

        expect(getReauthFailure()).toMatchObject({ code: 'refresh_client_secret_missing' });

        const message = reauthFailureMessage(getReauthFailure()) ?? '';
        // It must NOT be the reconnect advice: reconnecting signs the user in
        // and the next refresh fails identically, which is the loop this issue
        // was filed about after three attempts.
        expect(message).not.toContain('Reconnect GitHub');
        expect(message).toContain('client secret');
    });

    it('distinguishes missing refresh storage from ciphertext the keychain cannot decrypt', () => {
        expect(getRefreshTokenState()).toEqual({ token: null, state: 'missing' });

        settings.github_refresh_enc = 'undecryptable';
        expect(getRefreshTokenState()).toEqual({ token: null, state: 'undecryptable' });
    });
});

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

    it('distinguishes missing refresh storage from ciphertext the keychain cannot decrypt', () => {
        expect(getRefreshTokenState()).toEqual({ token: null, state: 'missing' });

        settings.github_refresh_enc = 'undecryptable';
        expect(getRefreshTokenState()).toEqual({ token: null, state: 'undecryptable' });
    });
});

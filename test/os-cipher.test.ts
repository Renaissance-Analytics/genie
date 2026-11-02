import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_KEYRING, osCipher, type SafeStorageLike } from '../src/main/os-cipher.js';

/**
 * NO KEYRING, NO SECRETS (the owner, 2026-11-01): when no keyring is available Genie REFUSES to keep a secret and says
 * why — never a weaker store. On Linux Chromium's `basic_text` store "encrypts" with a key compiled into every Chromium,
 * so it is plaintext with extra steps: it is refused even when Electron would happily encrypt with it.
 */

function fake(backend: string, available: boolean): SafeStorageLike & { encrypted: string[] } {
    const encrypted: string[] = [];
    return {
        encrypted,
        isEncryptionAvailable: () => available,
        getSelectedStorageBackend: () => backend,
        encryptString: (s: string) => { encrypted.push(s); return Buffer.from(`enc:${s}`); },
        decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
    };
}

describe('osCipher — refuse to store a secret without a keyring', () => {
    it('Linux on a real keyring: available, and it round-trips (CONTROL)', () => {
        const c = osCipher(fake('gnome_libsecret', true), 'linux');
        expect(c.isAvailable()).toBe(true);
        expect(c.decrypt(c.encrypt('gpk_secret'))).toBe('gpk_secret');
    });

    it('Linux on basic_text: NOT available even when Electron says it can encrypt, and encrypt REFUSES', () => {
        const ss = fake('basic_text', true);
        const c = osCipher(ss, 'linux');
        expect(c.isAvailable()).toBe(false);
        expect(() => c.encrypt('gpk_secret')).toThrow(NO_KEYRING);
        // Nothing reached the plaintext store.
        expect(ss.encrypted).toEqual([]);
    });

    it('Linux with no backend reported yet, or a backend that gave no key: refused', () => {
        expect(osCipher(fake('unknown', true), 'linux').isAvailable()).toBe(false);
        expect(osCipher(fake('gnome_libsecret', false), 'linux').isAvailable()).toBe(false);
        expect(() => osCipher(fake('gnome_libsecret', false), 'linux').encrypt('x')).toThrow(NO_KEYRING);
    });

    it('Windows and macOS: the OS keystore decides (no Linux backend question)', () => {
        expect(osCipher(fake('unknown', true), 'win32').isAvailable()).toBe(true);
        expect(osCipher(fake('unknown', false), 'darwin').isAvailable()).toBe(false);
    });

    it('the refusal names the cause in words a person acts on', () => {
        expect(NO_KEYRING).toMatch(/keyring/i);
        expect(NO_KEYRING).not.toMatch(/basic_text|OSCrypt|safeStorage/);
    });
});

/**
 * EVERY SECRET GENIE KEEPS goes through the same gate: the Tynn pairing key, the agents' Tynn keys, the GitHub token and
 * this machine's workstation key. Before this, GitHub and the workstation key asked only `isEncryptionAvailable()`, which
 * does not know about basic_text. 
 */
describe('main.ts: every credential cipher is the gated osCipher', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    it('no credential cipher is built from safeStorage directly', () => {
        const direct = [...main.matchAll(/isAvailable: \(\) => safeStorage\.isEncryptionAvailable\(\)[^\n]*/g)].map((m) => m[0]);
        // None: the terminal engine's snapshot cipher was the last one, and it went with saved scrollback (the owner, 2026-11-02).
        expect(direct).toHaveLength(0);
        // Positive control: what the gauge looks for, as text, can match (a cipher built that way would be found).
        expect('isAvailable: () => safeStorage.isEncryptionAvailable(),'.match(/isAvailable: \(\) => safeStorage\.isEncryptionAvailable\(\)/)).not.toBeNull();
        expect(main).toMatch(/osCipher\(safeStorage, process\.platform\)/);
    });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    readRememberedPasswordStore,
    rememberPasswordStore,
} from '../src/main/password-store-memo.js';

/**
 * genie#588 — the probe is a SUBPROCESS, and a subprocess is a thing that can
 * fail for reasons that have nothing to do with the keyring. When it finds
 * nothing there is no second opinion, so Genie falls back to Chromium's
 * plaintext `basic` store and reports the machine's keychain as unavailable.
 *
 * The second opinion is the backend Electron itself said was in use on a launch
 * where it WORKED. That has to outlive the process, so it lives in a file.
 */

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-588-memo-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('password store memo', () => {
    it('remembers a working backend across processes', () => {
        expect(readRememberedPasswordStore(dir)).toBeNull();
        rememberPasswordStore(dir, 'gnome_libsecret');
        // A different process, same user data dir: the switch value, not
        // Electron's snake_case report of it.
        expect(readRememberedPasswordStore(dir)).toBe('gnome-libsecret');
    });

    it('refuses to remember the states that mean "nothing was selected"', () => {
        for (const selected of ['basic_text', 'unknown', '', null, undefined] as const) {
            rememberPasswordStore(dir, selected);
            expect(readRememberedPasswordStore(dir)).toBeNull();
        }
        // Positive control: the same call with a real backend DOES write, so the
        // nulls above are the guard working and not a broken writer.
        rememberPasswordStore(dir, 'kwallet6');
        expect(readRememberedPasswordStore(dir)).toBe('kwallet6');
    });

    it('does NOT erase a good memo when a later launch selects nothing', () => {
        // This is the whole point: the launch that can't select a backend is
        // exactly the launch whose report must not be believed.
        rememberPasswordStore(dir, 'gnome_libsecret');
        rememberPasswordStore(dir, 'basic_text');
        expect(readRememberedPasswordStore(dir)).toBe('gnome-libsecret');
    });

    it('ignores a memo that is corrupt, empty, or names a store Chromium rejects', () => {
        const file = path.join(dir, 'linux-password-store.json');
        for (const body of ['', '{', '{}', '{"store":"nonsense"}', '{"store":123}']) {
            fs.writeFileSync(file, body, 'utf8');
            expect(readRememberedPasswordStore(dir)).toBeNull();
        }
        // Positive control: a well-formed memo in the same file IS read back.
        fs.writeFileSync(file, JSON.stringify({ store: 'kwallet5' }), 'utf8');
        expect(readRememberedPasswordStore(dir)).toBe('kwallet5');
    });

    it('never throws when the directory is unwritable or missing', () => {
        const gone = path.join(dir, 'no', 'such', 'dir');
        expect(() => rememberPasswordStore(gone, 'gnome_libsecret')).not.toThrow();
        expect(readRememberedPasswordStore(gone)).toBeNull();
    });
});

/**
 * A SELECTED STORE IS NOT A WORKING STORE (genie keyring fix, 2026-11-01). `getSelectedStorageBackend()` reports what
 * Chromium CHOSE, not whether it produced a key: a KWallet nobody runs (Tynn #846) or a locked collection report
 * `kwallet6` / `gnome_libsecret` and encrypt nothing. Written down, that choice was re-asserted on every later launch where
 * the bus probe found nothing — a broken store made permanent. Only a launch that could ENCRYPT may write the memo, and a
 * launch on the remembered store that could not encrypt clears it.
 */
describe('password store memo — only a store that gave a key', () => {
    it('a selected store that could not encrypt is NOT remembered', () => {
        rememberPasswordStore(dir, 'kwallet6', false);
        expect(readRememberedPasswordStore(dir)).toBeNull();
        // Positive control: the same store, encrypting, is.
        rememberPasswordStore(dir, 'kwallet6', true);
        expect(readRememberedPasswordStore(dir)).toBe('kwallet6');
    });

    it('the remembered store failing to encrypt clears it; a different failing store leaves a good memo alone', () => {
        rememberPasswordStore(dir, 'gnome_libsecret', true);
        rememberPasswordStore(dir, 'kwallet6', false);
        expect(readRememberedPasswordStore(dir)).toBe('gnome-libsecret');
        rememberPasswordStore(dir, 'gnome_libsecret', false);
        expect(readRememberedPasswordStore(dir)).toBeNull();
    });

    it('main.ts passes whether this launch could encrypt', () => {
        const main = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        expect(main).toMatch(/rememberPasswordStore\(genieRoot\(\), safeStorage\.getSelectedStorageBackend\(\), safeStorage\.isEncryptionAvailable\(\)\)/);
    });
});

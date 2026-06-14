import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSnapshotStore, type SnapshotStore } from '../sessions';
import type { Encryptor } from '../ports';

/**
 * Session-snapshot persistence (Tier 1). Exercises the gzip + (optional)
 * encryptor round-trip, the plaintext fallback when encryption is unavailable,
 * the tail-trim cap, and the corrupt/missing → null tolerance.
 *
 * The inversion: instead of mocking electron's app.getPath + safeStorage, we
 * build the store with TEST-DOUBLE PORTS — a per-test temp baseDir and a fake
 * Encryptor. The default encryptor reports unavailable (exercises the plaintext
 * fallback); the encrypted cases swap in an identity-cipher Encryptor (a
 * Buffer→Buffer passthrough), enough to prove the encrypt/decrypt branch is
 * wired correctly without a real keychain. This proves the SnapshotStoreConfig
 * inversion: the core no longer imports electron.
 */

let tmpDir: string;

/** Identity-cipher Encryptor: encrypt/decrypt are passthroughs. */
const identityEncryptor: Encryptor = {
    isAvailable: () => true,
    encrypt: (b) => b,
    decrypt: (b) => b,
};

/** Encryptor that reports the OS can't encrypt → plaintext-magic fallback. */
const unavailableEncryptor: Encryptor = {
    isAvailable: () => false,
    encrypt: (b) => b,
    decrypt: (b) => b,
};

function storeWith(encryptor: Encryptor): SnapshotStore {
    return createSnapshotStore({ baseDir: tmpDir, encryptor });
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-sessions-'));
});

afterEach(() => {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});

describe('sessions snapshot round-trip', () => {
    it('writes then reads back the same serialized text (plaintext fallback)', () => {
        const store = storeWith(unavailableEncryptor);
        const text = 'hello \x1b[31mworld\x1b[0m\r\n$ ';
        const bytes = store.writeSnapshot('term-a', text);
        expect(bytes).toBeGreaterThan(0);

        const read = store.readSnapshot('term-a');
        expect(read).not.toBeNull();
        expect(read!.serialized).toBe(text);
        expect(typeof read!.savedAt).toBe('number');
    });

    it('round-trips through the encrypted path', () => {
        // Encryption "available" + an identity cipher: encrypt returns the
        // bytes, decrypt returns them back. Proves the encrypt/decrypt branch is
        // reached and reversible.
        const store = storeWith(identityEncryptor);
        const text = 'encrypted buffer — OK';
        store.writeSnapshot('term-enc', text);
        const read = store.readSnapshot('term-enc');
        expect(read?.serialized).toBe(text);
    });

    it('marks the encrypted file with the encrypted magic byte (0x01)', () => {
        const store = storeWith(identityEncryptor);
        store.writeSnapshot('term-magic', 'x');
        const file = path.join(tmpDir, 'sessions', 'term-magic.snap');
        const raw = fs.readFileSync(file);
        expect(raw[0]).toBe(0x01);
    });

    it('plaintext fallback writes the plaintext magic byte (0x00)', () => {
        const store = storeWith(unavailableEncryptor);
        store.writeSnapshot('term-plain', 'x');
        const file = path.join(tmpDir, 'sessions', 'term-plain.snap');
        const raw = fs.readFileSync(file);
        expect(raw[0]).toBe(0x00);
    });

    it('trims oversized input to the tail (~256KB cap)', () => {
        const store = storeWith(unavailableEncryptor);
        // 400KB of input — head is "AAAA…", tail is a unique marker we expect
        // to survive the tail-keeping trim.
        const head = 'A'.repeat(400 * 1024);
        const tail = 'TAIL-MARKER-END';
        store.writeSnapshot('term-big', head + tail);
        const read = store.readSnapshot('term-big');
        expect(read).not.toBeNull();
        // Tail kept, head dropped.
        expect(read!.serialized.endsWith(tail)).toBe(true);
        expect(read!.serialized.length).toBeLessThan((head + tail).length);
        expect(Buffer.byteLength(read!.serialized, 'utf8')).toBeLessThanOrEqual(
            256 * 1024,
        );
    });

    it('returns null for a missing snapshot', () => {
        const store = storeWith(unavailableEncryptor);
        expect(store.readSnapshot('does-not-exist')).toBeNull();
    });

    it('returns null (never throws) for a corrupt snapshot file', () => {
        const store = storeWith(unavailableEncryptor);
        store.writeSnapshot('term-corrupt', 'good data');
        const file = path.join(tmpDir, 'sessions', 'term-corrupt.snap');
        // Clobber the gzip body with garbage, keep a valid-looking magic byte.
        fs.writeFileSync(file, Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0xfc]));
        expect(() => store.readSnapshot('term-corrupt')).not.toThrow();
        expect(store.readSnapshot('term-corrupt')).toBeNull();
    });

    it('returns null for an unknown magic byte', () => {
        const store = storeWith(unavailableEncryptor);
        const dir = path.join(tmpDir, 'sessions');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'term-weird.snap'), Buffer.from([0x09, 1, 2, 3]));
        expect(store.readSnapshot('term-weird')).toBeNull();
    });

    it('deleteSnapshot removes the file and is a no-op when absent', () => {
        const store = storeWith(unavailableEncryptor);
        store.writeSnapshot('term-del', 'bye');
        expect(store.readSnapshot('term-del')).not.toBeNull();
        store.deleteSnapshot('term-del');
        expect(store.readSnapshot('term-del')).toBeNull();
        // Second delete must not throw.
        expect(() => store.deleteSnapshot('term-del')).not.toThrow();
    });

    it('writeSnapshot returns null for empty input', () => {
        const store = storeWith(unavailableEncryptor);
        expect(store.writeSnapshot('term-empty', '')).toBeNull();
    });
});

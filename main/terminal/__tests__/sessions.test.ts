import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { writeSnapshot, readSnapshot, deleteSnapshot } from '../sessions';

/**
 * Session-snapshot persistence (Tier 1). Exercises the gzip + (optional)
 * safeStorage round-trip, the plaintext fallback when encryption is
 * unavailable, the tail-trim cap, and the corrupt/missing → null tolerance.
 *
 * The electron stub (test/electron-mock.ts) gives us a mutable `app.getPath`
 * (pointed at a per-test temp dir) and a `safeStorage` whose
 * `isEncryptionAvailable` defaults to false. We flip those per case. The fake
 * cipher is an identity round-trip (base64↔buffer), enough to prove the
 * encrypt/decrypt branch is wired correctly without a real keychain.
 */

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-sessions-'));
    vi.spyOn(app, 'getPath').mockReturnValue(tmpDir);
    // Reset to the default (no encryption) before each test; cases opt in.
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
});

afterEach(() => {
    vi.restoreAllMocks();
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});

describe('sessions snapshot round-trip', () => {
    it('writes then reads back the same serialized text (plaintext fallback)', () => {
        const text = 'hello \x1b[31mworld\x1b[0m\r\n$ ';
        const bytes = writeSnapshot('term-a', text);
        expect(bytes).toBeGreaterThan(0);

        const read = readSnapshot('term-a');
        expect(read).not.toBeNull();
        expect(read!.serialized).toBe(text);
        expect(typeof read!.savedAt).toBe('number');
    });

    it('round-trips through the safeStorage-encrypted path', () => {
        // Encryption "available" + an identity cipher: encryptString returns the
        // utf8 bytes, decryptString returns the string back. Proves the
        // encrypt/decrypt branch is reached and reversible.
        vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true);
        vi.spyOn(safeStorage, 'encryptString').mockImplementation((s: string) =>
            Buffer.from(s, 'utf8'),
        );
        vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) =>
            b.toString('utf8'),
        );

        const text = 'encrypted buffer — OK';
        writeSnapshot('term-enc', text);
        const read = readSnapshot('term-enc');
        expect(read?.serialized).toBe(text);
    });

    it('marks the encrypted file with the encrypted magic byte (0x01)', () => {
        vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true);
        vi.spyOn(safeStorage, 'encryptString').mockImplementation((s: string) =>
            Buffer.from(s, 'utf8'),
        );
        writeSnapshot('term-magic', 'x');
        const file = path.join(tmpDir, 'sessions', 'term-magic.snap');
        const raw = fs.readFileSync(file);
        expect(raw[0]).toBe(0x01);
    });

    it('plaintext fallback writes the plaintext magic byte (0x00)', () => {
        writeSnapshot('term-plain', 'x');
        const file = path.join(tmpDir, 'sessions', 'term-plain.snap');
        const raw = fs.readFileSync(file);
        expect(raw[0]).toBe(0x00);
    });

    it('trims oversized input to the tail (~256KB cap)', () => {
        // 400KB of input — head is "AAAA…", tail is a unique marker we expect
        // to survive the tail-keeping trim.
        const head = 'A'.repeat(400 * 1024);
        const tail = 'TAIL-MARKER-END';
        writeSnapshot('term-big', head + tail);
        const read = readSnapshot('term-big');
        expect(read).not.toBeNull();
        // Tail kept, head dropped.
        expect(read!.serialized.endsWith(tail)).toBe(true);
        expect(read!.serialized.length).toBeLessThan((head + tail).length);
        expect(Buffer.byteLength(read!.serialized, 'utf8')).toBeLessThanOrEqual(
            256 * 1024,
        );
    });

    it('returns null for a missing snapshot', () => {
        expect(readSnapshot('does-not-exist')).toBeNull();
    });

    it('returns null (never throws) for a corrupt snapshot file', () => {
        writeSnapshot('term-corrupt', 'good data');
        const file = path.join(tmpDir, 'sessions', 'term-corrupt.snap');
        // Clobber the gzip body with garbage, keep a valid-looking magic byte.
        fs.writeFileSync(file, Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0xfc]));
        expect(() => readSnapshot('term-corrupt')).not.toThrow();
        expect(readSnapshot('term-corrupt')).toBeNull();
    });

    it('returns null for an unknown magic byte', () => {
        const dir = path.join(tmpDir, 'sessions');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'term-weird.snap'), Buffer.from([0x09, 1, 2, 3]));
        expect(readSnapshot('term-weird')).toBeNull();
    });

    it('deleteSnapshot removes the file and is a no-op when absent', () => {
        writeSnapshot('term-del', 'bye');
        expect(readSnapshot('term-del')).not.toBeNull();
        deleteSnapshot('term-del');
        expect(readSnapshot('term-del')).toBeNull();
        // Second delete must not throw.
        expect(() => deleteSnapshot('term-del')).not.toThrow();
    });

    it('writeSnapshot returns null for empty input', () => {
        expect(writeSnapshot('term-empty', '')).toBeNull();
    });
});

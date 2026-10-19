import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptedFileStore, type Encryptor } from '../src/main/tynn-account-store.js';

/**
 * THE TYNN KEY ON DISK: only what the OS encryptor produced is written — never the key in the clear — and where the OS
 * cannot encrypt, nothing is written at all. The encryptor is a port (Electron's safeStorage in the app); faked here
 * with a reversible transform so "the plaintext is not in the file" is a real check.
 */

const KEY = '{"token":"aak_01JABCDEFGHJKMNPQRSTVWXYZ0.secret-example"}';
const fake = (available = true): Encryptor => ({
    isAvailable: () => available,
    encrypt: (t) => Buffer.from(`enc:${Buffer.from(t).toString('base64')}`),
    decrypt: (b) => Buffer.from(b.toString().replace(/^enc:/, ''), 'base64').toString(),
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-tynn-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('encryptedFileStore', () => {
    it('writes the encrypted bytes only, reads them back, and clear removes the file', async () => {
        const file = join(dir, 'tynn-account.bin');
        const store = encryptedFileStore(file, fake());
        expect(await store.read()).toBeNull();
        await store.write(KEY);
        const onDisk = (await readFile(file)).toString();
        expect(onDisk.startsWith('enc:')).toBe(true);
        expect(onDisk).not.toContain('aak_');
        expect(await store.read()).toBe(KEY);
        await store.clear();
        await expect(stat(file)).rejects.toThrow();
        expect(await store.read()).toBeNull();
    });

    it('no OS encryption: write refuses and NOTHING is written — never the key in the clear', async () => {
        const file = join(dir, 'tynn-account.bin');
        await expect(encryptedFileStore(file, fake(false)).write(KEY)).rejects.toThrow(/no encryption/);
        await expect(stat(file)).rejects.toThrow();
    });
});

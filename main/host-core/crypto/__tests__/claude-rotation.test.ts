import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLAUDE_SUBSCRIPTION } from '../escrow';
import { generateEncryptionKeypair, sealOpenText, sodiumReady } from '../sealed-box';
import { claudeCredentialsPath, type MaterializerFs } from '../credential-materializer';
import {
    noteClaudeCredentialBlob,
    resetClaudeRotation,
    syncClaudeCredentialRotation,
    watchClaudeCredentialRotation,
    type RotationClient,
} from '../claude-rotation';

/**
 * SYNTHETIC KEYS + FAKE BLOBS ONLY. The "rotated credential" strings below are
 * literals this test invented; no real OAuth blob exists here. The escrow keypair
 * is generated in-process, and the test opens the write-back ciphertext with it
 * purely to prove the host sealed the right thing to the right key.
 */

const FAKE_ORIGINAL = '{"fake":true,"refresh":"fake-refresh-original"}';
const FAKE_ROTATED = '{"fake":true,"refresh":"fake-refresh-rotated"}';

const HOME = '/fake-home';
const FILE = claudeCredentialsPath(HOME);

beforeAll(async () => {
    await sodiumReady();
});

afterEach(() => resetClaudeRotation());

function fakeFs(contents: Record<string, string>): MaterializerFs & {
    readFileSync(file: string): string;
} {
    return {
        mkdirSync: vi.fn(),
        writeFileSync: (file, data) => void (contents[file] = data),
        chmodSync: vi.fn(),
        existsSync: (file) => file in contents,
        rmSync: (file) => void delete contents[file],
        readFileSync: (file) => {
            if (!(file in contents)) throw new Error('ENOENT');
            return contents[file];
        },
    };
}

function fakeClient(): RotationClient & { puts: Array<{ provider: string; ciphertext: string }> } {
    const puts: Array<{ provider: string; ciphertext: string }> = [];
    return {
        puts,
        putCredential: vi.fn(async (provider: string, ciphertext: string) => {
            puts.push({ provider, ciphertext });
        }),
    };
}

describe('syncClaudeCredentialRotation', () => {
    it('re-seals a CLI-rotated credential to the ESCROW key and PUTs the ciphertext', async () => {
        const escrow = await generateEncryptionKeypair();
        const contents = { [FILE]: FAKE_ROTATED };
        const client = fakeClient();
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        const result = await syncClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs: fakeFs(contents),
            escrowPublicKey: escrow.publicKeyB64,
        });

        expect(result.status).toBe('written');
        expect(client.puts).toHaveLength(1);
        expect(client.puts[0].provider).toBe(CLAUDE_SUBSCRIPTION);
        // Sealed to the ESCROW key — so a host provisioned LATER can open it too.
        expect(await sealOpenText(client.puts[0].ciphertext, escrow)).toBe(FAKE_ROTATED);
        // The plaintext never rides the result.
        expect(JSON.stringify(result)).not.toContain('fake-refresh-rotated');
    });

    it('is a NO-OP when the file has not changed (no needless write-back)', async () => {
        const escrow = await generateEncryptionKeypair();
        const client = fakeClient();
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        const result = await syncClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs: fakeFs({ [FILE]: FAKE_ORIGINAL }),
            escrowPublicKey: escrow.publicKeyB64,
        });

        expect(result.status).toBe('unchanged');
        expect(client.puts).toEqual([]);
    });

    it('writes back only ONCE for a repeated rotation (the new blob becomes the baseline)', async () => {
        const escrow = await generateEncryptionKeypair();
        const contents = { [FILE]: FAKE_ROTATED };
        const client = fakeClient();
        const deps = { homeDir: HOME, fs: fakeFs(contents), escrowPublicKey: escrow.publicKeyB64 };
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        expect((await syncClaudeCredentialRotation(client, deps)).status).toBe('written');
        expect((await syncClaudeCredentialRotation(client, deps)).status).toBe('unchanged');
        expect(client.puts).toHaveLength(1);
    });

    it('does nothing when the credential file is absent (revoked, or never set)', async () => {
        const escrow = await generateEncryptionKeypair();
        const client = fakeClient();

        const result = await syncClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs: fakeFs({}),
            escrowPublicKey: escrow.publicKeyB64,
        });

        expect(result.status).toBe('absent');
        expect(client.puts).toEqual([]);
    });

    it('REFUSES to write back with no escrow key rather than sealing to nothing', async () => {
        const client = fakeClient();
        // A real rotation: a baseline exists and the file has since changed.
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        const result = await syncClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs: fakeFs({ [FILE]: FAKE_ROTATED }),
            escrowPublicKey: null,
        });

        expect(result.status).toBe('no-escrow-key');
        expect(client.puts).toEqual([]);
    });

    it('adopts the on-disk blob even with no escrow key, so a LATER rotation is still caught', async () => {
        const escrow = await generateEncryptionKeypair();
        const contents = { [FILE]: FAKE_ORIGINAL };
        const fs = fakeFs(contents);
        const client = fakeClient();

        expect(
            (await syncClaudeCredentialRotation(client, { homeDir: HOME, fs, escrowPublicKey: null }))
                .status,
        ).toBe('adopted');

        contents[FILE] = FAKE_ROTATED;
        const later = await syncClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs,
            escrowPublicKey: escrow.publicKeyB64,
        });

        expect(later.status).toBe('written');
        expect(await sealOpenText(client.puts[0].ciphertext, escrow)).toBe(FAKE_ROTATED);
    });

    it('keeps the OLD baseline when the PUT fails, so the next tick retries', async () => {
        const escrow = await generateEncryptionKeypair();
        const failing: RotationClient = {
            putCredential: vi.fn(async () => {
                throw new Error('tynn unreachable');
            }),
        };
        const deps = {
            homeDir: HOME,
            fs: fakeFs({ [FILE]: FAKE_ROTATED }),
            escrowPublicKey: escrow.publicKeyB64,
        };
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        expect((await syncClaudeCredentialRotation(failing, deps)).status).toBe('error');

        const client = fakeClient();
        expect((await syncClaudeCredentialRotation(client, deps)).status).toBe('written');
        expect(client.puts).toHaveLength(1);
    });

    it('ignores a blank file rather than writing back an empty credential', async () => {
        const escrow = await generateEncryptionKeypair();
        const client = fakeClient();
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        const result = await syncClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs: fakeFs({ [FILE]: '   ' }),
            escrowPublicKey: escrow.publicKeyB64,
        });

        expect(result.status).toBe('absent');
        expect(client.puts).toEqual([]);
    });

    it('treats a reset baseline as "the next read is the truth" without a spurious PUT', async () => {
        const escrow = await generateEncryptionKeypair();
        const client = fakeClient();
        const deps = {
            homeDir: HOME,
            fs: fakeFs({ [FILE]: FAKE_ORIGINAL }),
            escrowPublicKey: escrow.publicKeyB64,
        };

        // No baseline noted: the file on disk is whatever a previous process left.
        // Adopt it silently — Tynn's copy is already the source of that file.
        const result = await syncClaudeCredentialRotation(client, deps);

        expect(result.status).toBe('adopted');
        expect(client.puts).toEqual([]);
        expect((await syncClaudeCredentialRotation(client, deps)).status).toBe('unchanged');
    });

    it('resolves the escrow key lazily, so a long-lived watcher follows a re-keyed host', async () => {
        const first = await generateEncryptionKeypair();
        const second = await generateEncryptionKeypair();
        const contents = { [FILE]: FAKE_ORIGINAL };
        const fs = fakeFs(contents);
        const client = fakeClient();
        let active = first.publicKeyB64;
        const deps = { homeDir: HOME, fs, escrowPublicKey: () => active };
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        contents[FILE] = FAKE_ROTATED;
        await syncClaudeCredentialRotation(client, deps);
        expect(await sealOpenText(client.puts[0].ciphertext, first)).toBe(FAKE_ROTATED);

        active = second.publicKeyB64;
        contents[FILE] = '{"fake":true,"refresh":"fake-refresh-third"}';
        await syncClaudeCredentialRotation(client, deps);
        expect(await sealOpenText(client.puts[1].ciphertext, second)).toBe(contents[FILE]);
    });
});

describe('watchClaudeCredentialRotation', () => {
    it('syncs on a file-change event — event-driven, never polled', async () => {
        const escrow = await generateEncryptionKeypair();
        const contents = { [FILE]: FAKE_ORIGINAL };
        const client = fakeClient();
        let fire: (() => void) | null = null;
        const close = vi.fn();
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        const watcher = watchClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs: fakeFs(contents),
            escrowPublicKey: escrow.publicKeyB64,
            debounceMs: 0,
            watch: (_dir, onChange) => {
                fire = onChange;
                return { close };
            },
        });

        expect(fire).not.toBeNull();
        contents[FILE] = FAKE_ROTATED;
        fire!();
        await vi.waitFor(() => expect(client.puts).toHaveLength(1));
        expect(await sealOpenText(client.puts[0].ciphertext, escrow)).toBe(FAKE_ROTATED);

        watcher.stop();
        expect(close).toHaveBeenCalled();
    });

    it('coalesces a burst of change events into a single write-back', async () => {
        const escrow = await generateEncryptionKeypair();
        const contents = { [FILE]: FAKE_ORIGINAL };
        const client = fakeClient();
        let fire: (() => void) | null = null;
        noteClaudeCredentialBlob(FAKE_ORIGINAL);

        watchClaudeCredentialRotation(client, {
            homeDir: HOME,
            fs: fakeFs(contents),
            escrowPublicKey: escrow.publicKeyB64,
            debounceMs: 5,
            watch: (_dir, onChange) => {
                fire = onChange;
                return { close: vi.fn() };
            },
        });

        contents[FILE] = FAKE_ROTATED;
        fire!();
        fire!();
        fire!();
        await vi.waitFor(() => expect(client.puts).toHaveLength(1));
        expect(client.puts).toHaveLength(1);
    });

    it('survives a watch that cannot be established (no ~/.claude yet)', () => {
        const watcher = watchClaudeCredentialRotation(fakeClient(), {
            homeDir: HOME,
            escrowPublicKey: null,
            watch: () => {
                throw new Error('ENOENT');
            },
        });

        expect(() => watcher.stop()).not.toThrow();
    });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
export const PAIRING_TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'1'.repeat(64)}`;
export const PAIRING_SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];

const exists = (path: string) => lstat(path).then(() => true, () => false);

/**
 * The account's credential file kept with PLAIN fs: what the account reads and writes, staged and renamed into place, with
 * none of the OS permission work Genie's private store does (main/private-credentials.ts: an owner-only ACL through
 * PowerShell on Windows, up to ~10 s a call on a loaded VM). For tests whose subject is the account, not the ACL; the
 * store itself is tested against the real OS in private-credentials*.test.ts.
 */
export const plainCredentialStore = {
    prepare: async (file: string): Promise<void> => { await mkdir(dirname(file), { recursive: true }); },
    migrate: async (legacyFile: string, file: string): Promise<void> => {
        if (!await exists(legacyFile)) return;
        await mkdir(dirname(file), { recursive: true });
        // Two stores are ambiguous: the private store refuses, and so does this one.
        if (await exists(file)) throw new Error('Two Tynn credential stores: refusing to choose one.');
        await rename(legacyFile, file);
    },
    write: async (file: string, text: string): Promise<void> => {
        await mkdir(dirname(file), { recursive: true });
        const temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
        await rename(temp, file);
    },
};

/** An in-memory keychain, never a production store. It answers; its failures are each test's to arrange. */
export function fakeKeychain(seed: Readonly<Record<string, string>> = {}) {
    const held = new Map<string, string>(Object.entries(seed));
    return {
        held,
        probe: async () => ({ ok: true as const }),
        get: async (name: string) => { const value = held.get(name); return value === undefined ? { kind: 'missing' as const } : { kind: 'value' as const, value }; },
        set: async (name: string, value: string) => { held.set(name, value); return { ok: true as const }; },
        delete: async (name: string) => { held.delete(name); return { ok: true as const }; },
    };
}

export function fakeTynnStorage() {
    const dir = mkdtempSync(join(tmpdir(), 'genie-tynn-account-'));
    directories.push(dir);
    return { file: join(dir, 'tynn.json'), secrets: fakeKeychain() };
}

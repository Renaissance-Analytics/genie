import { chmod, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TynnAccount } from '../src/main/tynn-account.js';
import { fakeTynnStorage, PAIRING_SCOPES, PAIRING_TOKEN } from './helpers/tynn-storage.js';

const move = vi.hoisted(() => ({ refused: '' }));
vi.mock('node:fs/promises', async (original) => {
    const fs = await original<typeof import('node:fs/promises')>();
    return { ...fs, rename: async (from: string, to: string) => {
        if (String(from) === move.refused) throw Object.assign(new Error('fixture move denied'), { code: 'EACCES' });
        return fs.rename(from, to);
    } };
});
afterEach(() => { move.refused = ''; });
const CODE = 'w'.repeat(64);
async function fixture(seed = true) {
    const storage = fakeTynnStorage(); const home = dirname(storage.file); const calls: string[] = [];
    const user = { id: 'fixture-user', name: 'Fixture', email: 'fixture@example.invalid' };
    const ports = { ...storage, host: () => 'https://fixture.invalid',
        cookies: { clear: async () => {}, get: async () => null, set: async () => {} },
        fetch: async (_url: string, init: { credentials: string; headers: Record<string, string> }) => {
            calls.push(init.credentials === 'include' ? 'exchange' : 'restore');
            return { ok: true, status: 200, text: async () => JSON.stringify(init.credentials === 'include' ? { ...user, pairing_token: PAIRING_TOKEN, pairing_scopes: PAIRING_SCOPES } : user) };
        },
    };
    if (seed) expect((await (await TynnAccount.open(ports)).signIn(CODE)).ok).toBe(true);
    await chmod(home, 0o755); if (seed) await chmod(storage.file, 0o644);
    await writeFile(join(home, 'runtime-fixture'), 'shared runtime'); await chmod(join(home, 'runtime-fixture'), 0o644);
    calls.splice(0);
    const next = { ...ports, file: join(home, 'credentials', 'tynn.json'), legacyFile: storage.file };
    return { home, legacy: storage.file, next, calls };
}

it('production pairing storage is inside its own directory and declares the old file for migration', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const main = source.match(/tynnAccount = await TynnAccount\.open\(\{[\s\S]*?\n    \}\)/)?.[0];
    expect(main).toMatch(/file:\s*join\(genieHome\(\),\s*'credentials',\s*'tynn\.json'\)/);
    expect(main).toMatch(/legacyFile:\s*join\(genieHome\(\),\s*'tynn\.json'\)/);
});

describe.skipIf(process.platform === 'win32')('Tynn account credential migration', () => {
    it('moves an existing encrypted credential, restores without exchanging and preserves parent and sibling permissions', async () => {
        const t = await fixture(); const original = await readFile(t.legacy, 'utf8');
        expect((await TynnAccount.open(t.next)).status().signedIn).toBe(true);
        expect(t.calls).toEqual(['restore']); expect(await readFile(t.next.file, 'utf8')).toBe(original);
        await expect(stat(t.legacy)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await stat(t.home)).mode & 0o777).toBe(0o755);
        expect((await stat(dirname(t.next.file))).mode & 0o777).toBe(0o700);
        expect((await stat(t.next.file)).mode & 0o777).toBe(0o600);
        expect((await stat(join(t.home, 'runtime-fixture'))).mode & 0o777).toBe(0o644);
    });

    it('pairs normally when no legacy credential exists without changing the home permissions', async () => {
        const t = await fixture(false); const account = await TynnAccount.open(t.next);
        expect((await account.signIn(CODE)).ok).toBe(true); expect(t.calls).toEqual(['exchange']);
        expect((await stat(t.home)).mode & 0o777).toBe(0o755);
    });

    it('restricts the legacy file first and refuses exchange if the destination directory cannot be created', async () => {
        const t = await fixture(); const original = await readFile(t.legacy, 'utf8');
        await writeFile(dirname(t.next.file), 'blocked destination');
        const account = await TynnAccount.open(t.next);
        expect(account.status().signedIn).toBe(false); expect((await account.signIn(CODE)).ok).toBe(false);
        expect(t.calls).toEqual([]); expect(await readFile(t.legacy, 'utf8')).toBe(original);
        expect((await stat(t.legacy)).mode & 0o777).toBe(0o600);
        expect((await stat(t.home)).mode & 0o777).toBe(0o755);
    });

    it('fails closed without overwriting either file when old and new locations both contain credentials', async () => {
        const t = await fixture(); const original = await readFile(t.legacy, 'utf8');
        await mkdir(dirname(t.next.file)); await writeFile(t.next.file, original);
        const account = await TynnAccount.open(t.next);
        expect(account.status().signedIn).toBe(false); expect((await account.signIn(CODE)).ok).toBe(false);
        expect(t.calls).toEqual([]); expect(await readFile(t.next.file, 'utf8')).toBe(original);
        expect(await readFile(t.legacy, 'utf8')).toBe(original); expect((await stat(t.legacy)).mode & 0o777).toBe(0o600);
    });

    it('refuses restore and exchange when the actual migration rename fails, retaining the restricted legacy file', async () => {
        const t = await fixture(); const original = await readFile(t.legacy, 'utf8'); move.refused = t.legacy;
        const account = await TynnAccount.open(t.next);
        expect(account.status().signedIn).toBe(false); expect((await account.signIn(CODE)).ok).toBe(false);
        expect(t.calls).toEqual([]); expect(await readFile(t.legacy, 'utf8')).toBe(original);
        expect((await stat(t.legacy)).mode & 0o777).toBe(0o600);
        await expect(stat(t.next.file)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses a symlinked legacy file before restore, exchange or permission changes to its target', async () => {
        const t = await fixture(); const original = `${t.legacy}.original`; await rename(t.legacy, original); await symlink(original, t.legacy);
        const account = await TynnAccount.open(t.next);
        expect(account.status().signedIn).toBe(false); expect((await account.signIn(CODE)).ok).toBe(false);
        expect(t.calls).toEqual([]); expect((await stat(original)).mode & 0o777).toBe(0o644);
    });
});

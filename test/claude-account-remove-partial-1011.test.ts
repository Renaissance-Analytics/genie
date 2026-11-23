import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A REMOVAL THAT STARTED AND DID NOT FINISH SAYS SO (Tynn #1011; the review of #2139, finding 1). On Windows a file still in
 * use stops the removal of an account's folder part-way. Whoever asked for it must be able to tell that from a folder Genie
 * will not remove at all (one that kept its own history, one that is not Genie's): the first is finished by asking again, so
 * the account stays in the book until it is; the second is the person's to keep. `partial: true` is that difference.
 * The file system's refusal is made here (rmdir of the folder itself fails as a busy folder does); nothing else is faked.
 */
const stuck = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('node:fs', async (original) => {
    const real = await original<typeof import('node:fs')>();
    const rmdirSync = ((path: string, ...rest: unknown[]) => {
        if (stuck.path !== null && String(path) === stuck.path) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: 'EBUSY' });
        return (real.rmdirSync as (...a: unknown[]) => void)(path, ...rest);
    }) as typeof real.rmdirSync;
    return { ...real, default: { ...real, rmdirSync }, rmdirSync };
});

const { removeAccountDir } = await import('../src/main/claude-account-dirs.js');
const { existsSync } = await import('node:fs');

describe('removeAccountDir: partial or not', () => {
    let dir: string;
    const accountsRoot = () => join(dir, 'accounts', 'claude');
    const account = () => join(accountsRoot(), `account_${'a'.repeat(32)}`);
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'genie-1011-partial-'));
        mkdirSync(account(), { recursive: true });
        writeFileSync(join(account(), 'settings.json'), '{}');
        stuck.path = null;
    });
    afterEach(() => { stuck.path = null; rmSync(dir, { recursive: true, force: true }); });

    it('a folder that could not be removed completely is `partial`, and the same call finishes it once it can', () => {
        stuck.path = account();
        const first = removeAccountDir(account(), accountsRoot());
        expect(first).toMatchObject({ ok: false, partial: true });
        expect(first.ok === false && first.reason).toMatch(/could not be removed completely: EBUSY/);
        // Part of it went (its file), the folder is still there.
        expect(existsSync(join(account(), 'settings.json'))).toBe(false);
        expect(existsSync(account())).toBe(true);
        stuck.path = null;
        expect(removeAccountDir(account(), accountsRoot())).toEqual({ ok: true });
        expect(existsSync(account())).toBe(false);
    });

    it('CONTROL: a folder Genie will not remove at all is not `partial`', () => {
        mkdirSync(join(account(), 'projects'));
        const own = removeAccountDir(account(), accountsRoot());
        expect(own.ok).toBe(false);
        expect(own.ok === false && own.partial).toBeUndefined();
        const notGenies = removeAccountDir(join(dir, 'elsewhere'), accountsRoot());
        expect(notGenies.ok === false && notGenies.partial).toBeUndefined();
    });
});

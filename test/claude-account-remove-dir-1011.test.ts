import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeAccountDir } from '../src/main/claude-account-dirs.js';

/**
 * SIGN OUT AND REMOVE, THE FOLDER (Tynn #1011). An account folder's `projects` is a LINK to everyone's shared conversations:
 * removing the folder removes the link as a link and never follows it (a recursive delete that followed a junction would
 * empty the shared store). Only `<accounts root>/account_<id>` is ever touched; a folder that kept its own history stays.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-1011-rmdir-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const setup = () => {
    const store = join(dir, 'home', '.claude', 'projects');
    mkdirSync(join(store, '-some-project'), { recursive: true });
    writeFileSync(join(store, '-some-project', 'thread.jsonl'), 'everyone\'s history');
    const root = join(dir, 'genie', 'accounts', 'claude');
    const account = join(root, `account_${'1'.repeat(32)}`);
    mkdirSync(join(account, 'sessions'), { recursive: true });
    writeFileSync(join(account, 'settings.json'), '{"cleanupPeriodDays":30}');
    symlinkSync(resolve(store), join(account, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    return { store, root, account };
};

describe('removeAccountDir', () => {
    it('removes the folder and its link; the store and every transcript in it are untouched', () => {
        const { store, root, account } = setup();
        expect(removeAccountDir(account, root)).toEqual({ ok: true });
        expect(existsSync(account)).toBe(false);
        expect(readFileSync(join(store, '-some-project', 'thread.jsonl'), 'utf8')).toBe('everyone\'s history');
    });

    it('a link anywhere inside is removed as a link, never followed', () => {
        const { store, root, account } = setup();
        mkdirSync(join(account, 'plugins'), { recursive: true });
        symlinkSync(resolve(store), join(account, 'plugins', 'elsewhere'), process.platform === 'win32' ? 'junction' : 'dir');
        expect(removeAccountDir(account, root)).toEqual({ ok: true });
        expect(existsSync(join(store, '-some-project', 'thread.jsonl'))).toBe(true);
    });

    it('refuses any folder that is not one Genie made for an account, and touches nothing', () => {
        const { root, account } = setup();
        for (const outside of [join(dir, 'home', '.claude'), root, join(root, '..'), join(account, 'sessions'), join(root, 'not-an-account')]) {
            expect(removeAccountDir(outside, root).ok).toBe(false);
        }
        expect(existsSync(account)).toBe(true);
    });

    it('a folder that kept its OWN history (a real projects) is not removed: that history is the person\'s', () => {
        const root = join(dir, 'genie', 'accounts', 'claude');
        const account = join(root, `account_${'2'.repeat(32)}`);
        mkdirSync(join(account, 'projects', '-p'), { recursive: true });
        writeFileSync(join(account, 'projects', '-p', 'mine.jsonl'), 'kept');
        expect(removeAccountDir(account, root).ok).toBe(false);
        expect(readFileSync(join(account, 'projects', '-p', 'mine.jsonl'), 'utf8')).toBe('kept');
    });

    it('a folder already gone is nothing to do', () => {
        const root = join(dir, 'genie', 'accounts', 'claude');
        expect(removeAccountDir(join(root, `account_${'3'.repeat(32)}`), root)).toEqual({ ok: true });
    });

    it('reads no file\'s contents (source guard)', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/main/claude-account-dirs.ts'), 'utf8').replace(/\r\n/g, '\n');
        const at = src.indexOf('export function removeAccountDir');
        const body = src.slice(src.indexOf('function removeLink'), src.indexOf('\n}\n', at) + 3);
        expect(body).toContain('lstatSync');
        expect(body).not.toMatch(/readFile|createReadStream/);
    });
});

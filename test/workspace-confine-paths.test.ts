import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confinePath, confinePathSync, insideOrRoot, OutsideWorkspaceError } from '../src/main/workspace-confine.js';

/**
 * THE SHARED CHECK FOR A PATH AN AGENT NAMES (genie#1354) — the one `openFileForUser`, a question's files, a site's or a
 * process's folder, `services exec`'s folder and a flow's `terminal_run` folder go through, beside the attachment checks
 * genie#1347 added. Lexical first (no disk), then after links: a symlink or junction under the root that leads out of it
 * is refused. A folder to run or serve in may be the root itself (`allowRoot`); a file never is.
 */

const dirLink = (target: string, link: string) => symlink(target, link, 'junction');
const canFileSymlink = (() => {
    const probe = mkdtempSync(path.join(tmpdir(), 'genie2-symprobe-'));
    try {
        writeFileSync(path.join(probe, 't'), 'x');
        symlinkSync(path.join(probe, 't'), path.join(probe, 'l'), 'file');
        return true;
    } catch {
        return false;
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();

describe('insideOrRoot — lexical, the root itself allowed', () => {
    it('POSIX: inside, the root, and a name starting with two dots resolve; a step out does not', () => {
        const p = path.posix;
        expect(insideOrRoot('/home/u/ws', '.', p)).toBe('/home/u/ws');
        expect(insideOrRoot('/home/u/ws', '/home/u/ws', p)).toBe('/home/u/ws');
        expect(insideOrRoot('/home/u/ws', 'repos/app', p)).toBe('/home/u/ws/repos/app');
        expect(insideOrRoot('/home/u/ws', '..config', p)).toBe('/home/u/ws/..config');
        expect(insideOrRoot('/home/u/ws', '..', p)).toBeNull();
        expect(insideOrRoot('/home/u/ws', '../ws-other', p)).toBeNull();
        expect(insideOrRoot('/home/u/ws', '/etc', p)).toBeNull();
        expect(insideOrRoot('ws', '.', p)).toBeNull();
    });

    it('Windows: another drive and UNC are refused; case is ignored', () => {
        const w = path.win32;
        expect(insideOrRoot('C:\\Users\\u\\ws', 'c:\\users\\u\\WS', w)).toBe('c:\\users\\u\\WS');
        expect(insideOrRoot('C:\\Users\\u\\ws', '..build', w)).toBe('C:\\Users\\u\\ws\\..build');
        expect(insideOrRoot('C:\\Users\\u\\ws', 'D:\\Users\\u\\ws', w)).toBeNull();
        expect(insideOrRoot('C:\\Users\\u\\ws', '\\\\server\\share', w)).toBeNull();
    });
});

describe('confinePath — after links', () => {
    let base: string;
    let ws: string;
    let outside: string;
    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'genie2-confine-path-'));
        ws = join(base, 'ws');
        outside = join(base, 'outside');
        await mkdir(join(ws, 'docs'), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, 'secret.txt'), 'x');
    });
    afterEach(async () => { await rm(base, { recursive: true, force: true }); });

    it('a path inside (existing or not yet) is its lexical absolute path', async () => {
        expect(await confinePath(ws, 'docs', 'nothing was done')).toBe(resolve(ws, 'docs'));
        expect(await confinePath(ws, 'docs/new/deep.md', 'nothing was done')).toBe(resolve(ws, 'docs/new/deep.md'));
        expect(await confinePath(ws, '..config', 'nothing was done')).toBe(resolve(ws, '..config'));
    });

    it('the root itself only with allowRoot', async () => {
        await expect(confinePath(ws, '.', 'nothing was done')).rejects.toBeInstanceOf(OutsideWorkspaceError);
        expect(await confinePath(ws, '.', 'nothing was done', { allowRoot: true })).toBe(resolve(ws));
    });

    it('a directory link that leads out is refused — through it, and as the folder itself', async () => {
        await dirLink(outside, join(ws, 'escape'));
        await expect(confinePath(ws, 'escape/secret.txt', 'nothing was opened')).rejects.toThrow(/escape\/secret\.txt is outside your workspace; nothing was opened/);
        await expect(confinePath(ws, 'escape', 'nothing was run', { allowRoot: true })).rejects.toBeInstanceOf(OutsideWorkspaceError);
        await expect(confinePath(ws, 'escape/not-yet/x', 'nothing was done')).rejects.toBeInstanceOf(OutsideWorkspaceError);
        expect(() => confinePathSync(ws, 'escape', 'nothing was run', { allowRoot: true })).toThrow(OutsideWorkspaceError);
    });

    it('the refusal names only the path given, never the link target', async () => {
        await dirLink(outside, join(ws, 'escape'));
        const message = await confinePath(ws, 'escape/secret.txt', 'nothing was opened').catch((e: Error) => e.message);
        expect(message).not.toContain(outside);
    });

    it.runIf(canFileSymlink)('a file symlink that leads out, and a DANGLING one, are refused', async () => {
        await symlink(join(outside, 'secret.txt'), join(ws, 'innocent.md'), 'file');
        await symlink(join(outside, 'not-yet.md'), join(ws, 'dangling.md'), 'file');
        await expect(confinePath(ws, 'innocent.md', 'nothing was opened')).rejects.toBeInstanceOf(OutsideWorkspaceError);
        await expect(confinePath(ws, 'dangling.md', 'nothing was opened')).rejects.toBeInstanceOf(OutsideWorkspaceError);
    });

    it('POSITIVE CONTROL: a link that stays inside is fine, as the path given', async () => {
        await dirLink(join(ws, 'docs'), join(ws, 'alias'));
        expect(await confinePath(ws, 'alias/a.md', 'nothing was opened')).toBe(resolve(ws, 'alias/a.md'));
    });

    it('a workspace reached THROUGH a link is still its own inside', async () => {
        await dirLink(ws, join(base, 'ws-link'));
        expect(await confinePath(join(base, 'ws-link'), 'docs', 'nothing was done')).toBe(resolve(base, 'ws-link', 'docs'));
    });

    it('a root that does not exist has nothing on disk to follow: the lexical answer stands', async () => {
        const gone = join(base, 'not-made');
        expect(await confinePath(gone, 'docs/a.md', 'nothing was done')).toBe(resolve(gone, 'docs/a.md'));
        await expect(confinePath(gone, '../outside/secret.txt', 'nothing was done')).rejects.toBeInstanceOf(OutsideWorkspaceError);
    });
});

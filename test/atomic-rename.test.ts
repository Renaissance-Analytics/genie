import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENAME_RETRY_DELAYS_MS, renameOver, renameOverSync } from '../src/core/atomic-rename.js';

/*
 * AN ATOMIC WRITE SURVIVES A BRIEF LOCK ON WINDOWS (Tynn #580). On genie#1781's Windows run a relaunched genie-host died with
 * "could not start: Error: EPERM … rename …\runtime\host.json.6732.3.tmp", then "did not become ready within 20 s". A rename
 * fails with EPERM, EACCES or EBUSY while another program (Defender, the indexer) briefly holds the file, and the one write
 * that retried gave up after 300 ms. One helper for every runtime atomic write: a bounded retry, never a temp file left
 * behind, and a failure that names the file and why.
 */

const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename 'a.tmp' -> 'a'`), { code });

function ports(failures: readonly string[], platform: NodeJS.Platform = 'win32') {
    const log: string[] = [];
    let at = 0;
    return {
        log,
        async: {
            platform,
            rename: async () => { log.push('rename'); const code = failures[at++]; if (code) throw errno(code); },
            remove: async (path: string) => { log.push(`remove ${path}`); },
            sleep: async (ms: number) => { log.push(`sleep ${ms}`); },
        },
        sync: {
            platform,
            rename: () => { log.push('rename'); const code = failures[at++]; if (code) throw errno(code); },
            remove: (path: string) => { log.push(`remove ${path}`); },
            sleep: (ms: number) => { log.push(`sleep ${ms}`); },
        },
    };
}

describe('renameOver', () => {
    it('rides out a lock that outlasts the old 300 ms: past six refusals, within its bound (control: no refusal, no wait)', async () => {
        const held = ports(['EPERM', 'EBUSY', 'EACCES', 'EPERM', 'EBUSY', 'EACCES', 'EPERM']);
        await expect(renameOver('h.tmp', 'host.json', held.async)).resolves.toBeUndefined();
        expect(held.log.filter((l) => l === 'rename')).toHaveLength(8);
        const free = ports([]);
        await renameOver('h.tmp', 'host.json', free.async);
        expect(free.log).toEqual(['rename']);
    });

    it('is bounded: at the end it removes the temp file and says which file and why, keeping the code', async () => {
        const stuck = ports(Array(100).fill('EPERM'));
        const error = await renameOver('h.tmp', 'C:/g/runtime/host.json', stuck.async).catch((e: unknown) => e as NodeJS.ErrnoException);
        expect(stuck.log.filter((l) => l === 'rename')).toHaveLength(RENAME_RETRY_DELAYS_MS.length + 1);
        expect(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3_000);
        expect(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
        expect(stuck.log.at(-1)).toBe('remove h.tmp');
        expect((error as Error).message).toContain('could not write C:/g/runtime/host.json');
        expect((error as Error).message).toContain('EPERM');
        expect((error as Error).message).toContain('another program');
        expect((error as NodeJS.ErrnoException).code).toBe('EPERM');
    });

    it('a real failure is not retried: another code on Windows, or any of these off Windows (control: the same code on Windows is)', async () => {
        const gone = ports(['ENOENT']);
        await expect(renameOver('h.tmp', 'host.json', gone.async)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(gone.log).toEqual(['rename', 'remove h.tmp']);
        const linux = ports(['EACCES'], 'linux');
        await expect(renameOver('h.tmp', 'host.json', linux.async)).rejects.toMatchObject({ code: 'EACCES' });
        expect(linux.log).toEqual(['rename', 'remove h.tmp']);
        const windows = ports(['EACCES']);
        await expect(renameOver('h.tmp', 'host.json', windows.async)).resolves.toBeUndefined();
    });

    it('the synchronous one retries too, for a much shorter time: it holds its thread', () => {
        const held = ports(['EPERM', 'EBUSY']);
        expect(() => renameOverSync('h.tmp', 'pty.json', held.sync)).not.toThrow();
        expect(held.log.filter((l) => l === 'rename')).toHaveLength(3);
        const stuck = ports(Array(100).fill('EBUSY'));
        expect(() => renameOverSync('h.tmp', 'pty.json', stuck.sync)).toThrow(/could not write pty\.json/);
        expect(stuck.log.at(-1)).toBe('remove h.tmp');
        const total = stuck.log.filter((l) => l.startsWith('sleep')).reduce((n, l) => n + Number(l.slice(6)), 0);
        expect(total).toBeGreaterThan(0);
        expect(total).toBeLessThanOrEqual(500);
    });
});

describe('every runtime atomic write goes through it (source guard)', () => {
    const files: string[] = [];
    const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk('src/main'); walk('src/core');
    // A temp file renamed over its target, by the names this code base gives one.
    const BARE = /(?<![.\w])rename(?:Sync)?\(\s*(?:tmp|temp|temporary|fresh|part)\s*,/;

    it('finds the helper itself (positive control: the pattern matches its own calls), and no other file renames a temp file over its target', () => {
        const hits = files.filter((f) => BARE.test(readFileSync(f, 'utf8')) || /renameSync\(tmp, file\)/.test(readFileSync(f, 'utf8')));
        expect(BARE.test('await rename(tmp, file);')).toBe(true);
        expect(BARE.test('await renameOver(tmp, file);')).toBe(false);
        expect(hits.map((f) => f.split(/[\\/]/).join('/'))).toEqual([]);
    });
});

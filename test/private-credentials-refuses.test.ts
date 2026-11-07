import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A FAILED ACL REFUSES THE WRITE, ON LINUX (the Windows half, with the native command really gone, is in test/private-credentials-windows.test.ts). The secret must not reach its
 * file, or stay anywhere on disk, when permissions could not be secured, and what was there must survive. These use `chmod` failing, the one way POSIX restriction fails short of
 * a wrong owner: it never fails on a healthy machine, so it is forced.
 */
const faults = vi.hoisted(() => ({ failOn: null as RegExp | null }));
vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, chmod: async (path: string, mode: number) => { if (faults.failOn?.test(String(path))) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); return actual.chmod(path, mode); } };
});
const { writePrivateCredential } = await import('../src/main/private-credentials.js');

const SECRET = 'rpk_a_secret_that_must_not_be_left_on_disk';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'acl-refuses-')); faults.failOn = null; });
afterEach(async () => { faults.failOn = null; await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

/** Every file under the root, read: the secret anywhere at all is a failure. */
async function holdingTheSecret(): Promise<string[]> {
    const found: string[] = [];
    for (const name of await readdir(root, { recursive: true })) {
        const text = await readFile(join(root, String(name)), 'utf8').catch(() => '');
        if (text.includes(SECRET)) found.push(String(name));
    }
    return found;
}

describe.skipIf(process.platform === 'win32')('a failed chmod refuses the write', () => {
    it('CONTROL: with chmod working, the secret reaches its file', async () => {
        const file = join(root, 'vault', 'agents.json');
        await writePrivateCredential(file, SECRET);
        expect(await readFile(file, 'utf8')).toBe(SECRET);
    });

    it('on the staged file: refused, the secret nowhere, and no staging file left', async () => {
        const file = join(root, 'vault', 'agents.json');
        faults.failOn = /\.tmp$/;
        await expect(writePrivateCredential(file, SECRET)).rejects.toThrow();
        expect(await holdingTheSecret()).toEqual([]);
        expect((await readdir(root, { recursive: true })).filter((name) => String(name).endsWith('.tmp'))).toEqual([]);
    });

    it('on the folder: refused before anything is staged', async () => {
        const file = join(root, 'vault', 'agents.json');
        faults.failOn = /vault$/;
        await expect(writePrivateCredential(file, SECRET)).rejects.toThrow();
        expect(await holdingTheSecret()).toEqual([]);
    });

    it('an existing credential survives a refused rewrite, byte for byte', async () => {
        const folder = join(root, 'vault');
        await mkdir(folder);
        const file = join(folder, 'agents.json');
        await writeFile(file, 'what was already sealed');
        faults.failOn = /\.tmp$/;
        await expect(writePrivateCredential(file, SECRET)).rejects.toThrow();
        expect(await readFile(file, 'utf8')).toBe('what was already sealed');
        expect(await holdingTheSecret()).toEqual([]);
    });
});

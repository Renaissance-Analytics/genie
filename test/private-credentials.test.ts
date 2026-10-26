import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePrivateCredential } from '../src/main/private-credentials.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'genie-private-directory-')); roots.push(root);
    const file = join(root, 'credential.json'); await writeFile(file, 'encrypted fixture');
    await chmod(root, 0o755); await chmod(file, 0o644);
    return { root, file };
}

describe.skipIf(process.platform === 'win32')('private credential directory occupancy', () => {
    it.each(['file', 'directory'] as const)('refuses an unrelated %s before changing any permissions', async (kind) => {
        const { root, file } = await fixture(); const sibling = join(root, 'runtime');
        if (kind === 'file') await writeFile(sibling, 'unrelated runtime'); else await mkdir(sibling);
        const siblingMode = (await stat(sibling)).mode & 0o777;
        await expect(preparePrivateCredential(file)).rejects.toThrow('unrelated entries');
        expect((await stat(root)).mode & 0o777).toBe(0o755);
        expect((await stat(file)).mode & 0o777).toBe(0o644);
        expect((await stat(sibling)).mode & 0o777).toBe(siblingMode);
        expect(await readFile(file, 'utf8')).toBe('encrypted fixture');
    });

    it('allows only its credential and canonical UUID temporary files', async () => {
        const { root, file } = await fixture();
        const temporary = `${file}.00000000-0000-4000-8000-000000000000.tmp`; await writeFile(temporary, 'encrypted temp', { mode: 0o600 });
        await preparePrivateCredential(file);
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(await readFile(temporary, 'utf8')).toBe('encrypted temp');
    });
});

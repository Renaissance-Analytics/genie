import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPhpExtensionEffects, type PhpExtensionPrimitives } from '../php-extension-effects';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const ABI = { version: '8.4.24', zts: true, bits: 64, debug: false, build: 'API20240924,TS,VS17' };
const MODULES = '[PHP Modules]\ncurl\nredis\n[Zend Modules]\n';

async function harness() {
    const dir = await mkdtemp(join(tmpdir(), 'genie-extension-effects-test-'));
    dirs.push(dir);
    const archive = join(dir, 'archive.zip');
    await writeFile(archive, 'verified archive fixture');
    const deps: PhpExtensionPrimitives = {
        run: vi.fn(async () => ({ code: 0, stdout: MODULES, stderr: '' })),
        download: vi.fn(async () => ({ ok: true, path: archive })),
        unzip: vi.fn(async (_zip, dest) => { await writeFile(join(dest, 'php_redis.dll'), 'DLL fixture'); return { ok: true }; }),
    };
    const artifact = { name: 'redis', version: '6.3.0', file: 'php_redis.dll', url: 'https://downloads.php.net/test.zip',
        sha256: createHash('sha256').update('verified archive fixture').digest('hex') };
    return { dir, archive, deps, fx: createPhpExtensionEffects(deps), artifact };
}

describe('real PHP extension effects behind bounded process/network primitives', () => {
    it('reads only explicitly selected ABI facts from the actual binary', async () => {
        const h = await harness();
        vi.mocked(h.deps.run).mockResolvedValue({ code: 0, stdout: JSON.stringify(ABI), stderr: '' });
        expect(await h.fx.inspect('/managed/php.exe')).toEqual(ABI);
        const [exe, args] = vi.mocked(h.deps.run).mock.calls[0];
        expect(exe).toBe('/managed/php.exe');
        expect(args.slice(0, 2)).toEqual(['-n', '-r']);
        expect(args[2]).toContain('phpinfo(INFO_GENERAL)');
        expect(args[2]).toContain('ob_get_clean()');
    });
    it('does not accept ABI JSON from an unsuccessful process', async () => {
        const h = await harness();
        vi.mocked(h.deps.run).mockResolvedValue({ code: 1, stdout: JSON.stringify(ABI), stderr: '' });
        expect(await h.fx.inspect('/managed/php.exe')).toBeNull();
        expect(h.deps.run).toHaveBeenCalled();
    });
    it.each([
        [undefined, undefined],
        ['/staged/php_redis.dll', 'extension="/staged/php_redis.dll"'],
        ['C:\\Users\\RUNNER~1\\Temp (test)\\php_redis.dll', 'extension="C:/Users/RUNNER~1/Temp (test)/php_redis.dll"'],
    ])('verifies CLI and CGI, with the intended ini scope (%s)', async (dll, directive) => {
        const h = await harness();
        const install = { dir: h.dir, exe: join(h.dir, 'php.exe'), platform: 'win32' };
        expect(await h.fx.verify(install, dll)).toBe(true);
        const args = dll ? ['-n', '-d', directive, '-m'] : ['-c', join(h.dir, 'php.ini'), '-m'];
        expect(h.deps.run).toHaveBeenCalledWith(install.exe, args);
        expect(h.deps.run).toHaveBeenCalledWith(join(h.dir, 'php-cgi.exe'), args);
    });
    it.each([
        { code: 1, stdout: MODULES, stderr: '' },
        { code: 0, stdout: MODULES, stderr: 'Unable to load a dependency' },
        { code: 0, stdout: '[PHP Modules]\ncurl\n[Zend Modules]', stderr: '' },
    ])('fails when CGI does not prove a clean loaded Redis module: %j', async (bad) => {
        const h = await harness();
        vi.mocked(h.deps.run).mockResolvedValueOnce({ code: 0, stdout: MODULES, stderr: '' }).mockResolvedValueOnce(bad);
        expect(await h.fx.verify({ dir: h.dir, exe: join(h.dir, 'php.exe'), platform: 'win32' })).toBe(false);
        expect(h.deps.run).toHaveBeenCalledTimes(2);
    });
    it('extracts only after the pinned checksum matches, then cleans staging and download', async () => {
        const h = await harness();
        const staged = await h.fx.stage(h.artifact);
        expect(await readFile(staged.dll, 'utf8')).toBe('DLL fixture');
        expect(h.deps.unzip).toHaveBeenCalled();
        await staged.dispose();
        await expect(readFile(staged.dll)).rejects.toThrow();
        await expect(readFile(h.archive)).rejects.toThrow();
    });
    it('names the failing SAPI and loader complaint when preflight fails on another machine', async () => {
        const h = await harness();
        vi.mocked(h.deps.run).mockResolvedValueOnce({ code: 0, stdout: MODULES, stderr: '' })
            .mockResolvedValueOnce({ code: 0, stdout: '[PHP Modules]\nCore\n[Zend Modules]', stderr: 'PHP Startup: Unable to load dynamic library redis: missing runtime DLL' });
        await expect(h.fx.verify({ dir: h.dir, exe: join(h.dir, 'php.exe'), platform: 'win32' }, '/staged/php_redis.dll'))
            .rejects.toThrow(/php-cgi\.exe.*Unable to load dynamic library redis/);
    });
    it('rejects corrupted archives before extraction and cleans the download', async () => {
        const h = await harness();
        await expect(h.fx.stage({ ...h.artifact, sha256: '0'.repeat(64) })).rejects.toThrow(/checksum/i);
        expect(h.deps.download).toHaveBeenCalled();
        expect(h.deps.unzip).not.toHaveBeenCalled();
        await expect(readFile(h.archive)).rejects.toThrow();
    });
});

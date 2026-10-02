import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installPhpExtensions, redisArtifactFor, repairManagedPhpExtensions, type PhpExtensionEffects } from '../php-extensions';
import type { EngineInstall } from '../toolchain-versions';

const ABI = { version: '8.4.24', zts: true, bits: 64, debug: false, build: 'API20240924,TS,VS17' };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function harness() {
    const dir = await mkdtemp(join(tmpdir(), 'genie-extension-test-'));
    dirs.push(dir);
    await mkdir(join(dir, 'ext'));
    await writeFile(join(dir, 'php.ini'), '; original\nextension=curl\n');
    const dll = join(dir, 'downloaded-redis.dll');
    await writeFile(dll, 'new compatible DLL');
    let checks = 0;
    const fx: PhpExtensionEffects = {
        inspect: vi.fn(async () => ABI),
        verify: vi.fn(async () => ++checks > 1),
        stage: vi.fn(async () => ({ dll, dispose: vi.fn(async () => {}) })),
    };
    return { dir, fx, install: { dir, exe: join(dir, 'php.exe'), platform: 'win32' } };
}

describe('PECL ABI selection', () => {
    it('matches the measured 8.4.24 ZTS x64 VS17 ABI to an immutable official artifact', () => {
        expect(redisArtifactFor(ABI)).toEqual({
            name: 'redis', version: '6.3.0', file: 'php_redis.dll',
            url: 'https://downloads.php.net/~windows/pecl/releases/redis/6.3.0/php_redis-6.3.0-8.4-ts-vs17-x64.zip',
            sha256: 'ab63ee174ce18766179af7b9fcb540207817fb4187b8178795468cfbf0e277b5',
        });
    });
    it.each([
        { zts: false }, { bits: 32 }, { debug: true }, { build: 'API20240924,NTS,VS17' },
        { build: 'API20240924,TS,VS16' }, { build: 'API00000000,TS,VS17' }, { version: '8.6.0' },
    ])('refuses an incompatible or unknown ABI: %j', (change) => {
        expect(redisArtifactFor({ ...ABI, ...change })).toBeNull();
    });
    it.each([
        ['8.2.33', 'API20220829,TS,VS16', '8.2-ts-vs16'],
        ['8.3.33', 'API20230831,TS,VS16', '8.3-ts-vs16'],
    ])('supports the other managed PHP version %s', (version, build, suffix) => {
        expect(redisArtifactFor({ ...ABI, version, build })?.url).toContain(suffix);
    });
});

describe('installing PHP extensions', () => {
    it('repairs only Genie-owned PHP and reports each actual outcome', async () => {
        const managed: EngineInstall = { tool: 'php', version: '8.4.24', dir: '/managed/php', exe: '/managed/php/php.exe', source: 'genie', removable: true };
        const ensure = vi.fn(async () => ({ ok: false as const, error: 'ABI mismatch' }));
        const report = await repairManagedPhpExtensions([
            managed, { ...managed, dir: '/other/php', source: 'herd' }, { ...managed, tool: 'node' },
        ], 'win32', ensure);
        expect(ensure).toHaveBeenCalledExactlyOnceWith(managed.dir, managed.exe);
        expect(report).toEqual([{ dir: managed.dir, ok: false, error: 'ABI mismatch' }]);
        expect(await repairManagedPhpExtensions([managed], 'linux', ensure)).toEqual([]);
        expect(ensure).toHaveBeenCalledTimes(1);
    });
    it('preflights the DLL, enables it once, and verifies the configured CLI and CGI', async () => {
        const h = await harness();
        expect(await installPhpExtensions(h.install, h.fx)).toEqual({ ok: true, changed: true });
        expect(await readFile(join(h.dir, 'ext/php_redis.dll'), 'utf8')).toBe('new compatible DLL');
        expect(await readFile(join(h.dir, 'php.ini'), 'utf8')).toBe('; original\nextension=curl\nextension=redis\n');
        expect(h.fx.verify).toHaveBeenCalledTimes(3);
        expect(h.fx.verify).toHaveBeenNthCalledWith(2, h.install, join(h.dir, 'downloaded-redis.dll'));
        expect(h.fx.verify).toHaveBeenLastCalledWith(h.install);
        const staged = await vi.mocked(h.fx.stage).mock.results[0].value;
        expect(staged.dispose).toHaveBeenCalled();
    });
    it('does not download or write when both serving binaries already load Redis', async () => {
        const h = await harness();
        vi.mocked(h.fx.verify).mockResolvedValue(true);
        expect(await installPhpExtensions(h.install, h.fx)).toEqual({ ok: true, changed: false });
        expect(h.fx.stage).not.toHaveBeenCalled();
        expect(await readFile(join(h.dir, 'php.ini'), 'utf8')).toBe('; original\nextension=curl\n');
    });
    it('rejects the real binary ABI before downloading anything', async () => {
        const h = await harness();
        vi.mocked(h.fx.inspect).mockResolvedValue({ ...ABI, zts: false });
        const result = await installPhpExtensions(h.install, h.fx);
        expect(result.ok).toBe(false);
        expect(h.fx.inspect).toHaveBeenCalledWith(h.install.exe);
        expect(h.fx.stage).not.toHaveBeenCalled();
        expect(await readFile(join(h.dir, 'php.ini'), 'utf8')).toBe('; original\nextension=curl\n');
    });
    it('never enables a DLL that failed its isolated load test', async () => {
        const h = await harness();
        vi.mocked(h.fx.verify).mockResolvedValue(false);
        expect((await installPhpExtensions(h.install, h.fx)).ok).toBe(false);
        expect(h.fx.stage).toHaveBeenCalledTimes(1);
        expect(await readFile(join(h.dir, 'php.ini'), 'utf8')).toBe('; original\nextension=curl\n');
        await expect(readFile(join(h.dir, 'ext/php_redis.dll'))).rejects.toThrow();
    });
    it.each([false, true])('rolls back configuration and DLL after final verification fails (existing DLL=%s)', async (existing) => {
        const h = await harness();
        if (existing) await writeFile(join(h.dir, 'ext/php_redis.dll'), 'old DLL');
        vi.mocked(h.fx.verify).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect((await installPhpExtensions(h.install, h.fx)).ok).toBe(false);
        expect(h.fx.verify).toHaveBeenCalledTimes(3);
        expect(await readFile(join(h.dir, 'php.ini'), 'utf8')).toBe('; original\nextension=curl\n');
        if (existing) expect(await readFile(join(h.dir, 'ext/php_redis.dll'), 'utf8')).toBe('old DLL');
        else await expect(readFile(join(h.dir, 'ext/php_redis.dll'))).rejects.toThrow();
    });
    it('reports a download error without touching the existing installation', async () => {
        const h = await harness();
        vi.mocked(h.fx.stage).mockRejectedValue(new Error('checksum mismatch'));
        expect(await installPhpExtensions(h.install, h.fx)).toEqual({ ok: false, error: 'checksum mismatch' });
        expect(await readFile(join(h.dir, 'php.ini'), 'utf8')).toBe('; original\nextension=curl\n');
    });
    it('serializes concurrent requests for the same PHP installation', async () => {
        const h = await harness();
        const results = await Promise.all([installPhpExtensions(h.install, h.fx), installPhpExtensions(h.install, h.fx)]);
        expect(results).toEqual([{ ok: true, changed: true }, { ok: true, changed: true }]);
        expect(h.fx.stage).toHaveBeenCalledTimes(1);
    });
});

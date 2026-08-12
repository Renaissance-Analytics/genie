import { describe, expect, it, vi } from 'vitest';
import { resolveDownloadUrl } from '../toolchain-resolve';

/**
 * The direct-download adapters leave git/node/php on Windows with `url: null`
 * and a `source`, because those ship only VERSIONED assets with no fixed
 * "latest" file (see toolchain-adapters). This resolves the source to a concrete
 * URL from the vendor's own index — the parsing is pure given the fetched JSON,
 * so it is tested with a fake fetcher and never touches the network here. Never
 * throws: a resolve that fails is `null`, which the executor reports as a
 * per-tool failure rather than a crash.
 */

const winCtx = { os: 'win32' as const, arch: 'x64' as const };

describe('resolveDownloadUrl — git-for-windows', () => {
    const releasesJson = {
        assets: [
            { name: 'Git-2.45.0-32-bit.exe', browser_download_url: 'https://gh/Git-2.45.0-32-bit.exe' },
            { name: 'Git-2.45.0-64-bit.exe', browser_download_url: 'https://gh/Git-2.45.0-64-bit.exe' },
            { name: 'PortableGit-2.45.0-64-bit.7z.exe', browser_download_url: 'https://gh/portable.exe' },
        ],
    };

    it('picks the 64-bit installer on x64', async () => {
        const url = await resolveDownloadUrl('git-for-windows', winCtx, async () => releasesJson);
        expect(url).toBe('https://gh/Git-2.45.0-64-bit.exe');
    });

    it('picks the 32-bit installer when there is no 64-bit asset', async () => {
        const url = await resolveDownloadUrl(
            'git-for-windows',
            winCtx,
            async () => ({ assets: [releasesJson.assets[0]] }),
        );
        expect(url).toBe('https://gh/Git-2.45.0-32-bit.exe');
    });

    it('returns null when the release carries no usable installer', async () => {
        expect(await resolveDownloadUrl('git-for-windows', winCtx, async () => ({ assets: [] }))).toBeNull();
    });
});

describe('resolveDownloadUrl — nodejs-dist', () => {
    const index = [
        { version: 'v22.3.0', lts: false },
        { version: 'v20.15.0', lts: 'Iron' },
        { version: 'v20.14.0', lts: 'Iron' },
        { version: 'v18.20.0', lts: 'Hydrogen' },
    ];

    it('builds the latest-LTS Windows zip URL for x64', async () => {
        const url = await resolveDownloadUrl('nodejs-dist', winCtx, async () => index);
        expect(url).toBe('https://nodejs.org/dist/v20.15.0/node-v20.15.0-win-x64.zip');
    });

    it('builds an arm64 URL when the machine is arm64', async () => {
        const url = await resolveDownloadUrl(
            'nodejs-dist',
            { os: 'win32', arch: 'arm64' },
            async () => index,
        );
        expect(url).toBe('https://nodejs.org/dist/v20.15.0/node-v20.15.0-win-arm64.zip');
    });

    it('returns null when the index has no LTS release', async () => {
        const url = await resolveDownloadUrl(
            'nodejs-dist',
            winCtx,
            async () => [{ version: 'v22.3.0', lts: false }],
        );
        expect(url).toBeNull();
    });
});

describe('resolveDownloadUrl — resilience', () => {
    it('returns null (does not throw) when the fetch rejects', async () => {
        const url = await resolveDownloadUrl('nodejs-dist', winCtx, async () => {
            throw new Error('network down');
        });
        expect(url).toBeNull();
    });

    it('returns null for a source with no reliable index yet (php-windows)', async () => {
        // windows.php.net has no stable machine index; php on Windows is normally
        // provided by Herd (detected + reused), so this stays an explicit null
        // rather than a fabricated URL.
        const fetch = vi.fn();
        expect(await resolveDownloadUrl('php-windows', winCtx, fetch)).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });
});

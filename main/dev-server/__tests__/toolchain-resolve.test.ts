import { describe, expect, it, vi } from 'vitest';
import { resolveDownloadUrl, resolveFailureHelp } from '../toolchain-resolve';

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

/**
 * php on Windows (genie#209).
 *
 * This used to be a deliberate `null` — "no stable machine index, and php on
 * Windows is Herd's anyway". BOTH halves were wrong: windows.php.net publishes
 * `releases.json` (one entry per release LINE, each with its current patch and a
 * build per {ts|nts}-{toolset}-{arch}), and Genie no longer borrows Herd's php —
 * it installs and owns its own. So this resolves for real, and the two decisions
 * that matter are asserted here:
 *
 *   - **non-thread-safe, x64.** NTS is the FastCGI build, and `php-cgi.exe` is
 *     what Genie's php serve mode spawns — genie#206 was exactly its absence.
 *   - **never a line this release has no recipe for.** The patch comes live from
 *     the index (so a superseded file that moved to `archives/` can't 404 us),
 *     but the LINE is capped at what Genie ships support for.
 */
describe('resolveDownloadUrl — php-windows', () => {
    /** Shaped like the real releases.json, trimmed to the fields read here. */
    const releasesJson = {
        '8.2': {
            version: '8.2.33',
            'ts-vs16-x64': { zip: { path: 'php-8.2.33-Win32-vs16-x64.zip' } },
            'nts-vs16-x64': { zip: { path: 'php-8.2.33-nts-Win32-vs16-x64.zip' } },
        },
        '8.4': {
            version: '8.4.24',
            'ts-vs17-x64': { zip: { path: 'php-8.4.24-Win32-vs17-x64.zip' } },
            'nts-vs17-x86': { zip: { path: 'php-8.4.24-nts-Win32-vs17-x86.zip' } },
            'nts-vs17-x64': { zip: { path: 'php-8.4.24-nts-Win32-vs17-x64.zip' } },
        },
        // Newer than anything TOOLCHAIN_RECIPES ships a recipe for.
        '8.5': {
            version: '8.5.9',
            'nts-vs17-x64': { zip: { path: 'php-8.5.9-nts-Win32-vs17-x64.zip' } },
        },
    };

    it('resolves the NON-thread-safe x64 zip — php-cgi.exe is the FastCGI binary (#206)', async () => {
        const url = await resolveDownloadUrl('php-windows', winCtx, async () => releasesJson);
        // Not the `ts-` build, not the x86 one: the nts x64 archive, which
        // unpacks flat with php.exe AND php-cgi.exe at its root.
        expect(url).toBe('https://windows.php.net/downloads/releases/php-8.4.24-nts-Win32-vs17-x64.zip');
    });

    it('caps the LINE at the newest php this release has a recipe for, taking its patch live', async () => {
        // 8.5 is in the index and is NOT chosen: "each release includes what we
        // know we can support". Bump this expectation when TOOLCHAIN_RECIPES
        // gains a newer php line.
        const url = await resolveDownloadUrl('php-windows', winCtx, async () => releasesJson);
        expect(url).not.toContain('8.5');
        // …and the patch is whatever the index says today, never a pinned one.
        const moved = { ...releasesJson, '8.4': { ...releasesJson['8.4'], version: '8.4.25', 'nts-vs17-x64': { zip: { path: 'php-8.4.25-nts-Win32-vs17-x64.zip' } } } };
        expect(await resolveDownloadUrl('php-windows', winCtx, async () => moved)).toContain('8.4.25');
    });

    it('reads the toolset out of the index rather than hard-coding vs17', async () => {
        const future = {
            '8.4': { version: '8.4.24', 'nts-vs18-x64': { zip: { path: 'php-8.4.24-nts-Win32-vs18-x64.zip' } } },
        };
        const url = await resolveDownloadUrl('php-windows', winCtx, async () => future);
        expect(url).toBe('https://windows.php.net/downloads/releases/php-8.4.24-nts-Win32-vs18-x64.zip');
    });

    it('returns null on arm64 — windows.php.net publishes no arm64 build', async () => {
        const fetch = vi.fn();
        expect(await resolveDownloadUrl('php-windows', { os: 'win32', arch: 'arm64' }, fetch)).toBeNull();
        // Nothing to look for, so it does not even ask.
        expect(fetch).not.toHaveBeenCalled();
    });

    it('returns null when the supported line has no x64 nts build', async () => {
        const url = await resolveDownloadUrl('php-windows', winCtx, async () => ({
            '8.4': { version: '8.4.24', 'ts-vs17-x64': { zip: { path: 'php-8.4.24-Win32-vs17-x64.zip' } } },
        }));
        expect(url).toBeNull();
    });

    it('refuses an index entry whose path is not a plain zip filename', async () => {
        const url = await resolveDownloadUrl('php-windows', winCtx, async () => ({
            '8.4': { version: '8.4.24', 'nts-vs17-x64': { zip: { path: '../../etc/passwd' } } },
        }));
        expect(url).toBeNull();
    });

    it('returns null (does not throw) when the index is junk', async () => {
        expect(await resolveDownloadUrl('php-windows', winCtx, async () => 'not json')).toBeNull();
        expect(await resolveDownloadUrl('php-windows', winCtx, async () => null)).toBeNull();
    });
});

describe('resolveDownloadUrl — resilience', () => {
    it('returns null (does not throw) when the fetch rejects', async () => {
        const url = await resolveDownloadUrl('nodejs-dist', winCtx, async () => {
            throw new Error('network down');
        });
        expect(url).toBeNull();
    });
});

/**
 * A failed resolve must tell the user what to DO. "could not resolve a download
 * URL" names nothing actionable, which is how the owner's clean-machine run ended
 * with php simply failed and no next step.
 */
describe('resolveFailureHelp', () => {
    it('names the vendor index and a way forward, per source', () => {
        const php = resolveFailureHelp('php-windows', 'php');
        expect(php).toContain('windows.php.net');
        expect(php).toMatch(/install .*php|php .*yourself|manually/i);

        expect(resolveFailureHelp('nodejs-dist', 'node')).toContain('nodejs.org');
        expect(resolveFailureHelp('git-for-windows', 'git')).toContain('git-for-windows');
    });
});

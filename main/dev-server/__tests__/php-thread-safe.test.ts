import { describe, expect, it, vi } from 'vitest';
import {
    installEngineVersion,
    planVersionInstall,
    type VersionInstallEffects,
} from '../toolchain-version-install';
import {
    PHP_INI_EXTENSIONS,
    TOOLCHAIN_RECIPES,
    assetFor,
    installKey,
    parsePhpThreadSafety,
    phpThreadSafeDll,
    threadSafeReinstallKeys,
    type EngineInstall,
} from '../toolchain-versions';
import { scanToolchain, type ToolchainFs } from '../toolchain-scan';

/**
 * Genie's PHP on Windows is THREAD-SAFE (genie#669).
 *
 * The owner: "Genie's provided PHP absolutely better be threadsafe." FrankenPHP
 * loads PHP as a library and needs a ZTS build (`php8ts.dll`); the recipes used
 * to fetch the NTS zips, so none of Genie's PHP lines could back a FrankenPHP or
 * Octane + FrankenPHP site.
 *
 * Verified against the real vendor before this was written:
 *   - windows.php.net's releases.json carries `ts-vs16-x64` / `ts-vs17-x64` for
 *     8.2–8.5, and the archives hold `php-8.4.24-Win32-vs17-x64.zip`;
 *   - that zip ships php.exe, php-cgi.exe and php8ts.dll, and loads all of
 *     Genie's php.ini extensions with no warning; `php -i` reports
 *     "Thread Safety => enabled" and `php-cgi -v` prints "(ZTS Visual C++ 2022 x64)".
 */

const ROOT = 'C:\\g\\toolchain';
const WIN = { os: 'win32', arch: 'x64' };

describe('the Windows PHP recipes fetch the thread-safe builds', () => {
    const php = TOOLCHAIN_RECIPES.filter((r) => r.tool === 'php');

    it('covers every PHP line Genie ships', () => {
        // Positive control for the loop below: an empty list would pass it.
        expect(php.map((r) => r.version)).toEqual(['8.4.24', '8.3.33', '8.2.33']);
    });

    it.each(php.map((r) => [r.version, r.tag] as const))('%s is the ZTS zip, never the nts one', (version, tag) => {
        const recipe = php.find((r) => r.version === version)!;
        const asset = assetFor(recipe, WIN)!;
        const file = `php-${version}-Win32-${tag}-x64.zip`;
        expect(asset.urls).toEqual([
            `https://windows.php.net/downloads/releases/${file}`,
            `https://windows.php.net/downloads/releases/archives/${file}`,
        ]);
        expect(asset.urls.join(' ')).not.toContain('-nts-');
    });
});

describe('parsePhpThreadSafety — what `php --version` says about the build', () => {
    it('reads ZTS as thread-safe', () => {
        expect(
            parsePhpThreadSafety('PHP 8.4.24 (cli) (built: Jul 29 2026 06:00:56) (ZTS Visual C++ 2022 x64)\nCopyright (c) The PHP Group'),
        ).toBe(true);
    });

    it('reads NTS as not thread-safe', () => {
        expect(parsePhpThreadSafety('PHP 8.4.24 (cli) (built: Jul 29 2026 06:00:56) (NTS Visual C++ 2022 x64)')).toBe(false);
        // A posix build prints the bare token.
        expect(parsePhpThreadSafety('PHP 8.3.6 (cli) (built: Apr 15 2024 19:21:47) (NTS)')).toBe(false);
    });

    it('does not guess when the output names neither', () => {
        expect(parsePhpThreadSafety('')).toBeUndefined();
        expect(parsePhpThreadSafety('v24.19.0')).toBeUndefined();
    });
});

describe('phpThreadSafeDll — the library only a ZTS Windows build ships', () => {
    it('follows the major version', () => {
        expect(phpThreadSafeDll('8.4.24')).toBe('php8ts.dll');
        expect(phpThreadSafeDll('9.0.0')).toBe('php9ts.dll');
    });
});

function effects(over: Partial<VersionInstallEffects> = {}): VersionInstallEffects {
    return {
        download: vi.fn(async () => ({ ok: true as const, path: 'C:\\tmp\\a.zip' })),
        unpack: vi.fn(async () => ({ ok: true as const })),
        runInstaller: vi.fn(async () => ({ ok: true as const })),
        writeFile: vi.fn(async () => {}),
        verify: vi.fn(async () => ({ version: '8.4.24', threadSafe: true })),
        listModules: vi.fn(async () => ({ modules: [...PHP_INI_EXTENSIONS, 'Core', 'PDO'] })),
        removeDir: vi.fn(async () => {}),
        addToPath: vi.fn(async () => {}),
        ensurePrerequisite: vi.fn(async () => ({ ok: true })),
        moveAside: vi.fn(async () => ({ ok: true as const, previous: null })),
        restoreAside: vi.fn(async () => {}),
        discardAside: vi.fn(async () => {}),
        ...over,
    };
}

function phpPlan() {
    const plan = planVersionInstall('php', '8.4.24', WIN, ROOT);
    if (!plan.ok) throw new Error('expected a plan');
    return plan;
}

describe('an install proves the PHP it put there is thread-safe', () => {
    it('succeeds for a ZTS build', async () => {
        const e = effects();
        expect(await installEngineVersion(phpPlan(), e)).toMatchObject({ ok: true });
    });

    it('FAILS for an NTS build, and removes it', async () => {
        const e = effects({ verify: vi.fn(async () => ({ version: '8.4.24', threadSafe: false })) });
        const res = await installEngineVersion(phpPlan(), e);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/thread-safe/i);
        expect(e.removeDir).toHaveBeenCalledWith(`${ROOT}\\php\\8.4.24`);
        expect(e.addToPath).not.toHaveBeenCalled();
    });

    it('FAILS when the binary does not say which build it is', async () => {
        const e = effects({ verify: vi.fn(async () => ({ version: '8.4.24' })) });
        expect((await installEngineVersion(phpPlan(), e)).ok).toBe(false);
    });

    it('asks nothing of other languages', async () => {
        const plan = planVersionInstall('node', '24.19.0', WIN, ROOT);
        if (!plan.ok) throw new Error('expected a plan');
        const e = effects({ verify: vi.fn(async () => ({ version: '24.19.0' })) });
        expect((await installEngineVersion(plan, e)).ok).toBe(true);
    });
});

/**
 * Reinstalling OVER a version that is already there — how an NTS install becomes
 * a ZTS one.
 *
 * The directory may be serving sites while this runs. Deleting it first is what
 * a plain unpack did, and on Windows a running php-cgi.exe cannot be deleted, so
 * that leaves a half-deleted PHP that crashes the site on its next respawn.
 * Measured instead: the version DIRECTORY can be renamed while php-cgi.exe runs
 * from it, and the running process keeps serving. So the old one is moved aside,
 * the new one put in place, and the old one discarded only once the new one has
 * proven itself — or put back if it did not.
 */
describe('replacing an existing version is all-or-nothing', () => {
    const dir = `${ROOT}\\php\\8.4.24`;
    const aside = `${ROOT}\\.replaced\\php-8.4.24-1`;

    it('moves the old one aside AFTER the download and BEFORE the unpack', async () => {
        const order: string[] = [];
        const e = effects({
            download: vi.fn(async () => (order.push('download'), { ok: true as const, path: 'C:\\tmp\\a.zip' })),
            moveAside: vi.fn(async () => (order.push('moveAside'), { ok: true as const, previous: aside })),
            unpack: vi.fn(async () => (order.push('unpack'), { ok: true as const })),
        });
        expect((await installEngineVersion(phpPlan(), e)).ok).toBe(true);
        expect(order).toEqual(['download', 'moveAside', 'unpack']);
        expect(e.moveAside).toHaveBeenCalledWith(dir);
        expect(e.discardAside).toHaveBeenCalledWith(aside);
        expect(e.restoreAside).not.toHaveBeenCalled();
    });

    it('a failed DOWNLOAD leaves the existing install untouched', async () => {
        const e = effects({ download: vi.fn(async () => ({ ok: false as const, error: 'offline' })) });
        const res = await installEngineVersion(phpPlan(), e);
        expect(res.ok).toBe(false);
        expect(e.moveAside).not.toHaveBeenCalled();
        // The bug this guards: every failure used to delete the version directory,
        // which on a reinstall is the WORKING install.
        expect(e.removeDir).not.toHaveBeenCalled();
    });

    it('a new build that fails to verify is removed and the old one PUT BACK', async () => {
        const e = effects({
            moveAside: vi.fn(async () => ({ ok: true as const, previous: aside })),
            verify: vi.fn(async () => ({ version: '8.4.24', threadSafe: false })),
        });
        const res = await installEngineVersion(phpPlan(), e);
        expect(res.ok).toBe(false);
        expect(e.removeDir).toHaveBeenCalledWith(dir);
        expect(e.restoreAside).toHaveBeenCalledWith(aside, dir);
        expect(e.discardAside).not.toHaveBeenCalled();
    });

    it('refuses without touching anything when the old one cannot be moved aside', async () => {
        const e = effects({ moveAside: vi.fn(async () => ({ ok: false as const, error: 'EPERM' })) });
        const res = await installEngineVersion(phpPlan(), e);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('EPERM');
        expect(e.unpack).not.toHaveBeenCalled();
        expect(e.removeDir).not.toHaveBeenCalled();
    });

    it('a fresh install has nothing to move aside, restore or discard', async () => {
        const e = effects();
        expect((await installEngineVersion(phpPlan(), e)).ok).toBe(true);
        expect(e.restoreAside).not.toHaveBeenCalled();
        expect(e.discardAside).not.toHaveBeenCalled();
    });
});

function fakeFs(tree: Record<string, string[] | null>): ToolchainFs {
    return {
        async listDir(d) {
            const v = tree[d];
            return Array.isArray(v) ? v : [];
        },
        async isFile(p) {
            return tree[p] === null;
        },
        async dirSize() {
            return 0;
        },
    };
}

describe('the scan says whether a Genie PHP is thread-safe', () => {
    async function scan(files: string[]) {
        const v = `${ROOT}\\php\\8.4.24`;
        const tree: Record<string, string[] | null> = {
            [ROOT]: ['php', 'node', '.replaced'],
            [`${ROOT}\\php`]: ['8.4.24'],
            [v]: files,
            [`${ROOT}\\node`]: ['24.19.0'],
            [`${ROOT}\\node\\24.19.0`]: ['node.exe'],
            [`${ROOT}\\node\\24.19.0\\node.exe`]: null,
            // A moved-aside copy is not an install.
            [`${ROOT}\\.replaced`]: ['php-8.4.24-1'],
        };
        for (const f of files) tree[`${v}\\${f}`] = null;
        return scanToolchain({
            fs: fakeFs(tree),
            platform: 'win32',
            root: ROOT,
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: async () => undefined,
            resolveOnPath: async () => undefined,
        });
    }

    it('marks a ZTS build thread-safe', async () => {
        const found = await scan(['php.exe', 'php-cgi.exe', 'php8ts.dll']);
        expect(found.find((i) => i.tool === 'php')).toMatchObject({ version: '8.4.24', threadSafe: true });
    });

    it('marks an NTS build NOT thread-safe', async () => {
        const found = await scan(['php.exe', 'php-cgi.exe', 'php8.dll']);
        expect(found.find((i) => i.tool === 'php')).toMatchObject({ version: '8.4.24', threadSafe: false });
    });

    it('says nothing about thread safety for another language, and lists no moved-aside copy', async () => {
        const found = await scan(['php.exe', 'php-cgi.exe', 'php8ts.dll']);
        expect(found.map((i) => `${i.tool} ${i.version}`).sort()).toEqual(['node 24.19.0', 'php 8.4.24']);
        expect(found.find((i) => i.tool === 'node')?.threadSafe).toBeUndefined();
    });
});

describe('threadSafeReinstallKeys — which installs the Toolchain page offers to reinstall thread-safe', () => {
    const install = (over: Partial<EngineInstall>): EngineInstall => ({
        tool: 'php',
        version: '8.4.24',
        dir: `${ROOT}\\php\\8.4.24`,
        exe: `${ROOT}\\php\\8.4.24\\php.exe`,
        source: 'genie',
        removable: true,
        threadSafe: false,
        ...over,
    });

    it('offers a Genie PHP that is not thread-safe and has a recipe', () => {
        const nts = install({});
        expect(threadSafeReinstallKeys([nts], WIN, ROOT)).toEqual([installKey(nts)]);
    });

    it('offers nothing that is already thread-safe, or that says nothing either way', () => {
        expect(threadSafeReinstallKeys([install({ threadSafe: true })], WIN, ROOT)).toEqual([]);
        expect(threadSafeReinstallKeys([install({ threadSafe: undefined })], WIN, ROOT)).toEqual([]);
    });

    it('offers nothing Genie has no recipe for, nothing foreign, and no legacy flat install', () => {
        expect(threadSafeReinstallKeys([install({ version: '8.1.2', dir: `${ROOT}\\php\\8.1.2` })], WIN, ROOT)).toEqual([]);
        expect(threadSafeReinstallKeys([install({ source: 'herd', removable: false, dir: 'C:\\herd\\php84' })], WIN, ROOT)).toEqual([]);
        // `<userData>/tools/php` — a reinstall would land in a DIFFERENT directory
        // and leave this one serving as it is, so it is not offered as one.
        expect(threadSafeReinstallKeys([install({ dir: 'C:\\g\\tools\\php' })], WIN, ROOT)).toEqual([]);
    });
});

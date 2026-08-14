import { describe, expect, it } from 'vitest';
import {
    classifyPathHit,
    foreignRoots,
    parseHerdPhpDir,
    parseNvmNodeDir,
    scanToolchain,
    type ToolchainFs,
} from '../toolchain-scan';

/**
 * Discovery. Genie's OWN installs under `<userData>/toolchain`, plus the ones
 * other installers put on the machine (Herd, XAMPP, nvm, a system package) —
 * the second kind for AWARENESS only.
 *
 * The test that matters most is the negative one: a directory whose only `php`
 * is a `.bat` SHIM is NOT an install. That is genie#206 written as an
 * assertion — PATH had `php.bat`, the real `php-cgi.exe` was a level down in
 * `bin/php84`, and Genie's FastCGI worker died on a lookup that "succeeded".
 */

/** An in-memory filesystem. Keys are paths; a value of `null` is a directory. */
function fakeFs(tree: Record<string, string[] | null>): ToolchainFs & { sizes: Record<string, number> } {
    const sizes: Record<string, number> = {};
    return {
        sizes,
        async listDir(dir) {
            const v = tree[dir];
            return Array.isArray(v) ? v : [];
        },
        async isFile(p) {
            return tree[p] === null;
        },
        async dirSize(dir) {
            return sizes[dir] ?? 0;
        },
    };
}

const NO_PROBE = async () => undefined;

describe('parsing a foreign version out of a directory name', () => {
    it('reads Herd\u2019s phpNN layout', () => {
        expect(parseHerdPhpDir('php84')).toBe('8.4');
        expect(parseHerdPhpDir('php83')).toBe('8.3');
        expect(parseHerdPhpDir('php810')).toBe('8.10');
    });
    it('rejects anything that is not a phpNN directory', () => {
        expect(parseHerdPhpDir('php')).toBeUndefined();
        expect(parseHerdPhpDir('php.bat')).toBeUndefined();
        expect(parseHerdPhpDir('bin')).toBeUndefined();
        expect(parseHerdPhpDir('php8')).toBeUndefined();
    });
    it('reads nvm\u2019s node version directories, with or without the v', () => {
        expect(parseNvmNodeDir('v24.19.0')).toBe('24.19.0');
        expect(parseNvmNodeDir('22.23.2')).toBe('22.23.2');
        expect(parseNvmNodeDir('lts')).toBeUndefined();
    });
});

describe('a PATH hit is not automatically an install', () => {
    it('calls a Windows .bat/.cmd a SHIM, not a real executable', () => {
        // The genie#206 shape, exactly.
        expect(classifyPathHit('C:\\Users\\x\\.config\\herd\\bin\\php.bat', 'win32')).toBe('shim');
        expect(classifyPathHit('C:\\Program Files\\nodejs\\npm.cmd', 'win32')).toBe('shim');
        expect(classifyPathHit('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe('real');
        expect(classifyPathHit('/usr/bin/php', 'linux')).toBe('real');
    });
});

describe('where Genie looks for other installers\u2019 toolchains', () => {
    it('knows Herd, XAMPP and nvm on Windows', () => {
        const roots = foreignRoots('win32', 'C:\\Users\\x', {});
        const seen = roots.map((r) => `${r.source}:${r.tool}`);
        expect(seen).toContain('herd:php');
        expect(seen).toContain('xampp:php');
        expect(seen).toContain('nvm:node');
        const herd = roots.find((r) => r.source === 'herd')!;
        expect(herd.dir).toBe('C:\\Users\\x\\.config\\herd\\bin');
    });

    it('honours NVM_HOME / XAMPP_HOME rather than assuming a default location', () => {
        const roots = foreignRoots('win32', 'C:\\Users\\x', {
            NVM_HOME: 'D:\\nvm',
            XAMPP_HOME: 'D:\\xampp',
        });
        expect(roots.find((r) => r.source === 'nvm')!.dir).toBe('D:\\nvm');
        expect(roots.find((r) => r.source === 'xampp')!.dir).toBe('D:\\xampp\\php');
    });

    it('looks in the posix places on posix', () => {
        const roots = foreignRoots('linux', '/home/x', {});
        expect(roots.find((r) => r.source === 'nvm')!.dir).toBe('/home/x/.nvm/versions/node');
        expect(roots.find((r) => r.source === 'herd')!.dir).toBe('/home/x/.config/herd/bin');
    });
});

describe('scanning Genie\u2019s own toolchain', () => {
    const root = 'C:\\g\\toolchain';

    it('refuses a php version directory with no php-cgi beside php (genie#206)', async () => {
        const fs = fakeFs({
            [root]: ['php'],
            [`${root}\\php`]: ['8.3.33'],
            [`${root}\\php\\8.3.33`]: ['php.exe'],
            [`${root}\\php\\8.3.33\\php.exe`]: null,
            // php-cgi.exe deliberately absent — this install cannot serve a site.
        });
        const found = await scanToolchain({
            fs,
            platform: 'win32',
            root,
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: NO_PROBE,
            resolveOnPath: async () => undefined,
        });
        expect(found).toEqual([]);
    });

    it('accepts a complete php install and marks it Genie-owned + removable', async () => {
        const fs = fakeFs({
            [root]: ['php'],
            [`${root}\\php`]: ['8.3.33'],
            [`${root}\\php\\8.3.33`]: ['php.exe', 'php-cgi.exe', 'php.ini'],
            [`${root}\\php\\8.3.33\\php.exe`]: null,
            [`${root}\\php\\8.3.33\\php-cgi.exe`]: null,
        });
        fs.sizes[`${root}\\php\\8.3.33`] = 90_000_000;
        const [found, ...rest] = await scanToolchain({
            fs,
            platform: 'win32',
            root,
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: NO_PROBE,
            resolveOnPath: async () => undefined,
        });
        expect(rest).toEqual([]);
        expect(found).toMatchObject({
            tool: 'php',
            version: '8.3.33',
            source: 'genie',
            removable: true,
            dir: `${root}\\php\\8.3.33`,
            exe: `${root}\\php\\8.3.33\\php.exe`,
            sizeBytes: 90_000_000,
        });
    });

    it('finds a posix install whose executables live in bin/', async () => {
        const r = '/home/x/.genie/toolchain';
        const fs = fakeFs({
            [r]: ['node'],
            [`${r}/node`]: ['24.19.0'],
            [`${r}/node/24.19.0`]: ['bin', 'lib'],
            [`${r}/node/24.19.0/bin`]: ['node', 'npm'],
            [`${r}/node/24.19.0/bin/node`]: null,
        });
        const [found] = await scanToolchain({
            fs,
            platform: 'linux',
            root: r,
            home: '/home/x',
            env: {},
            probeVersion: NO_PROBE,
            resolveOnPath: async () => undefined,
        });
        expect(found).toMatchObject({
            tool: 'node',
            version: '24.19.0',
            dir: `${r}/node/24.19.0`,
            exe: `${r}/node/24.19.0/bin/node`,
            source: 'genie',
        });
    });

    it('ignores a directory that is not one of the five languages', async () => {
        const fs = fakeFs({
            [root]: ['perl'],
            [`${root}\\perl`]: ['5.38.0'],
            [`${root}\\perl\\5.38.0`]: ['perl.exe'],
            [`${root}\\perl\\5.38.0\\perl.exe`]: null,
        });
        expect(
            await scanToolchain({
                fs,
                platform: 'win32',
                root,
                home: 'C:\\Users\\x',
                env: {},
                probeVersion: NO_PROBE,
                resolveOnPath: async () => undefined,
            }),
        ).toEqual([]);
    });
});

describe('scanning what OTHER installers left on the machine', () => {
    it('finds Herd\u2019s per-version php dirs and never the bin/ shim above them', async () => {
        const herd = 'C:\\Users\\x\\.config\\herd\\bin';
        const fs = fakeFs({
            'C:\\g\\toolchain': [],
            // The exact genie#206 layout: a `php.bat` shim at the top, the REAL
            // binaries one level down per version.
            [herd]: ['php.bat', 'php84', 'php83'],
            [`${herd}\\php.bat`]: null,
            [`${herd}\\php84`]: ['php.exe', 'php-cgi.exe'],
            [`${herd}\\php84\\php.exe`]: null,
            [`${herd}\\php84\\php-cgi.exe`]: null,
            [`${herd}\\php83`]: ['php.exe', 'php-cgi.exe'],
            [`${herd}\\php83\\php.exe`]: null,
            [`${herd}\\php83\\php-cgi.exe`]: null,
        });
        const found = await scanToolchain({
            fs,
            platform: 'win32',
            root: 'C:\\g\\toolchain',
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: NO_PROBE,
            resolveOnPath: async () => undefined,
        });
        expect(found.map((f) => `${f.source}:${f.version}`)).toEqual(['herd:8.4', 'herd:8.3']);
        // Awareness only: never selectable, never deletable by Genie.
        for (const f of found) {
            expect(f.removable).toBe(false);
            expect(f.dir).not.toBe(herd);
        }
    });

    it('finds nvm node versions', async () => {
        const nvm = 'C:\\Users\\x\\AppData\\Roaming\\nvm';
        const fs = fakeFs({
            'C:\\g\\toolchain': [],
            [nvm]: ['v24.19.0', 'settings.txt'],
            [`${nvm}\\v24.19.0`]: ['node.exe', 'npm.cmd'],
            [`${nvm}\\v24.19.0\\node.exe`]: null,
        });
        const found = await scanToolchain({
            fs,
            platform: 'win32',
            root: 'C:\\g\\toolchain',
            home: 'C:\\Users\\x',
            env: { NVM_HOME: nvm },
            probeVersion: NO_PROBE,
            resolveOnPath: async () => undefined,
        });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ tool: 'node', version: '24.19.0', source: 'nvm' });
    });

    it('asks the binary for its version when the directory name does not carry one', async () => {
        // XAMPP's php lives in a bare `php` directory — the name says nothing.
        const fs = fakeFs({
            'C:\\g\\toolchain': [],
            'C:\\xampp\\php': ['php.exe', 'php-cgi.exe'],
            'C:\\xampp\\php\\php.exe': null,
            'C:\\xampp\\php\\php-cgi.exe': null,
        });
        const found = await scanToolchain({
            fs,
            platform: 'win32',
            root: 'C:\\g\\toolchain',
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: async (_tool, exe) =>
                exe === 'C:\\xampp\\php\\php.exe' ? '8.1.25' : undefined,
            resolveOnPath: async () => undefined,
        });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ tool: 'php', version: '8.1.25', source: 'xampp' });
    });

    it('drops an install whose version nothing can name — never a row that says "unknown"', async () => {
        const fs = fakeFs({
            'C:\\g\\toolchain': [],
            'C:\\xampp\\php': ['php.exe', 'php-cgi.exe'],
            'C:\\xampp\\php\\php.exe': null,
            'C:\\xampp\\php\\php-cgi.exe': null,
        });
        expect(
            await scanToolchain({
                fs,
                platform: 'win32',
                root: 'C:\\g\\toolchain',
                home: 'C:\\Users\\x',
                env: {},
                probeVersion: NO_PROBE,
                resolveOnPath: async () => undefined,
            }),
        ).toEqual([]);
    });

    it('finds a SYSTEM install through PATH, but only when PATH points at a real binary', async () => {
        const fs = fakeFs({
            'C:\\g\\toolchain': [],
            'C:\\Program Files\\nodejs': ['node.exe'],
            'C:\\Program Files\\nodejs\\node.exe': null,
            'C:\\Users\\x\\.config\\herd\\bin': ['php.bat'],
            'C:\\Users\\x\\.config\\herd\\bin\\php.bat': null,
        });
        const found = await scanToolchain({
            fs,
            platform: 'win32',
            root: 'C:\\g\\toolchain',
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: async () => '24.19.0',
            resolveOnPath: async (bin) =>
                bin === 'node'
                    ? 'C:\\Program Files\\nodejs\\node.exe'
                    : // php resolves to Herd's SHIM — a PATH hit that is not an install.
                      bin === 'php'
                      ? 'C:\\Users\\x\\.config\\herd\\bin\\php.bat'
                      : undefined,
        });
        expect(found.map((f) => `${f.tool}:${f.source}`)).toEqual(['node:system']);
    });

    it('does not list a system install Genie already owns the same directory for', async () => {
        const root = 'C:\\g\\toolchain';
        const fs = fakeFs({
            [root]: ['node'],
            [`${root}\\node`]: ['24.19.0'],
            [`${root}\\node\\24.19.0`]: ['node.exe'],
            [`${root}\\node\\24.19.0\\node.exe`]: null,
        });
        const found = await scanToolchain({
            fs,
            platform: 'win32',
            root,
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: async () => '24.19.0',
            // PATH resolves to the very binary Genie installed (Genie puts its
            // default on PATH) — one install, not two rows.
            resolveOnPath: async (bin) =>
                bin === 'node' ? `${root}\\node\\24.19.0\\node.exe` : undefined,
        });
        expect(found).toHaveLength(1);
        expect(found[0]!.source).toBe('genie');
    });

    it('puts Genie\u2019s own installs first, newest first', async () => {
        const root = 'C:\\g\\toolchain';
        const herd = 'C:\\Users\\x\\.config\\herd\\bin';
        const fs = fakeFs({
            [root]: ['php'],
            [`${root}\\php`]: ['8.2.33', '8.3.33'],
            [`${root}\\php\\8.2.33`]: ['php.exe', 'php-cgi.exe'],
            [`${root}\\php\\8.2.33\\php.exe`]: null,
            [`${root}\\php\\8.2.33\\php-cgi.exe`]: null,
            [`${root}\\php\\8.3.33`]: ['php.exe', 'php-cgi.exe'],
            [`${root}\\php\\8.3.33\\php.exe`]: null,
            [`${root}\\php\\8.3.33\\php-cgi.exe`]: null,
            [herd]: ['php84'],
            [`${herd}\\php84`]: ['php.exe', 'php-cgi.exe'],
            [`${herd}\\php84\\php.exe`]: null,
            [`${herd}\\php84\\php-cgi.exe`]: null,
        });
        const found = await scanToolchain({
            fs,
            platform: 'win32',
            root,
            home: 'C:\\Users\\x',
            env: {},
            probeVersion: NO_PROBE,
            resolveOnPath: async () => undefined,
        });
        expect(found.map((f) => `${f.source}:${f.version}`)).toEqual([
            'genie:8.3.33',
            'genie:8.2.33',
            'herd:8.4',
        ]);
    });
});

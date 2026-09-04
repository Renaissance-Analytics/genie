import { describe, expect, it } from 'vitest';
import {
    LANGUAGE_TOOLS,
    PHP_INI_EXTENSIONS,
    TOOLCHAIN_RECIPES,
    addableRecipes,
    compareVersionsDesc,
    defaultVersionFor,
    engineCompanionExes,
    engineExeName,
    genieToolchainRoot,
    genieVersionDir,
    installKey,
    parseToolchainDefaults,
    phpIniContents,
    recipesFor,
    selectableInstalls,
    serializeToolchainDefaults,
    sortInstalls,
    versionLine,
    type EngineInstall,
    type LanguageTool,
} from '../toolchain-versions';

/**
 * The multi-version toolchain MODEL (the Toolchain page). Everything a version
 * decision depends on is here and pure: what an install IS, where Genie keeps
 * its own, which of them a site may use, which version is the machine default,
 * and what "Add a version" is even allowed to offer.
 *
 * The rule the whole file exists to defend: **an install is a DIRECTORY holding
 * real executables, never a PATH entry** (genie#206 — PATH had `php.bat`, the
 * real `php-cgi.exe` was a level down in `bin/php84`, and the FastCGI worker
 * died). Everything below treats a version as a directory + the exe inside it.
 */

const install = (p: Partial<EngineInstall> & Pick<EngineInstall, 'tool' | 'version'>): EngineInstall => ({
    dir: `C:\\g\\toolchain\\${p.tool}\\${p.version}`,
    exe: `C:\\g\\toolchain\\${p.tool}\\${p.version}\\${p.tool}.exe`,
    source: 'genie',
    removable: true,
    ...p,
});

describe('the five languages', () => {
    it('covers php, node, python, go and rust — one model, no exceptions', () => {
        expect([...LANGUAGE_TOOLS]).toEqual(['php', 'node', 'python', 'go', 'rust']);
    });
});

describe('an install is a directory + a real executable', () => {
    it('names the platform executable, not the tool', () => {
        expect(engineExeName('php', 'win32')).toBe('php.exe');
        expect(engineExeName('php', 'darwin')).toBe('php');
        expect(engineExeName('node', 'win32')).toBe('node.exe');
        expect(engineExeName('rust', 'linux')).toBe('rustc');
    });

    it('requires php-cgi beside php — the binary the FastCGI worker actually spawns', () => {
        // genie#206: a php directory without php-cgi cannot serve a site, so the
        // model must know php needs TWO executables, not one.
        expect(engineCompanionExes('php', 'win32')).toContain('php-cgi.exe');
        expect(engineCompanionExes('php', 'linux')).toContain('php-cgi');
        expect(engineCompanionExes('node', 'win32')).toEqual([]);
    });

    it('lays Genie-owned versions out one directory per version', () => {
        const root = genieToolchainRoot('C:\\Users\\x\\AppData\\Roaming\\Genie', 'win32');
        expect(root).toBe('C:\\Users\\x\\AppData\\Roaming\\Genie\\toolchain');
        expect(genieVersionDir(root, 'php', '8.3.14', 'win32')).toBe(
            'C:\\Users\\x\\AppData\\Roaming\\Genie\\toolchain\\php\\8.3.14',
        );
        expect(genieVersionDir('/home/x/.genie/toolchain', 'node', '24.10.0', 'linux')).toBe(
            '/home/x/.genie/toolchain/node/24.10.0',
        );
    });

    it('keys an install by tool+version+dir, so two sources of one version never collide', () => {
        const herd = install({ tool: 'php', version: '8.4.1', source: 'herd', dir: 'C:\\herd\\php84', removable: false });
        const genie = install({ tool: 'php', version: '8.4.1' });
        expect(installKey(herd)).not.toBe(installKey(genie));
    });
});

describe('version ordering + lines', () => {
    it('sorts newest first, numerically (10 after 9, not before it)', () => {
        expect(['8.2.1', '8.10.0', '8.9.2'].sort(compareVersionsDesc)).toEqual([
            '8.10.0',
            '8.9.2',
            '8.2.1',
        ]);
    });

    it('reads a version LINE per tool — php is major.minor, node is major', () => {
        expect(versionLine('php', '8.3.14')).toBe('8.3');
        expect(versionLine('node', '24.10.0')).toBe('24');
        expect(versionLine('go', '1.25.1')).toBe('1.25');
    });

    it('orders installs Genie-owned first, then newest, so the usable ones lead', () => {
        const rows = sortInstalls([
            install({ tool: 'php', version: '8.4.1', source: 'herd', dir: 'C:\\herd\\php84', removable: false }),
            install({ tool: 'php', version: '8.2.9' }),
            install({ tool: 'php', version: '8.3.14' }),
        ]);
        expect(rows.map((r) => `${r.source}:${r.version}`)).toEqual([
            'genie:8.3.14',
            'genie:8.2.9',
            'herd:8.4.1',
        ]);
    });
});

describe('only Genie-owned installs are selectable', () => {
    it('drops every foreign install — a site can never pin Herd\u2019s php', () => {
        const installs = [
            install({ tool: 'php', version: '8.4.1', source: 'herd', dir: 'C:\\herd\\php84', removable: false }),
            install({ tool: 'php', version: '8.3.14' }),
            install({ tool: 'php', version: '8.1.0', source: 'xampp', dir: 'C:\\xampp\\php', removable: false }),
        ];
        expect(selectableInstalls(installs).map((i) => i.version)).toEqual(['8.3.14']);
    });

    it('never marks a foreign install removable — Genie does not delete other apps', () => {
        const foreign = install({
            tool: 'php',
            version: '8.4.1',
            source: 'herd',
            dir: 'C:\\herd\\php84',
            removable: false,
        });
        expect(foreign.removable).toBe(false);
        expect(selectableInstalls([foreign])).toEqual([]);
    });
});

describe('the machine default', () => {
    const installs = [
        install({ tool: 'php', version: '8.3.14' }),
        install({ tool: 'php', version: '8.2.9' }),
        install({ tool: 'php', version: '8.4.1', source: 'herd', dir: 'C:\\herd\\php84', removable: false }),
    ];

    it('honours an explicit default', () => {
        expect(defaultVersionFor('php', installs, { php: '8.2.9' })).toBe('8.2.9');
    });

    it('falls back to the newest GENIE install when none is set', () => {
        // NOT Herd's 8.4.1, even though it is newer — an unmanaged install is
        // never the default, or a site would silently run on someone else's php.
        expect(defaultVersionFor('php', installs, {})).toBe('8.3.14');
    });

    it('drops a stale default that is no longer installed', () => {
        expect(defaultVersionFor('php', installs, { php: '8.0.30' })).toBe('8.3.14');
    });

    it('refuses a default that points at a foreign install', () => {
        expect(defaultVersionFor('php', installs, { php: '8.4.1' })).toBe('8.3.14');
    });

    it('is undefined when Genie owns nothing for that language', () => {
        expect(defaultVersionFor('rust', installs, {})).toBeUndefined();
    });

    it('round-trips through settings storage and ignores junk', () => {
        const d: Partial<Record<LanguageTool, string>> = { php: '8.3.14', node: '24.10.0' };
        expect(parseToolchainDefaults(serializeToolchainDefaults(d))).toEqual(d);
        expect(parseToolchainDefaults(undefined)).toEqual({});
        expect(parseToolchainDefaults('not json')).toEqual({});
        // A key that is not one of the five languages, or a non-string version,
        // must not reach the resolver as a pretend default.
        expect(parseToolchainDefaults('{"php":"8.3.14","perl":"5","node":7}')).toEqual({
            php: '8.3.14',
        });
    });
});

describe('"Add a version" offers only what Genie has a RECIPE for', () => {
    it('has no recipe whose version is empty or whose tool is unknown', () => {
        for (const r of TOOLCHAIN_RECIPES) {
            expect(LANGUAGE_TOOLS).toContain(r.tool);
            expect(r.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
            expect(r.platforms.length).toBeGreaterThan(0);
        }
    });

    it('offers node on every desktop platform', () => {
        for (const os of ['win32', 'darwin', 'linux']) {
            expect(recipesFor('node', { os }).length).toBeGreaterThan(0);
        }
    });

    it('offers php only where Genie can actually fetch a build', () => {
        // Windows has official binary builds; the other platforms do not ship a
        // relocatable one, so the honest answer is an EMPTY pick-list, not a
        // recipe that fails at download time.
        expect(recipesFor('php', { os: 'win32' }).length).toBeGreaterThan(0);
        expect(recipesFor('php', { os: 'darwin' })).toEqual([]);
    });

    it('hides a version Genie already installed — Add offers what you do not have', () => {
        const ctx = { os: 'win32' };
        const all = recipesFor('node', ctx);
        expect(all.length).toBeGreaterThan(1);
        const have = [install({ tool: 'node', version: all[0]!.version })];
        const addable = addableRecipes('node', ctx, have);
        expect(addable.map((r) => r.version)).not.toContain(all[0]!.version);
        expect(addable.length).toBe(all.length - 1);
    });

    it('still offers a version a FOREIGN installer happens to have', () => {
        // Genie owns its toolchain: Herd having php 8.4 is not a reason to
        // refuse installing Genie's own 8.4.
        const ctx = { os: 'win32' };
        const php = recipesFor('php', ctx);
        const foreign = install({
            tool: 'php',
            version: php[0]!.version,
            source: 'herd',
            dir: 'C:\\herd\\php84',
            removable: false,
        });
        expect(addableRecipes('php', ctx, [foreign]).map((r) => r.version)).toContain(
            php[0]!.version,
        );
    });
});

describe('php.ini — Genie owns the CONFIG, not just the binaries', () => {
    /**
     * The windows.php.net zip ships every extension as a DLL in `ext\` and NO
     * active php.ini at all — `php.ini-production` has every `extension=` line
     * commented out (verified: zero uncommented ones). So without this file a
     * "successful" PHP install cannot run Laravel or even `composer install`,
     * which needs openssl, mbstring and zip. Enabled-by-Genie is the whole point.
     */
    it('enables the extensions a Laravel app needs, not a bare cli set', () => {
        for (const ext of [
            'openssl',
            'mbstring',
            'curl',
            'fileinfo',
            'zip',
            'pdo_sqlite',
            'sqlite3',
            'pdo_mysql',
            'pdo_pgsql',
            'gd',
            'intl',
            'exif',
            'sodium',
        ]) {
            expect(PHP_INI_EXTENSIONS).toContain(ext);
        }
    });

    it('lists only extensions that are real DLLs in the build, never ones compiled in', () => {
        // Every name here was loaded for real from php-8.4.24-nts-Win32-vs17-x64
        // with `php -m` and produced no "Unable to load dynamic library" warning.
        // The built-ins (ctype, dom, filter, hash, pcre, session, tokenizer, xml,
        // json, bcmath) are absent on purpose — an extension= line for one of them
        // is a warning on every single php invocation, in every site log.
        for (const builtIn of ['ctype', 'dom', 'filter', 'hash', 'pcre', 'session', 'tokenizer', 'xml', 'json', 'bcmath']) {
            expect(PHP_INI_EXTENSIONS).not.toContain(builtIn);
        }
    });

    it('points extension_dir at THIS version\u2019s ext folder and enables each one', () => {
        const ini = phpIniContents('C:\\g\\toolchain\\php\\8.3.14', 'win32');
        expect(ini).toContain('extension_dir = "C:\\g\\toolchain\\php\\8.3.14\\ext"');
        for (const ext of PHP_INI_EXTENSIONS) {
            expect(ini).toContain(`extension=${ext}`);
        }
        // Every extension line must be live, never a commented sample.
        expect(ini).not.toMatch(/^;extension=/m);
    });

    it('uses the posix extension dir on posix', () => {
        expect(phpIniContents('/home/x/.genie/toolchain/php/8.3.14', 'linux')).toContain(
            'extension_dir = "/home/x/.genie/toolchain/php/8.3.14/ext"',
        );
    });

    /**
     * Two lines in this file were reproduced as real failures against the actual
     * php-8.4.24-nts-Win32-vs17-x64 build (genie#209 follow-up):
     *
     *   - `zend_extension=opcache` + `opcache.enable=1` makes **php-cgi.exe die at
     *     startup** — "Fatal Error Opcode handlers are unusable due to ASLR",
     *     exit 127 — and php-cgi is the binary Genie's PHP serve mode spawns. With
     *     `opcache.enable_cli=0` alongside it, opcache was enabled for EXACTLY the
     *     one SAPI it kills and disabled for the one where it is harmless.
     *   - `extension=bcmath` cannot load: bcmath is COMPILED IN on Windows, there
     *     is no `php_bcmath.dll`, so the line only buys a startup warning on every
     *     request.
     */
    it('does not enable opcache — it kills the php-cgi worker on Windows', () => {
        const ini = phpIniContents('C:\\g\\toolchain\\php\\8.4.24', 'win32');
        expect(ini).not.toMatch(/^\s*zend_extension\s*=\s*opcache/m);
        expect(ini).not.toMatch(/^\s*opcache\.enable\s*=\s*1/m);
    });

    it('does not list an extension that is built into the Windows build (bcmath)', () => {
        expect(PHP_INI_EXTENSIONS).not.toContain('bcmath');
        expect(phpIniContents('C:\\g\\toolchain\\php\\8.4.24', 'win32')).not.toContain(
            'extension=bcmath',
        );
    });
});

/**
 * The owner's requirement: Genie's PHP is a batteries-included dev runtime, not
 * a hand-picked subset. A missing extension surfaces as a cryptic failure deep
 * inside a request — `Class "Redis" not found` had `tynn.gen` returning 500 on
 * every request for a WEEK before anyone looked.
 *
 * The list is still not `ext/*.dll` blindly, because a failing `extension=`
 * line prints a warning on EVERY php invocation, into every site log, forever.
 * Each name below was verified against php-8.4.24-nts-Win32-vs17-x64 by loading
 * the whole set at once and asserting php printed NOTHING but its own output.
 *
 * The four exclusions are deliberate and each has a reason:
 *   - `opcache`      — `zend_extension=opcache` makes php-cgi.exe DIE at startup
 *                      on Windows (ASLR fatal, exit 127), and php-cgi is what the
 *                      PHP serve mode spawns. Already documented in phpIniContents.
 *   - `pdo_firebird` — needs a Firebird client library the zip does not carry;
 *                      emits "Unable to load dynamic library" (measured).
 *   - `snmp`         — loads, but prints "Cannot find module (IP-MIB)" and six
 *                      more on every invocation: the MIBs are not shipped.
 *   - `dl_test`, `zend_test` — PHP's own internal test extensions.
 */
describe('PHP_INI_EXTENSIONS — everything the build ships that loads silently', () => {
    const EXPECTED = [
        'bz2', 'com_dotnet', 'curl', 'dba', 'enchant', 'exif', 'ffi', 'fileinfo',
        'ftp', 'gd', 'gettext', 'gmp', 'intl', 'ldap', 'mbstring', 'mysqli',
        'odbc', 'openssl', 'pdo_mysql', 'pdo_odbc', 'pdo_pgsql', 'pdo_sqlite',
        'pgsql', 'shmop', 'soap', 'sockets', 'sodium', 'sqlite3', 'sysvshm',
        'tidy', 'xsl', 'zip',
    ];

    it('enables every extension verified to load without a warning', () => {
        expect([...PHP_INI_EXTENSIONS].sort()).toEqual([...EXPECTED].sort());
    });

    it('carries the extensions whose absence actually broke a site', () => {
        // The regression this list exists to prevent. `pgsql` is the pointed one:
        // `pdo_pgsql` was enabled while native `pgsql` was not, which reads as
        // arbitrary to anyone hitting it.
        for (const ext of ['mysqli', 'pgsql', 'soap', 'ldap', 'gmp', 'bz2', 'ftp', 'gettext']) {
            expect(PHP_INI_EXTENSIONS).toContain(ext);
        }
    });

    it('still excludes the four that cannot be enabled, and says why in the ini', () => {
        for (const ext of ['opcache', 'pdo_firebird', 'snmp', 'dl_test', 'zend_test']) {
            expect(PHP_INI_EXTENSIONS).not.toContain(ext);
        }
        // POSITIVE CONTROL: "does not contain" passes against an empty list, so
        // prove the list is populated and the ini still explains the opcache call.
        expect(PHP_INI_EXTENSIONS.length).toBeGreaterThan(30);
        expect(phpIniContents('C:\php', 'win32')).toContain('opcache is OFF');
    });
});

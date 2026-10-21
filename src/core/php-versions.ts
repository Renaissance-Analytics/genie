import { join } from 'node:path';

/**
 * MANAGED PHP VERSIONS AND THE PER-SITE PIN (§6.6, ship line T4) — the pure half.
 *
 * Genie 1 owned its PHPs: `<userData>/toolchain/php/<version>`, one directory per version, its binaries AND its php.ini,
 * so a site's PHP is not one another app can upgrade or reconfigure underneath it (Genie 1
 * `main/dev-server/toolchain-versions.ts`, "the owner's decision, recorded so it is not re-litigated"). Genie 2 does the
 * same under its own toolchain directory, with three deliberate differences, each said where it is decided:
 *
 * - the **NTS** build (`php-<v>-nts-Win32-<vs>-x64.zip`), not Genie 1's thread-safe one: Genie 1 switched to ZTS only
 *   because FrankenPHP loads PHP as a library (genie#669); Genie 2 serves PHP through `php-cgi` alone (site-manager.ts).
 * - the zip is **checked against the sha256 windows.php.net publishes** beside it (`sha256sum.txt` in the same
 *   directory) before a byte of it is unpacked. Genie 1 never checked the PHP zip (it checked only its PECL redis
 *   archive, `php-extensions.ts`).
 * - the **pin is honoured, or the start fails saying why**. An unpinned site runs the PHP on this machine's PATH, as it
 *   does today (installed and repaired by T1/T2); a pinned one runs a Genie-managed version, and only one.
 *
 * The pick-list is STATIC, as Genie 1's was ("a box that accepts any string is a box that mostly produces failed
 * downloads, and an index resolver is a network dependency in the middle of a settings page"). Windows only, as Genie
 * 1's was: "macOS/Linux ship no relocatable official build, so php has no recipe there; Genie says so rather than
 * offering a download that cannot work." There, the system PHP is detected and listed, and nothing is installed.
 */

export type PhpPlatform = 'win32' | 'darwin' | 'linux';

export interface PhpRecipe {
    /** The exact version this release of Genie installs. */
    readonly version: string;
    /** windows.php.net's Visual Studio toolset for that line — part of the file name. */
    readonly vs: 'vs16' | 'vs17';
}

/**
 * The versions this release installs: the newest of each supported line, as windows.php.net's own `sha256sum.txt`
 * listed them on 2026-10-15 (`php-8.5.11-nts-Win32-vs17-x64.zip`, `php-8.4.26-nts-Win32-vs17-x64.zip`,
 * `php-8.3.35-nts-Win32-vs16-x64.zip`, `php-8.2.34-nts-Win32-vs16-x64.zip`). The toolsets are Genie 1's (8.4 vs17,
 * 8.3/8.2 vs16) plus 8.5 on vs17. Newest first.
 */
export const PHP_RECIPES: readonly PhpRecipe[] = [
    { version: '8.5.11', vs: 'vs17' },
    { version: '8.4.26', vs: 'vs17' },
    { version: '8.3.35', vs: 'vs16' },
    { version: '8.2.34', vs: 'vs16' },
];

/** What a version is: `8`, `8.3` or `8.3.35` — Genie 1's `cleanEngineVersion` (sites-config.ts), the same shape. */
export const PHP_VERSION = /^\d+(?:\.\d+){0,2}$/;
/** An installed version's directory name: always the full `major.minor.patch`. */
const FULL_VERSION = /^\d+\.\d+\.\d+$/;

export function phpZipName(recipe: PhpRecipe): string {
    return `php-${recipe.version}-nts-Win32-${recipe.vs}-x64.zip`;
}

/**
 * Where a version's zip may be. A current release lives at the root and MOVES to `archives/` when a patch supersedes it
 * (Genie 1's `assetFor`: "try both rather than rot on release day"). Each place publishes its own `sha256sum.txt`, and
 * the checksum is read from the SAME place the zip came from.
 */
export function phpDownloadSources(recipe: PhpRecipe): Array<{ zipUrl: string; sumsUrl: string }> {
    const file = phpZipName(recipe);
    return ['https://windows.php.net/downloads/releases/', 'https://windows.php.net/downloads/releases/archives/'].map((base) => ({ zipUrl: `${base}${file}`, sumsUrl: `${base}sha256sum.txt` }));
}

/**
 * `sha256sum.txt` as windows.php.net writes it — `<64 hex> *<file name>` per line (the `*` is coreutils' binary-mode
 * marker; a text-mode space is accepted too). Keys are file names; hashes lower-cased. A line of any other shape is
 * skipped, never guessed at.
 */
export function parseSha256Sums(text: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const raw of text.split(/\r?\n/)) {
        const m = /^([0-9a-fA-F]{64}) [ *](\S+)\s*$/.exec(raw.trim());
        if (m) out.set(m[2]!, m[1]!.toLowerCase());
    }
    return out;
}

/** Newest first, numerically: `8.10` is newer than `8.9`, which a string sort gets backwards. */
export function compareVersionsDesc(a: string, b: string): number {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

export interface ManagedPhp {
    readonly version: string;
    /** `<root>/<version>` — the directory Genie owns and Remove deletes. */
    readonly dir: string;
}

/**
 * The versions Genie manages, from its directory's entries: a full version name whose `php-cgi` is THERE. Anything else
 * is not an install — the staging directory of an install in flight, a half-removed folder, a person's own note — and
 * listing it would offer a pin that cannot start. Newest first.
 */
export function managedVersions(entries: readonly string[], cgiExists: (version: string) => boolean, dirOf: (version: string) => string): ManagedPhp[] {
    return entries
        .filter((e) => FULL_VERSION.test(e) && cgiExists(e))
        .sort(compareVersionsDesc)
        .map((version) => ({ version, dir: dirOf(version) }));
}

/** `php-cgi`'s file name on this platform. */
export function phpCgiName(platform: PhpPlatform): string {
    return platform === 'win32' ? 'php-cgi.exe' : 'php-cgi';
}

/**
 * What `php -v` / `php-cgi -v` says: `PHP 8.4.26 (cgi-fcgi) (built: …) (NTS Visual C++ 2022 x64)`. The version, and
 * whether the banner named a thread-safety build at all (`NTS` / `ZTS`); `null` when it is not a PHP banner.
 */
export function parsePhpBanner(output: string): { version: string; threadSafe: boolean | null } | null {
    const line = output.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    const m = /^PHP (\d+\.\d+\.\d+)/.exec(line.trim());
    if (!m) return null;
    return { version: m[1]!, threadSafe: /\bZTS\b/.test(line) ? true : /\bNTS\b/.test(line) ? false : null };
}

/** Does an install satisfy this pin? Exact, or a LINE — `8.3` is the newest 8.3.x — split at a dot, so `8.3` never matches `8.30` (Genie 1 `satisfiesPin`). */
export function satisfiesPin(version: string, pin: string): boolean {
    return version === pin || version.startsWith(`${pin}.`);
}

/** The managed install a pin runs on — the newest that satisfies it — or `null`. */
export function pickPinned(managed: readonly ManagedPhp[], pin: string): ManagedPhp | null {
    return [...managed].sort((a, b) => compareVersionsDesc(a.version, b.version)).find((m) => satisfiesPin(m.version, pin)) ?? null;
}

export const PHP_VERSIONS_WHERE = 'Toolchain → PHP versions';

/**
 * Why a pinned site cannot start — never a silent fallback to another PHP (Genie 1 `resolveEngineExe`: "A site quietly
 * running on a different runtime than the one it names is the failure this whole feature exists to prevent"). Names
 * what to do, and what Genie does manage.
 */
export function missingPinReason(pin: string, managed: readonly ManagedPhp[], platform: PhpPlatform): string {
    const choices = managed.map((m) => m.version);
    if (platform !== 'win32' && choices.length === 0) {
        return `this site is pinned to PHP ${pin}, and Genie installs PHP versions on Windows only — on this machine it serves the PHP on your PATH. Remove the pin to serve it with that PHP`;
    }
    return `this site is pinned to PHP ${pin}, which Genie does not manage on this machine. ${choices.length > 0 ? `Install it in ${PHP_VERSIONS_WHERE}, or pin the site to one Genie manages: ${choices.join(', ')}` : `Install it in ${PHP_VERSIONS_WHERE}, then start the site again`}`;
}

/** A command-line word for the pty's parser (`"…"` when it has a space; fancy-term-host `parseCommandLine`). */
export function commandWord(token: string): string {
    return /\s/.test(token) ? `"${token}"` : token;
}

/**
 * The php-cgi a managed version runs: its own binary, told its own php.ini with `-c` (php-cgi also searches the working
 * directory — the site's repo — FIRST, so a stray php.ini there would otherwise win). `PHP_INI_SCAN_DIR` (the #284 CA
 * ini) still applies on top: `-c` replaces only the main ini.
 */
export function managedCgiCommand(dir: string, platform: PhpPlatform): string {
    return `${commandWord(join(dir, phpCgiName(platform)))} -c ${commandWord(join(dir, 'php.ini'))}`;
}

/**
 * The extensions Genie's php.ini enables — Genie 1's `PHP_INI_EXTENSIONS`, every one "loaded for real out of
 * php-8.4.24-nts-Win32-vs17-x64: `php -m` lists all … and prints no 'Unable to load dynamic library'". Absent on purpose
 * (Genie 1's reasons): pdo_firebird (needs a client library the zip lacks), snmp (warns on every call), dl_test/zend_test,
 * opcache (makes php-cgi.exe die at startup on Windows), and the compiled-in built-ins. The install checks what the new
 * binary actually LOADED, per version — the list was measured on 8.4.
 */
export const PHP_INI_EXTENSIONS: readonly string[] = [
    'bz2', 'curl', 'exif', 'fileinfo', 'ftp', 'gd', 'gettext', 'gmp', 'intl', 'mbstring', 'mysqli', 'openssl',
    'pdo_mysql', 'pdo_pgsql', 'pdo_sqlite', 'pgsql', 'soap', 'sockets', 'sodium', 'sqlite3', 'xsl', 'zip',
];

/**
 * The php.ini Genie writes into a version's directory. The windows.php.net zip ships NO active php.ini — every
 * `extension=` in php.ini-production is commented out — so without this an installed PHP answers `-v` and cannot run a
 * Laravel app (Genie 1 `phpIniContents`). The CA bundle is NOT here: it is the #284 ini in `PHP_INI_SCAN_DIR`, loaded
 * after this one, so Check and repair keeps working for every version at once.
 */
export function phpIniContents(versionDir: string): string {
    return [
        '; Genie-managed php.ini — rewritten when Genie reinstalls this version.',
        `; Owned by Genie: ${versionDir}`,
        '',
        `extension_dir = "${versionDir}\\ext"`,
        '',
        ...PHP_INI_EXTENSIONS.map((e) => `extension=${e}`),
        '',
        '; $_ENV is populated from the process environment — what Laravel reads first for the service env Genie injects.',
        'variables_order = "EGPCS"',
        'memory_limit = 512M',
        'max_execution_time = 120',
        'upload_max_filesize = 64M',
        'post_max_size = 64M',
        'display_errors = On',
        'error_reporting = E_ALL',
        '',
        // OPCACHE (genie#1043; moic, 2026-10-21: Laravel /up 2,606 ms — every request recompiled the framework). Genie 1
        // left it out because it "makes php-cgi.exe die at startup on Windows"; the file cache in a directory that EXISTS
        // (Genie makes it: `phpCacheDir`) with the fallback on is what lets php-cgi start — measured by
        // scripts/acceptance-php.ts on the Windows test VM. Timestamps are checked on every request: these are sites being
        // developed, and an edited file must show at once.
        'zend_extension=opcache',
        'opcache.enable=1',
        'opcache.enable_cli=0',
        `opcache.file_cache="${phpCacheDir(versionDir)}"`,
        'opcache.file_cache_fallback=1',
        'opcache.validate_timestamps=1',
        'opcache.revalidate_freq=0',
        'opcache.memory_consumption=256',
        'opcache.max_accelerated_files=50000',
        '',
    ].join('\r\n');
}

/** The opcache file cache's directory for a managed version — it must exist before php-cgi starts. */
export function phpCacheDir(versionDir: string): string {
    return `${versionDir}\\opcache`;
}

/**
 * OPCACHE FOR A PHP WHOSE INI GENIE DOES NOT OWN (genie#1043 part B): Genie's toolchain PHP keeps Genie 1's ini, opcache
 * off. The same settings as {@link phpIniContents}, given to php-cgi as `-d` words: the extension by its full path in
 * that PHP's own ext folder, and the file cache in `cacheDir` (which must exist — what lets php-cgi start on Windows).
 */
export function toolchainOpcacheFlags(phpDir: string, cacheDir: string): string[] {
    return [
        `zend_extension=${phpDir}\\ext\\php_opcache.dll`,
        'opcache.enable=1',
        `opcache.file_cache=${cacheDir}`,
        'opcache.file_cache_fallback=1',
        'opcache.validate_timestamps=1',
        'opcache.revalidate_freq=0',
        'opcache.memory_consumption=256',
        'opcache.max_accelerated_files=50000',
    ].flatMap((setting) => ['-d', setting]);
}

/**
 * What the new binary's `php -m` says is wrong, or `null`: a required extension not loaded, or a loader complaint (PHP's
 * CLI prints startup warnings to STDOUT — Genie 1 `parseModuleList`, measured on 8.4.24).
 */
export function moduleProblem(output: string): string | null {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const complaint = lines.find((l) => /Warning|Unable to load|cannot load/i.test(l));
    if (complaint) return `it complained on startup: ${complaint.slice(0, 300)}`;
    const loaded = new Set(lines.filter((l) => /^[A-Za-z_][A-Za-z0-9_ .-]*$/.test(l)).map((l) => l.toLowerCase()));
    const missing = PHP_INI_EXTENSIONS.filter((e) => !loaded.has(e));
    return missing.length > 0 ? `it did not load ${missing.join(', ')}` : null;
}

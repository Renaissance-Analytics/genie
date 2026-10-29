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
 * - the zip is **checked against the sha256 windows.php.net publishes** for its current build (`releases.json`,
 *   genie#1306 — {@link phpWindowsBuild}) before a byte of it is unpacked. Genie 1 never checked the PHP zip (it checked only its PECL redis
 *   archive, `php-extensions.ts`).
 * - the **pin is honoured, or the start fails saying why**. An unpinned site runs the PHP on this machine's PATH, as it
 *   does today (installed and repaired by T1/T2); a pinned one runs a Genie-managed version, and only one.
 *
 * The pick-list is STATIC, as Genie 1's was ("a box that accepts any string is a box that mostly produces failed
 * downloads, and an index resolver is a network dependency in the middle of a settings page"). Genie 1's was Windows
 * only ("macOS/Linux ship no relocatable official build"). Genie 2 BUILDS it on Linux from php.net's own source (plan
 * TC5; the owner's decision 2: no third-party builds), the same versions, every extension Genie's php.ini enables
 * compiled in. macOS has no recipe yet (no macOS test machine): the system PHP is detected and listed, nothing installed.
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
 * listed them on 2026-10-22 (`php-8.5.12-nts-Win32-vs17-x64.zip`, `php-8.4.27-nts-Win32-vs17-x64.zip`,
 * `php-8.3.36-nts-Win32-vs16-x64.zip`, `php-8.2.35-nts-Win32-vs16-x64.zip`) — the PHP2Shell releases of 2026-10-21,
 * each the first of its line that is not vulnerable to CVE-2026-109618 / CVE-2026-109619 (core/php-advisories.ts; the
 * four this list held before, 8.5.11 / 8.4.26 / 8.3.35 / 8.2.34, all were). The toolsets are Genie 1's (8.4 vs17,
 * 8.3/8.2 vs16) plus 8.5 on vs17. Newest first. test/php-advisories.test.tsx holds every entry at or above the floor.
 */
export const PHP_RECIPES: readonly PhpRecipe[] = [
    { version: '8.5.12', vs: 'vs17' },
    { version: '8.4.27', vs: 'vs17' },
    { version: '8.3.36', vs: 'vs16' },
    { version: '8.2.35', vs: 'vs16' },
];

/** What a version is: `8`, `8.3` or `8.3.35` — Genie 1's `cleanEngineVersion` (sites-config.ts), the same shape. */
export const PHP_VERSION = /^\d+(?:\.\d+){0,2}$/;
/** An installed version's directory name: always the full `major.minor.patch`. */
const FULL_VERSION = /^\d+\.\d+\.\d+$/;

export function phpZipName(recipe: PhpRecipe): string {
    return `php-${recipe.version}-nts-Win32-${recipe.vs}-x64.zip`;
}

/**
 * Where a build's zip may be: the release directory while it is current, `archives/` once it is superseded (Genie 1's
 * `assetFor`: "try both rather than rot on release day"). The CHECKSUM never comes from archives/: windows.php.net
 * publishes no `sha256sum.txt` there (HTTP 404, measured 2026-10-27 — genie#1306: the owner's install failed on exactly
 * that), only `releases.json` / `sha256sum.txt` in the release directory, for the current build of each line.
 */
export function phpBuildUrls(file: string): string[] {
    return ['https://windows.php.net/downloads/releases/', 'https://windows.php.net/downloads/releases/archives/'].map((base) => `${base}${file}`);
}

/** windows.php.net's own index of its CURRENT builds: per line, each build's zip with its sha256. */
export const PHP_WINDOWS_RELEASES_JSON = 'https://windows.php.net/downloads/releases/releases.json';

export type PhpWindowsBuild = { readonly file: string; readonly sha256: string } | { readonly missing: string };

const NTS_X64 = /^nts-vs[0-9]+-x64$/;
const ZIP_NAME = /^php-[0-9A-Za-z._-]+[.]zip$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * THE BUILD windows.php.net publishes for `version` (NTS, x64), from its `releases.json`: the file and its sha256. A line's
 * build can be a RE-ISSUE — `8.4.27-1`, `php-8.4.27-1-nts-Win32-vs17-x64.zip` (the PHP2Shell builds were rebuilt on
 * 2026-10-26 and the originals archived) — and it is the same PHP 8.4.27. A version that is not its line's current
 * build has no published checksum, so it is `missing`, with the words why: never a guess, never unverified.
 */
export function phpWindowsBuild(json: string, version: string): PhpWindowsBuild {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return { missing: "windows.php.net's releases.json could not be parsed" };
    }
    const line = version.split('.').slice(0, 2).join('.');
    const entry = (parsed as Record<string, unknown> | null)?.[line] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== 'object') return { missing: `windows.php.net lists no PHP ${line} build` };
    const listed = typeof entry['version'] === 'string' ? entry['version'] : '';
    if (listed !== version && !listed.startsWith(`${version}-`)) {
        return { missing: `windows.php.net's current PHP ${line} build is ${listed || 'unnamed'}, not ${version}; an archived build has no published checksum` };
    }
    for (const [key, build] of Object.entries(entry)) {
        if (!NTS_X64.test(key)) continue;
        const zip = (build as { zip?: { path?: unknown; sha256?: unknown } } | null)?.zip;
        if (typeof zip?.path === 'string' && typeof zip.sha256 === 'string' && SHA256.test(zip.sha256) && ZIP_NAME.test(zip.path)) {
            return { file: zip.path, sha256: zip.sha256.toLowerCase() };
        }
    }
    return { missing: `windows.php.net lists no x64 NTS zip with a sha256 for PHP ${listed}` };
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
    if (platform === 'darwin' && choices.length === 0) {
        return `this site is pinned to PHP ${pin}, and Genie does not install PHP versions on macOS yet — on this machine it serves the PHP on your PATH. Remove the pin to serve it with that PHP`;
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
 * Laravel app (Genie 1 `phpIniContents`).
 *
 * THE CA BUNDLE IS HERE (genie#1334). It used to be left to the #284 ini in `PHP_INI_SCAN_DIR` — which exists only after
 * a Check and repair, and is never seen by a PHP started outside Genie's own environment — so a version Genie installed
 * had NO trust anchors: the Windows zip ships none, and its compiled-in default names a file that does not exist. Every
 * outbound HTTPS call failed with cURL 60 / verify 20 (fancy, 2026-10-29, after genie#1306 made such a version the
 * owner's default). Genie 1 named its exported `cacert.pem` in this very file (v0.7.0-beta.342 `toolchain-versions.ts`
 * `phpIniContents`, written by `toolchain-version-install.ts` after `writeCaBundle`). `ca` is {@link phpCaSettings}'s
 * answer: a file that exists, or nothing — naming a missing file turns errno 60 into 77 and hides the cause.
 */
export function phpIniContents(versionDir: string, platform: PhpPlatform = 'win32', ca: PhpCaSettings = {}): string {
    if (platform !== 'win32') return linuxIni(versionDir, ca);
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
        ...caLines(ca),
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

/**
 * A SOURCE-BUILT PHP's ini (TC5): every extension is compiled in, so there is no `extension=` line (a built-in loaded
 * again warns "Module already loaded" on every start) and no extension_dir — the build knows its own, where opcache.so
 * is. Opcache by name, without Windows' file cache (that answers a php-cgi.exe start-up failure Linux does not have).
 */
function linuxIni(versionDir: string, ca: PhpCaSettings): string {
    return [
        '; Genie-managed php.ini — rewritten when Genie reinstalls this version.',
        `; Owned by Genie: ${versionDir}`,
        '; Built by Genie from php.net\'s source: every extension Genie enables is compiled in.',
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
        ...caLines(ca),
        'zend_extension=opcache',
        'opcache.enable=1',
        'opcache.enable_cli=0',
        'opcache.validate_timestamps=1',
        'opcache.revalidate_freq=0',
        'opcache.memory_consumption=256',
        'opcache.max_accelerated_files=50000',
        '',
    ].join('\n');
}

/** The CA file each of PHP's two TLS stacks is told to trust; an absent key is not written. */
export interface PhpCaSettings {
    readonly cainfo?: string;
    readonly cafile?: string;
}

/**
 * Both directives, because `file_get_contents('https://…')` and Guzzle's stream handler go through openssl, not curl
 * (Genie 1: "`openssl.cafile` pins every other openssl consumer to the SAME anchors").
 */
function caLines(ca: PhpCaSettings): string[] {
    if (ca.cainfo === undefined && ca.cafile === undefined) return [];
    return [
        '; Trust anchors for outbound HTTPS (genie#1334): Genie\'s CA bundle (on Windows exported from this machine\'s own',
        '; root store, so a corporate proxy\'s root is in it; on Linux the system bundle). A CA file you set here is kept.',
        ...(ca.cainfo !== undefined ? [`curl.cainfo = "${ca.cainfo}"`] : []),
        ...(ca.cafile !== undefined ? [`openssl.cafile = "${ca.cafile}"`] : []),
        '',
    ];
}

/** What an ini sets `key` to, quotes stripped; `undefined` when unset or empty (a `;` comment is not a setting). */
function iniValue(ini: string, key: string): string | undefined {
    for (const line of ini.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
        const v = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
        return v === '' ? undefined : v;
    }
    return undefined;
}

/**
 * THE CA SETTINGS FOR A (RE)WRITTEN MANAGED php.ini (genie#1334). Genie owns the file and rewrites it whole, so what the
 * person set is carried across, never silently emptied:
 *
 * - a CA file already set to one that EXISTS is kept, whoever set it (a corporate root bundle, an earlier Genie bundle);
 * - one set to a file that is gone is replaced by Genie's bundle when there is one, and kept as it was when there is
 *   not: emptying it would be Genie erasing the person's setting;
 * - unset: Genie's bundle, or nothing when Genie has none.
 */
export function phpCaSettings(existingIni: string | null, bundle: string | null, exists: (path: string) => boolean): PhpCaSettings {
    const pick = (key: string): string | undefined => {
        const set = existingIni === null ? undefined : iniValue(existingIni, key);
        if (set !== undefined && (exists(set) || bundle === null)) return set;
        return bundle ?? undefined;
    };
    const cainfo = pick('curl.cainfo');
    const cafile = pick('openssl.cafile');
    return { ...(cainfo !== undefined ? { cainfo } : {}), ...(cafile !== undefined ? { cafile } : {}) };
}

/** The opcache file cache's directory for a managed version — it must exist before php-cgi starts. */
export function phpCacheDir(versionDir: string): string {
    return `${versionDir}\\opcache`;
}

/** php.net's gzipped source tarball: `php-8.4.27.tar.gz`. */
export function phpSourceName(version: string): string {
    return `php-${version}.tar.gz`;
}

export function phpSourceUrl(version: string): string {
    return `https://www.php.net/distributions/${phpSourceName(version)}`;
}

/** php.net's release JSON for one version: its source files, each with its sha256. */
export function phpReleaseJsonUrl(version: string): string {
    return `https://www.php.net/releases/index.php?json&version=${version}`;
}

/** The sha256 php.net's release JSON gives for exactly that version's tar.gz, or `null` — never guessed. */
export function phpSourceShaFromJson(json: string, version: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    const source = (parsed as { source?: unknown } | null)?.source;
    if (!Array.isArray(source)) return null;
    for (const s of source) {
        const e = s as { filename?: unknown; sha256?: unknown };
        if (e.filename !== phpSourceName(version)) continue;
        return typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(e.sha256) ? e.sha256.toLowerCase() : null;
    }
    return null;
}

/**
 * The libraries php.net's configure needs for the extensions Genie enables, by their pkg-config names, with the package
 * that provides each on the common distributions (measured present on omarchy-test, 2026-10-24). bz2 and gmp ship no
 * pkg-config file everywhere: when they are missing, configure's own words say so.
 */
export const PHP_BUILD_LIBRARIES: ReadonlyArray<{ readonly pkg: string; readonly apt: string; readonly dnf: string; readonly pacman: string }> = [
    { pkg: 'libxml-2.0', apt: 'libxml2-dev', dnf: 'libxml2-devel', pacman: 'libxml2' },
    { pkg: 'sqlite3', apt: 'libsqlite3-dev', dnf: 'sqlite-devel', pacman: 'sqlite' },
    { pkg: 'openssl', apt: 'libssl-dev', dnf: 'openssl-devel', pacman: 'openssl' },
    { pkg: 'zlib', apt: 'zlib1g-dev', dnf: 'zlib-devel', pacman: 'zlib' },
    { pkg: 'libcurl', apt: 'libcurl4-openssl-dev', dnf: 'libcurl-devel', pacman: 'curl' },
    { pkg: 'oniguruma', apt: 'libonig-dev', dnf: 'oniguruma-devel', pacman: 'oniguruma' },
    { pkg: 'libzip', apt: 'libzip-dev', dnf: 'libzip-devel', pacman: 'libzip' },
    { pkg: 'icu-i18n', apt: 'libicu-dev', dnf: 'libicu-devel', pacman: 'icu' },
    { pkg: 'libpng', apt: 'libpng-dev', dnf: 'libpng-devel', pacman: 'libpng' },
    { pkg: 'libjpeg', apt: 'libjpeg-dev', dnf: 'libjpeg-turbo-devel', pacman: 'libjpeg-turbo' },
    { pkg: 'freetype2', apt: 'libfreetype-dev', dnf: 'freetype-devel', pacman: 'freetype2' },
    { pkg: 'libsodium', apt: 'libsodium-dev', dnf: 'libsodium-devel', pacman: 'libsodium' },
    { pkg: 'libxslt', apt: 'libxslt1-dev', dnf: 'libxslt-devel', pacman: 'libxslt' },
    { pkg: 'libpq', apt: 'libpq-dev', dnf: 'libpq-devel', pacman: 'postgresql-libs' },
];

/** What to tell the person about missing libraries: each one, and the package lines that bring them. */
export function missingLibrariesAdvice(missing: readonly string[]): string {
    const rows = PHP_BUILD_LIBRARIES.filter((l) => missing.includes(l.pkg));
    const pkgs = (k: 'apt' | 'dnf' | 'pacman') => rows.map((r) => r[k]).join(' ');
    return `Genie builds PHP from php.net's source here, and these libraries it needs are not on this machine: ${missing.join(', ')} — install them (Debian/Ubuntu: sudo apt install ${pkgs('apt')}; Fedora: sudo dnf install ${pkgs('dnf')}; Arch: sudo pacman -S ${pkgs('pacman')}) and install again`;
}

/**
 * configure's flags: the binaries and php.ini at the version's TOP (`--bindir`, `--sbindir`), as on Windows, and every
 * extension in PHP_INI_EXTENSIONS compiled in (mysqlnd, PHP's own MySQL driver, so no MySQL client library is needed).
 * The man pages and data go under share/: PHP's defaults (`<prefix>/php/man`, `<prefix>/php`) are the very path of the
 * `php` binary once bindir is the prefix — measured: `make install` failed after "Installing PHP CLI man page".
 */
export function phpConfigureArgs(dir: string): string[] {
    return [
        '-q', `--prefix=${dir}`, `--bindir=${dir}`, `--sbindir=${dir}`, `--mandir=${join(dir, 'share', 'man')}`, `--datadir=${join(dir, 'share')}`,
        `--with-config-file-path=${dir}`, `--with-config-file-scan-dir=${dir}/conf.d`,
        '--enable-cgi', '--enable-fpm', '--with-openssl', '--with-zlib', '--with-bz2', '--with-curl', '--enable-exif', '--enable-ftp',
        '--enable-gd', '--with-jpeg', '--with-freetype', '--with-gettext', '--with-gmp', '--enable-intl', '--enable-mbstring',
        '--with-mysqli=mysqlnd', '--with-pdo-mysql=mysqlnd', '--with-pdo-pgsql', '--with-pgsql', '--with-pdo-sqlite', '--with-sqlite3',
        '--enable-soap', '--enable-sockets', '--with-sodium', '--with-xsl', '--with-zip', '--enable-bcmath', '--enable-pcntl',
    ];
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

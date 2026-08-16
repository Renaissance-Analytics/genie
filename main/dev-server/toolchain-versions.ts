/**
 * PURE. The MULTI-VERSION toolchain model — what a language install IS, where
 * Genie keeps its own, which of them a site may use, and what "Add a version"
 * is allowed to offer.
 *
 * ## The one rule everything here encodes
 *
 * **An install is a DIRECTORY holding real executables — never a PATH entry.**
 * That is not pedantry, it is genie#206: on the owner's machine PATH carried
 * Herd's `php.bat` shim, the real `php.exe`/`php-cgi.exe` sat one level down in
 * `bin/php84`, Genie asked PATH for `php-cgi`, and the FastCGI worker died. So a
 * version is a directory + the executables proven to be inside it, and a spawn
 * resolves THAT path rather than asking PATH what `php` means today.
 *
 * ## Genie OWNS its toolchain; it does not adopt Herd's
 *
 * Foreign installs (Herd, XAMPP, nvm, a system package) are DETECTED for
 * awareness — so the machine is legible and nobody wonders why Genie installed
 * "another" PHP — but they are never selectable and never removable. A borrowed
 * toolchain is one another app can upgrade, reconfigure or uninstall underneath
 * a running site; Genie owning `<userData>/toolchain/php/8.3.33` (binaries AND
 * `php.ini`) is what makes a site reproducible. See
 * `.ai/design/genie-toolchain-page.md` — this is the owner's decision, recorded
 * so it is not re-litigated.
 *
 * ## The pick-list is STATIC on purpose
 *
 * "Add a version" offers exactly {@link TOOLCHAIN_RECIPES} — a short table of
 * versions this RELEASE knows it can install, growing release by release. No
 * free-text version box and no live release-index resolver: a box that accepts
 * any string is a box that mostly produces failed downloads, and an index
 * resolver is a network dependency in the middle of a settings page.
 */

// --- the model --------------------------------------------------------------

/** The languages Genie manages versions of. One model for all five — no "why is
 *  Go different" later. */
export type LanguageTool = 'php' | 'node' | 'python' | 'go' | 'rust';

export const LANGUAGE_TOOLS: readonly LanguageTool[] = ['php', 'node', 'python', 'go', 'rust'];

const LANGUAGE_SET: ReadonlySet<string> = new Set(LANGUAGE_TOOLS);

/** Whether a string is one of the five managed languages. */
export function isLanguageTool(v: unknown): v is LanguageTool {
    return typeof v === 'string' && LANGUAGE_SET.has(v);
}

/**
 * Who put this install on the machine.
 *
 * `genie` is the only value that makes an install usable by a site; the rest
 * exist so the page can SAY "yes, Genie knows Herd has 8.4" without implying
 * anything can be pinned to it.
 */
export type EngineInstallSource = 'genie' | 'herd' | 'xampp' | 'nvm' | 'system';

export interface EngineInstall {
    tool: LanguageTool;
    /** The version as the install itself reports it (`8.3.33`, `24.19.0`). */
    version: string;
    /** The directory holding the REAL executables. The whole point. */
    dir: string;
    /** Absolute path to the primary executable inside {@link dir}. */
    exe: string;
    source: EngineInstallSource;
    /** Genie installed it → Genie may remove it. Never true for a foreign one. */
    removable: boolean;
    /** Bytes on disk. Genie-owned installs only — Genie never walks another
     *  app's tree to put a number next to it. */
    sizeBytes?: number;
}

/** Display labels. The UI never shows the internal id. */
export const LANGUAGE_LABELS: Record<LanguageTool, string> = {
    php: 'PHP',
    node: 'Node.js',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
};

export const SOURCE_LABELS: Record<EngineInstallSource, string> = {
    genie: 'Genie',
    herd: 'Herd',
    xampp: 'XAMPP',
    nvm: 'nvm',
    system: 'System',
};

// --- executables ------------------------------------------------------------

/** The primary binary each language is identified by, without an extension. */
const PRIMARY_BIN: Record<LanguageTool, string> = {
    php: 'php',
    node: 'node',
    python: 'python',
    go: 'go',
    rust: 'rustc',
};

/**
 * Binaries that must exist ALONGSIDE the primary one for the install to be
 * usable. Only php has one, and it is the genie#206 binary: `php-cgi` is what
 * the FastCGI worker spawns, so a php directory without it can pass a
 * `php --version` check and still be unable to serve a single request.
 */
const COMPANION_BINS: Partial<Record<LanguageTool, readonly string[]>> = {
    php: ['php-cgi'],
};

const exeSuffix = (platform: string): string => (platform === 'win32' ? '.exe' : '');

/** The primary executable's FILE NAME on this platform. */
export function engineExeName(tool: LanguageTool, platform: string): string {
    return `${PRIMARY_BIN[tool]}${exeSuffix(platform)}`;
}

/** The primary binary's bare name — what a `where`/`which` lookup takes. */
export function enginePrimaryBin(tool: LanguageTool): string {
    return PRIMARY_BIN[tool];
}

/** How to ask an engine for its version. Go is the odd one — `go --version` is
 *  an error, the subcommand is `go version`. */
const VERSION_ARGV: Record<LanguageTool, string[]> = {
    php: ['--version'],
    node: ['--version'],
    python: ['--version'],
    go: ['version'],
    rust: ['--version'],
};

export function engineVersionArgv(tool: LanguageTool): string[] {
    return VERSION_ARGV[tool];
}

/** The executables that must sit beside the primary one (php-cgi, and nothing
 *  else so far). Empty for every other language. */
export function engineCompanionExes(tool: LanguageTool, platform: string): string[] {
    return (COMPANION_BINS[tool] ?? []).map((b) => `${b}${exeSuffix(platform)}`);
}

/**
 * The FILE NAME of one of an engine's binaries on this platform — the primary or
 * a companion — or `undefined` for a name this install is not known to hold.
 *
 * The scan proves the primary and every companion are present before it calls a
 * directory an install ({@link engineCompanionExes}); nothing else has been
 * proven, so nothing else may be spawned from it. That refusal is why a caller
 * cannot ask for `php-fpm` and get a path that does not exist.
 */
export function engineBinFileName(
    tool: LanguageTool,
    bin: string,
    platform: string,
): string | undefined {
    const known = [PRIMARY_BIN[tool], ...(COMPANION_BINS[tool] ?? [])];
    return known.includes(bin) ? `${bin}${exeSuffix(platform)}` : undefined;
}

// --- paths (pure, platform-parameterised so a win32 layout is testable on CI) ---

const sepFor = (platform: string): string => (platform === 'win32' ? '\\' : '/');

/** Join path parts for a GIVEN platform, so a Windows layout can be asserted on
 *  a Linux runner (and vice versa) without `node:path`. */
export function joinFor(platform: string, ...parts: string[]): string {
    return parts.filter((p) => p !== '').join(sepFor(platform));
}

/** `<userData>/toolchain` — the one directory Genie owns end to end. */
export function genieToolchainRoot(userData: string, platform: string): string {
    return joinFor(platform, userData, 'toolchain');
}

/** `<root>/<tool>/<version>` — one directory per version, so removing a version
 *  is deleting a folder and nothing of the user's is ever overwritten. */
export function genieVersionDir(
    root: string,
    tool: LanguageTool,
    version: string,
    platform: string,
): string {
    return joinFor(platform, root, tool, version);
}

/** Identity for an install ROW. Includes the directory because one version can
 *  legitimately exist twice — Genie's php 8.4 and Herd's php 8.4 are two rows. */
export function installKey(i: EngineInstall): string {
    return `${i.tool}|${i.version}|${i.dir}`;
}

// --- versions ---------------------------------------------------------------

/** Numeric segment compare — `8.10` is NEWER than `8.9`, which a string sort
 *  gets backwards. */
export function compareVersionsDesc(a: string, b: string): number {
    const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** How many segments make a version LINE, per tool. Node talks in majors (`24`);
 *  everyone else in `major.minor` (`8.3`, `1.26`, `3.14`). */
const LINE_SEGMENTS: Record<LanguageTool, number> = {
    php: 2,
    node: 1,
    python: 2,
    go: 2,
    rust: 2,
};

/** The release LINE a version belongs to — what a human means by "PHP 8.3". */
export function versionLine(tool: LanguageTool, version: string): string {
    return version.split('.').slice(0, LINE_SEGMENTS[tool]).join('.');
}

/** Genie-owned first (they are the ones you can act on), then newest first. */
export function sortInstalls(installs: EngineInstall[]): EngineInstall[] {
    return [...installs].sort((a, b) => {
        if (a.source !== b.source) {
            if (a.source === 'genie') return -1;
            if (b.source === 'genie') return 1;
            return a.source.localeCompare(b.source);
        }
        return compareVersionsDesc(a.version, b.version);
    });
}

/** The installs a site may actually use: Genie's own, and only Genie's own. */
export function selectableInstalls(installs: EngineInstall[]): EngineInstall[] {
    return installs.filter((i) => i.source === 'genie');
}

// --- the machine default ----------------------------------------------------

export type ToolchainDefaults = Partial<Record<LanguageTool, string>>;

/**
 * Which version is the machine default for a language.
 *
 * An explicit default wins, but ONLY if it still resolves to a Genie-owned
 * install — a stale default (the version was removed) or one pointing at a
 * foreign install would otherwise silently run sites on something else. Absent
 * that, the newest Genie install; and `undefined` when Genie owns none, which is
 * the honest answer rather than borrowing Herd's.
 */
export function defaultVersionFor(
    tool: LanguageTool,
    installs: EngineInstall[],
    defaults: ToolchainDefaults,
): string | undefined {
    const mine = selectableInstalls(installs.filter((i) => i.tool === tool));
    if (mine.length === 0) return undefined;
    const wanted = defaults[tool];
    if (wanted && mine.some((i) => i.version === wanted)) return wanted;
    return [...mine].sort((a, b) => compareVersionsDesc(a.version, b.version))[0]!.version;
}

/** Read the persisted defaults blob. Junk in the store is not a crash and not a
 *  pretend default — an unknown language or a non-string version is dropped. */
export function parseToolchainDefaults(raw: string | undefined | null): ToolchainDefaults {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ToolchainDefaults = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (isLanguageTool(k) && typeof v === 'string' && v) out[k] = v;
    }
    return out;
}

export function serializeToolchainDefaults(d: ToolchainDefaults): string {
    return JSON.stringify(d);
}

// --- what "Add a version" may offer ----------------------------------------

/** How an artifact must be handled once fetched. */
export type VersionArtifact = 'zip' | 'tar.gz' | 'exe';

export interface VersionAsset {
    /** Candidate URLs, in order. More than one where a vendor MOVES a release
     *  as it is superseded (windows.php.net → `archives/`), so a still-correct
     *  version does not 404 the day after a patch ships. */
    urls: string[];
    artifact: VersionArtifact;
    /** The single top-level directory inside the archive, stripped on extract.
     *  '' when the archive unpacks flat (the php-windows zips do). */
    strip: string;
    /** Where the real executables sit UNDER the version dir. '' = the version
     *  dir itself (the Windows layouts); `bin` for the posix tarballs and Go. */
    bin: string;
    /** Installer args, for an `exe` artifact. `{dir}` is substituted. */
    args?: string[];
}

export interface VersionRecipe {
    tool: LanguageTool;
    /** The EXACT version this release of Genie installs. */
    version: string;
    /** Platforms this recipe supports. */
    platforms: readonly string[];
    /** Vendor-specific token — php-windows' VS toolset, which differs per line. */
    tag?: string;
}

const ALL_PLATFORMS = ['win32', 'darwin', 'linux'] as const;

/**
 * The pick-list. Every entry was checked against the vendor before it was
 * written here; a line with no honest download on a platform is simply ABSENT
 * rather than present-and-broken.
 *
 * - **php** — windows.php.net publishes relocatable NTS builds (NTS is the right
 *   one: the FastCGI worker runs `php-cgi`). macOS/Linux ship no relocatable
 *   official build, so php has no recipe there; Genie says so rather than
 *   offering a download that cannot work.
 * - **node / go** — official archives on every desktop platform.
 * - **python** — the official Windows installer supports a per-user install into
 *   a target directory with no elevation. macOS/Linux would mean building from
 *   source, which is not something to start behind a settings button.
 * - **rust** — rustup owns version selection; a per-version directory needs its
 *   own `RUSTUP_HOME`, which is real work and not yet done. Detected installs
 *   still list.
 */
export const TOOLCHAIN_RECIPES: readonly VersionRecipe[] = [
    { tool: 'php', version: '8.4.24', platforms: ['win32'], tag: 'vs17' },
    { tool: 'php', version: '8.3.33', platforms: ['win32'], tag: 'vs16' },
    { tool: 'php', version: '8.2.33', platforms: ['win32'], tag: 'vs16' },
    { tool: 'node', version: '26.7.0', platforms: ALL_PLATFORMS },
    { tool: 'node', version: '24.19.0', platforms: ALL_PLATFORMS },
    { tool: 'node', version: '22.23.2', platforms: ALL_PLATFORMS },
    { tool: 'go', version: '1.26.6', platforms: ALL_PLATFORMS },
    { tool: 'go', version: '1.25.13', platforms: ALL_PLATFORMS },
    { tool: 'python', version: '3.14.7', platforms: ['win32'] },
    { tool: 'python', version: '3.13.15', platforms: ['win32'] },
];

export interface RecipeContext {
    os: string;
    arch?: string;
}

/** The vendors' architecture vocabulary. */
function vendorArch(arch: string | undefined): 'x64' | 'arm64' {
    return arch === 'arm64' ? 'arm64' : 'x64';
}

/**
 * The concrete download for a recipe on THIS machine, or undefined when there
 * is none (an unsupported platform or architecture). Pure: no network, so the
 * exact URL is asserted in a test rather than discovered in production.
 */
export function assetFor(recipe: VersionRecipe, ctx: RecipeContext): VersionAsset | undefined {
    if (!recipe.platforms.includes(ctx.os)) return undefined;
    const arch = vendorArch(ctx.arch);
    const v = recipe.version;
    switch (recipe.tool) {
        case 'php': {
            // x64 only — windows.php.net publishes no arm64 build.
            if (arch !== 'x64') return undefined;
            const file = `php-${v}-nts-Win32-${recipe.tag}-x64.zip`;
            return {
                // Current releases live at the root and MOVE to archives/ when a
                // patch supersedes them; try both rather than rot on release day.
                urls: [
                    `https://windows.php.net/downloads/releases/${file}`,
                    `https://windows.php.net/downloads/releases/archives/${file}`,
                ],
                artifact: 'zip',
                strip: '',
                bin: '',
            };
        }
        case 'node': {
            if (ctx.os === 'win32') {
                const name = `node-v${v}-win-${arch}`;
                return {
                    urls: [`https://nodejs.org/dist/v${v}/${name}.zip`],
                    artifact: 'zip',
                    strip: name,
                    bin: '',
                };
            }
            const name = `node-v${v}-${ctx.os === 'darwin' ? 'darwin' : 'linux'}-${arch}`;
            return {
                urls: [`https://nodejs.org/dist/v${v}/${name}.tar.gz`],
                artifact: 'tar.gz',
                strip: name,
                bin: 'bin',
            };
        }
        case 'go': {
            const goArch = arch === 'arm64' ? 'arm64' : 'amd64';
            if (ctx.os === 'win32') {
                return {
                    urls: [`https://go.dev/dl/go${v}.windows-${goArch}.zip`],
                    artifact: 'zip',
                    strip: 'go',
                    bin: 'bin',
                };
            }
            return {
                urls: [`https://go.dev/dl/go${v}.${ctx.os === 'darwin' ? 'darwin' : 'linux'}-${goArch}.tar.gz`],
                artifact: 'tar.gz',
                strip: 'go',
                bin: 'bin',
            };
        }
        case 'python': {
            if (arch !== 'x64') return undefined;
            return {
                urls: [`https://www.python.org/ftp/python/${v}/python-${v}-amd64.exe`],
                artifact: 'exe',
                strip: '',
                bin: '',
                // A PER-USER install into Genie's own directory: no elevation, no
                // PATH change, no file associations, no Start-menu entries. Genie
                // resolves the interpreter by path, so none of that is wanted.
                args: [
                    '/quiet',
                    'InstallAllUsers=0',
                    'PrependPath=0',
                    'Include_launcher=0',
                    'AssociateFiles=0',
                    'Shortcuts=0',
                    'Include_test=0',
                    'TargetDir={dir}',
                ],
            };
        }
        case 'rust':
            return undefined;
    }
}

/** Every version Genie can install for a language on THIS machine, newest first. */
export function recipesFor(tool: LanguageTool, ctx: RecipeContext): VersionRecipe[] {
    return TOOLCHAIN_RECIPES.filter((r) => r.tool === tool && assetFor(r, ctx) !== undefined).sort(
        (a, b) => compareVersionsDesc(a.version, b.version),
    );
}

/**
 * What "Add a version" offers: the recipes for this machine MINUS the ones
 * Genie has already installed. A version a FOREIGN installer happens to have is
 * still offered — Genie owning its own 8.4 is the whole model, and refusing
 * because Herd has one would be adopting Herd's by the back door.
 */
export function addableRecipes(
    tool: LanguageTool,
    ctx: RecipeContext,
    installs: EngineInstall[],
): VersionRecipe[] {
    const mine = new Set(
        selectableInstalls(installs.filter((i) => i.tool === tool)).map((i) => i.version),
    );
    return recipesFor(tool, ctx).filter((r) => !mine.has(r.version));
}

// --- php.ini — Genie owns the CONFIG too ------------------------------------

/**
 * The extensions Genie's php.ini enables.
 *
 * Chosen for what Genie's `php` serve mode actually runs — a Laravel app out of
 * `public/`. A MISSING extension surfaces as a cryptic failure deep inside a
 * request (`Class "PDO" not found`) that costs an afternoon; an enabled-but-
 * unused one costs a fraction of a megabyte of RAM. The asymmetry decides it.
 * Everything here ships as a DLL in the official Windows build's `ext/`, so
 * enabling them needs no compilation and no extra download.
 *
 * `bcmath` is deliberately absent even though a Laravel app may use it: on
 * Windows it is COMPILED INTO the binary, there is no `php_bcmath.dll`, and the
 * line only bought a "Unable to load dynamic library 'bcmath'" warning on every
 * single startup. It is available regardless — `php -m` lists it with no ini at
 * all (checked against php-8.4.24-nts-Win32-vs17-x64).
 */
export const PHP_INI_EXTENSIONS: readonly string[] = [
    'curl',
    'exif',
    'fileinfo',
    'gd',
    'intl',
    'mbstring',
    'openssl',
    'pdo_mysql',
    'pdo_pgsql',
    'pdo_sqlite',
    'sockets',
    'sqlite3',
    'zip',
];

/**
 * The `php.ini` Genie writes into a version's directory.
 *
 * Written per version rather than shared: two PHP versions do not share an
 * `ext/` directory, so `extension_dir` has to point at THIS install's. That is
 * also the reason Genie does not borrow Herd's php — Herd's ini is Herd's to
 * rewrite, and a site whose config can change underneath it is not reproducible.
 */
export function phpIniContents(versionDir: string, platform: string): string {
    const extDir = joinFor(platform, versionDir, 'ext');
    const lines = [
        '; Genie-managed php.ini — rewritten when Genie reinstalls this version.',
        `; Owned by Genie: ${versionDir}`,
        '',
        `extension_dir = "${extDir}"`,
        '',
        ...PHP_INI_EXTENSIONS.map((e) => `extension=${e}`),
        '',
        '; opcache is OFF, and that is a fix rather than an omission.',
        '; `zend_extension=opcache` + `opcache.enable=1` makes php-cgi.exe DIE at',
        '; startup on Windows — "Fatal Error Opcode handlers are unusable due to',
        '; ASLR", exit 127 — and php-cgi is the binary the PHP serve mode spawns.',
        '; With `opcache.enable_cli=0` beside it, opcache was enabled for exactly',
        '; the one SAPI it kills and disabled for the one where it is harmless.',
        '; It can come back the day Genie also CREATES an `opcache.file_cache`',
        '; directory: with `file_cache` pointing at a directory that exists, plus',
        '; `file_cache_fallback=1`, php-cgi starts (verified) — pointing it at one',
        '; that does not exist changes nothing, because PHP will not create it.',
        '',
        '; Room for a real framework boot + a composer install.',
        'memory_limit = 512M',
        'max_execution_time = 120',
        'upload_max_filesize = 64M',
        'post_max_size = 64M',
        '',
        '; A dev machine wants to SEE the error, not a blank page.',
        'display_errors = On',
        'error_reporting = E_ALL',
        '',
    ];
    return lines.join('\n');
}

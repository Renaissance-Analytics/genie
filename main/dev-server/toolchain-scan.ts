import {
    LANGUAGE_TOOLS,
    engineCompanionExes,
    engineExeName,
    enginePrimaryBin,
    isLanguageTool,
    joinFor,
    sortInstalls,
    type EngineInstall,
    type EngineInstallSource,
    type LanguageTool,
} from './toolchain-versions';

/**
 * DISCOVERY — what language runtimes are on this machine, and who put them
 * there.
 *
 * Two populations, and the difference is the whole design:
 *
 *  - **Genie's own**, under `<userData>/toolchain/<lang>/<version>`. Selectable,
 *    removable, config included. These are what a site actually runs on.
 *  - **Everyone else's** — Herd, XAMPP, nvm, a system package. Found for
 *    AWARENESS: the page says "PHP 8.4 — Herd — not managed by Genie" so the
 *    machine is legible and nobody wonders why Genie installed its own. Never
 *    selectable, never removable, never the default.
 *
 * ## An install must PROVE itself
 *
 * A directory counts only when the real executables are inside it — the primary
 * binary AND its companions (`php-cgi` beside `php`). genie#206 is what happens
 * without that rule: PATH answered `php` with Herd's `php.bat` shim, Genie took
 * that as "php is installed", and the FastCGI worker then failed to find a
 * `php-cgi` that was never at that path in the first place. So a `.bat`/`.cmd`
 * PATH hit is classified as a SHIM and rejected, and a php directory without
 * `php-cgi` is not an install even though `php --version` would answer.
 *
 * ## Never claim what it cannot name
 *
 * A candidate whose version neither its directory name nor the binary itself can
 * report is DROPPED, not listed as "unknown". A row that cannot name its version
 * cannot be defaulted to, pinned to, or reasoned about.
 *
 * All filesystem access goes through the injected {@link ToolchainFs}, so every
 * layout above — including a Windows one — is asserted on any CI runner without
 * a single real directory.
 */

/** The filesystem seam. Every method is total: a missing path is an empty
 *  answer, never a throw. */
export interface ToolchainFs {
    /** Entry names directly inside a directory; `[]` when it does not exist. */
    listDir(dir: string): Promise<string[]>;
    /** True when a FILE (not a directory) exists at this path. */
    isFile(path: string): Promise<boolean>;
    /** Total bytes under a directory. Called for Genie-owned dirs only. */
    dirSize(dir: string): Promise<number>;
}

export interface ScanToolchainOptions {
    fs: ToolchainFs;
    platform: string;
    /** `<userData>/toolchain` — see `genieToolchainRoot`. */
    root: string;
    /**
     * `<userData>/tools` — where Genie's FIRST-RUN WIZARD used to install, one
     * flat directory per tool with no version in the name (genie#212).
     *
     * Scanned so an upgrading user's existing php/node is adopted rather than
     * orphaned: those are real installs Genie put there and paid disk for, and
     * a page that ignored them would be reporting "nothing installed" to someone
     * who watched Genie install something. The version has to come from the
     * BINARY, since the directory name does not carry one. Omitted ⇒ not
     * scanned, which is what a machine with no legacy directory wants.
     */
    legacyRoot?: string;
    home: string;
    env: Record<string, string | undefined>;
    /** Ask a binary for its version (`php --version`). Used only when the
     *  directory name does not carry one. */
    probeVersion(tool: LanguageTool, exe: string): Promise<string | undefined>;
    /** Resolve a bare bin name against PATH to an absolute path, or undefined.
     *  The result is CLASSIFIED before it is trusted — see {@link classifyPathHit}. */
    resolveOnPath(bin: string): Promise<string | undefined>;
}

// --- scan freshness ---------------------------------------------------------

/**
 * How long a scan stays good. A toolchain changes when someone installs
 * something, which is minutes-to-months apart — but `devServerChanged` fires on
 * every site start, stop and reconfigure, and each refresh spawns a
 * `where`/`which` per language and walks Genie's install directories. Long
 * enough that a busy workspace is not a process storm; short enough that an
 * install done outside Genie shows up without hunting for a button.
 */
const SCAN_TTL_MS = 60_000;

/**
 * Should the toolchain be re-scanned, or is the last answer still good?
 *
 * Not a poll — nothing runs on a timer. A page open (or an explicit Check
 * again) decides whether THIS moment does the work. Same shape as
 * `shouldCheckToolchainUpdates`, deliberately: two caches that behave
 * differently are two caches someone has to hold in their head.
 */
export function shouldRescanToolchain(opts: {
    lastScanAt: number | null;
    now: number;
    force?: boolean;
}): boolean {
    if (opts.force || opts.lastScanAt === null) return true;
    const age = opts.now - opts.lastScanAt;
    // A backwards clock (a resume, an NTP correction) would otherwise pin the
    // cache as "fresh" for as long as the jump lasted.
    return age < 0 || age >= SCAN_TTL_MS;
}

// --- pure parsing -----------------------------------------------------------

/**
 * Herd's `phpNN` directory → a version LINE.
 *
 * `php84` is 8.4, `php810` is 8.10. Two digits are the common case and the
 * split is "first digit is the major" — which is right for every PHP 5/7/8
 * directory Herd has ever produced. Anything else (`php`, `bin`, `php.bat`) is
 * not a version directory and returns undefined.
 */
export function parseHerdPhpDir(name: string): string | undefined {
    const m = /^php(\d)(\d+)$/i.exec(name);
    return m ? `${m[1]}.${Number.parseInt(m[2]!, 10)}` : undefined;
}

/** nvm's `v24.19.0` (or a bare `24.19.0`) → the version. */
export function parseNvmNodeDir(name: string): string | undefined {
    const m = /^v?(\d+\.\d+\.\d+)$/.exec(name);
    return m ? m[1] : undefined;
}

/**
 * Is a resolved PATH hit a real executable, or a SHIM that only forwards to one?
 *
 * On Windows a `.bat`/`.cmd` is a batch file whose directory contains no
 * runtime — Herd's `bin/php.bat` sits a level ABOVE the `php84` directory that
 * holds the real binaries. Treating it as an install is genie#206.
 */
export function classifyPathHit(resolved: string, platform: string): 'real' | 'shim' {
    if (platform !== 'win32') return 'real';
    return /\.(bat|cmd|ps1)$/i.test(resolved) ? 'shim' : 'real';
}

/** A place another installer keeps runtimes. */
export interface ForeignRoot {
    source: Exclude<EngineInstallSource, 'genie' | 'system'>;
    tool: LanguageTool;
    dir: string;
    /** `versioned` — each SUBDIRECTORY is a version (Herd, nvm).
     *  `single` — the directory IS one install (XAMPP). */
    kind: 'versioned' | 'single';
    /** For a `versioned` root: read the version out of a subdirectory name. */
    parse?: (name: string) => string | undefined;
}

/**
 * Where Genie looks for other installers' toolchains.
 *
 * Environment overrides come FIRST where the installer defines one (`NVM_HOME`,
 * `XAMPP_HOME`): a machine that moved its nvm to `D:\` is exactly the machine
 * where a hardcoded guess quietly reports nothing.
 */
export function foreignRoots(
    platform: string,
    home: string,
    env: Record<string, string | undefined>,
): ForeignRoot[] {
    const j = (...p: string[]) => joinFor(platform, ...p);
    const roots: ForeignRoot[] = [
        // Herd keeps `bin/phpNN` per version on every platform it supports.
        {
            source: 'herd',
            tool: 'php',
            dir: j(home, '.config', 'herd', 'bin'),
            kind: 'versioned',
            parse: parseHerdPhpDir,
        },
    ];

    if (platform === 'win32') {
        roots.push({
            source: 'xampp',
            tool: 'php',
            dir: j(env.XAMPP_HOME || 'C:\\xampp', 'php'),
            kind: 'single',
        });
        roots.push({
            source: 'nvm',
            tool: 'node',
            dir: env.NVM_HOME || j(home, 'AppData', 'Roaming', 'nvm'),
            kind: 'versioned',
            parse: parseNvmNodeDir,
        });
    } else {
        roots.push({
            source: 'nvm',
            tool: 'node',
            dir: env.NVM_DIR ? j(env.NVM_DIR, 'versions', 'node') : j(home, '.nvm', 'versions', 'node'),
            kind: 'versioned',
            parse: parseNvmNodeDir,
        });
    }
    return roots;
}

// --- the scan ---------------------------------------------------------------

/**
 * Does this directory hold the real executables for a tool, and where?
 *
 * Checks the directory itself and then `bin/` — the two layouts the official
 * archives produce (Windows unpacks flat, the posix tarballs and Go put
 * everything under `bin/`). Returns the exe path only when the primary binary
 * AND every companion is present, which is the genie#206 rule.
 */
async function locateExecutables(
    fs: ToolchainFs,
    dir: string,
    tool: LanguageTool,
    platform: string,
): Promise<{ dir: string; exe: string } | undefined> {
    const primary = engineExeName(tool, platform);
    const companions = engineCompanionExes(tool, platform);
    for (const candidate of [dir, joinFor(platform, dir, 'bin')]) {
        const exe = joinFor(platform, candidate, primary);
        if (!(await fs.isFile(exe))) continue;
        const complete = await Promise.all(
            companions.map((c) => fs.isFile(joinFor(platform, candidate, c))),
        );
        // A php with no php-cgi answers `--version` and cannot serve a request.
        if (!complete.every(Boolean)) continue;
        return { dir: candidate, exe };
    }
    return undefined;
}

/** Genie's own installs: `<root>/<lang>/<version>`, proven and sized. */
async function scanGenieInstalls(opts: ScanToolchainOptions): Promise<EngineInstall[]> {
    const { fs, platform, root } = opts;
    const out: EngineInstall[] = [];
    for (const name of await fs.listDir(root)) {
        if (!isLanguageTool(name)) continue;
        const toolDir = joinFor(platform, root, name);
        for (const version of await fs.listDir(toolDir)) {
            const versionDir = joinFor(platform, toolDir, version);
            const located = await locateExecutables(fs, versionDir, name, platform);
            if (!located) continue;
            out.push({
                tool: name,
                version,
                // The version DIRECTORY is what Remove deletes and what the size
                // describes — not the `bin/` subdir the exe happens to sit in.
                dir: versionDir,
                exe: located.exe,
                source: 'genie',
                removable: true,
                sizeBytes: await fs.dirSize(versionDir),
            });
        }
    }
    return out;
}

/**
 * Genie's OLD flat layout: `<userData>/tools/<lang>`, one directory per tool.
 *
 * Genie-owned (Genie installed it, so Genie may remove it) but not version-keyed
 * — the version is whatever the binary reports. Two Genie installs of the same
 * language can therefore coexist during an upgrade, one per layout; they are
 * different directories, so they are honestly two rows rather than a merge that
 * would have to guess which one a site is running.
 */
async function scanLegacyInstalls(opts: ScanToolchainOptions): Promise<EngineInstall[]> {
    const { fs, platform, legacyRoot } = opts;
    if (!legacyRoot) return [];
    const out: EngineInstall[] = [];
    for (const name of await fs.listDir(legacyRoot)) {
        if (!isLanguageTool(name)) continue;
        const dir = joinFor(platform, legacyRoot, name);
        const located = await locateExecutables(fs, dir, name, platform);
        if (!located) continue;
        const version = await opts.probeVersion(name, located.exe);
        // Same refusal as everywhere else: a row that cannot name its version
        // cannot be defaulted to or pinned to, so it is dropped, not guessed at.
        if (!version) continue;
        out.push({
            tool: name,
            version,
            dir: located.dir,
            exe: located.exe,
            source: 'genie',
            removable: true,
            sizeBytes: await fs.dirSize(located.dir),
        });
    }
    return out;
}

/** One candidate directory → an install, or nothing. Shared by every foreign
 *  source so the "prove it, then name it" rule is written once. */
async function foreignInstall(
    opts: ScanToolchainOptions,
    tool: LanguageTool,
    dir: string,
    source: EngineInstallSource,
    versionFromName: string | undefined,
): Promise<EngineInstall | undefined> {
    const located = await locateExecutables(opts.fs, dir, tool, opts.platform);
    if (!located) return undefined;
    // The directory name is cheaper and more reliable than spawning; ask the
    // binary only when the name says nothing (XAMPP's bare `php`).
    const version = versionFromName ?? (await opts.probeVersion(tool, located.exe));
    if (!version) return undefined;
    return {
        tool,
        version,
        dir: located.dir,
        exe: located.exe,
        source,
        // Someone else's install. Genie does not delete other apps' files.
        removable: false,
    };
}

async function scanForeignInstalls(opts: ScanToolchainOptions): Promise<EngineInstall[]> {
    const out: EngineInstall[] = [];
    for (const root of foreignRoots(opts.platform, opts.home, opts.env)) {
        if (root.kind === 'single') {
            const found = await foreignInstall(opts, root.tool, root.dir, root.source, undefined);
            if (found) out.push(found);
            continue;
        }
        for (const name of await opts.fs.listDir(root.dir)) {
            const version = root.parse?.(name);
            if (!version) continue;
            const found = await foreignInstall(
                opts,
                root.tool,
                joinFor(opts.platform, root.dir, name),
                root.source,
                version,
            );
            if (found) out.push(found);
        }
    }
    return out;
}

/** A language whose binary is simply on PATH, in a directory no known installer
 *  owns. Only counts when PATH points at a REAL executable, never a shim. */
async function scanSystemInstalls(opts: ScanToolchainOptions): Promise<EngineInstall[]> {
    const out: EngineInstall[] = [];
    for (const tool of LANGUAGE_TOOLS) {
        const resolved = await opts.resolveOnPath(enginePrimaryBin(tool));
        if (!resolved || classifyPathHit(resolved, opts.platform) === 'shim') continue;
        const dir = resolved.slice(0, Math.max(resolved.lastIndexOf('\\'), resolved.lastIndexOf('/')));
        if (!dir) continue;
        const found = await foreignInstall(opts, tool, dir, 'system', undefined);
        if (found) out.push(found);
    }
    return out;
}

/**
 * Everything on this machine, Genie's first.
 *
 * De-duplicated by DIRECTORY: Genie puts its default on PATH, so a naive PATH
 * scan would report Genie's own node a second time as a "system" install — two
 * rows for one directory, one of them claiming to be unmanaged.
 */
export async function scanToolchain(opts: ScanToolchainOptions): Promise<EngineInstall[]> {
    const genie = await scanGenieInstalls(opts);
    const legacy = await scanLegacyInstalls(opts);
    const foreign = await scanForeignInstalls(opts);
    const system = await scanSystemInstalls(opts);

    const seen = new Set<string>();
    const merged: EngineInstall[] = [];
    // Version-keyed installs first: where the same bytes are reachable by both
    // layouts, the row that survives is the one the rest of the model can pin.
    for (const i of [...genie, ...legacy, ...foreign, ...system]) {
        const key = `${i.tool}|${i.dir.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(i);
    }
    return sortInstalls(merged);
}

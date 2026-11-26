import { PHP_RECIPES, compareVersionsDesc, type PhpPlatform } from './php-versions.js';

/**
 * PHP'S LIVE RELEASE DATA (Tynn #1066, hotfix) — the pure half.
 *
 * The owner, 2026-11-26: "we don't want critical security updates being held behind genie upgrades … it's the 8.4.x and
 * other updates in that line that need to be updated". Until then the versions Genie offered were PHP_RECIPES, fixed per
 * Genie release, and the security floor was core/php-advisories.ts, fixed too: php.net shipped 8.4.28 as a security
 * release on 2026-11-19 and no Genie could install it.
 *
 * Now the CATALOG — per supported line, the newest patch Genie can install here and the newest SECURITY release — is read
 * from php.net at run time (main/php-release-feed.ts fetches, with a cache and a timeout):
 *
 * - `https://www.php.net/releases/index.php?json&version=8`: the newest 8.x release, with `supported_versions` — the
 *   lines php.net still supports. Only those are offered (windows.php.net still lists 7.4, 8.0 and 8.1).
 * - `…?json&version=<line>&max=10`: that line's releases, newest first, each with `tags` — `"security"` marks a security
 *   release (measured 2026-11-25: 8.4.28 `tags: ["security"]`, 8.6.0 `tags: []`).
 * - windows.php.net's `releases.json`: each line's CURRENT Windows build. On Windows the newest patch offered is that
 *   build (the only one with a published sha256 — main/php-versions.ts installs nothing unverified); on Linux it is
 *   php.net's newest, built from its source by the existing recipe.
 *
 * The baked list is the MINIMUM: the catalog never offers a version below the one this release bakes in for that line,
 * and the baked floor (PHP_ADVISORIES) is always applied beside the live one (php-advisories.ts). Offline, or when
 * nothing usable came back, it IS the baked list.
 */

/** A PHP security patch Genie installed, or could not (main/php-patch-keeper.ts): `genie:php-patch:<line>`. */
export const PHP_PATCH_DECK_PREFIX = 'genie:php-patch:';

export const PHP_NET_SUPPORTED_JSON = 'https://www.php.net/releases/index.php?json&version=8';

/** php.net's releases of one line, newest first: what says which are security releases. */
export function phpNetLineJson(line: string): string {
    return `https://www.php.net/releases/index.php?json&version=${line}&max=10`;
}

export interface PhpCatalogLine {
    /** `8.4`. */
    readonly line: string;
    /** The newest patch of this line Genie can install here. */
    readonly newest: string;
    /** php.net's newest SECURITY release of this line, from the live data; `null` when unknown (baked, or not read). */
    readonly securityFloor: string | null;
}

export interface PhpCatalog {
    /** `live` once php.net answered; `baked` = this Genie release's own list. */
    readonly source: 'live' | 'baked';
    /** When the live data was read (ms since epoch); `null` for the baked list. */
    readonly at: number | null;
    /** Newest line first. */
    readonly lines: readonly PhpCatalogLine[];
}

const FULL = /^\d+\.\d+\.\d+$/;
const LINE = /^\d+\.\d+$/;
const NTS_X64 = /^nts-vs[0-9]+-x64$/;

export const lineOf = (version: string): string => version.split('.').slice(0, 2).join('.');
const newer = (a: string, b: string): boolean => compareVersionsDesc(a, b) < 0;
const maxOf = (a: string, b: string): string => (newer(a, b) ? a : b);
const linesDesc = (a: string, b: string): number => compareVersionsDesc(`${a}.0`, `${b}.0`);

function json(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * windows.php.net's releases.json → line → the version of its current NTS x64 build. A re-issue (`8.4.27-1`) is the PHP
 * it is (`8.4.27`). A line with no `nts-vsNN-x64` build (7.4 is `nts-vc15-x64`) is left out: Genie installs none of them.
 * `null` when the text is not that file (a redirect page, an error).
 */
export function parseWindowsReleaseLines(text: string): Record<string, string> | null {
    const parsed = json(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [line, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (!LINE.test(line) || typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        const version = typeof e['version'] === 'string' ? e['version'].replace(/-\d+$/, '') : '';
        if (!FULL.test(version) || lineOf(version) !== line) continue;
        if (!Object.keys(e).some((k) => NTS_X64.test(k))) continue;
        out[line] = version;
    }
    return out;
}

/** php.net's `?json&version=8` → its `supported_versions` (`["8.2", …]`), or `null`. */
export function parsePhpNetSupported(text: string): string[] | null {
    const parsed = json(text) as { supported_versions?: unknown } | null;
    const list = parsed?.supported_versions;
    if (!Array.isArray(list)) return null;
    const lines = list.filter((l): l is string => typeof l === 'string' && LINE.test(l));
    return lines.length > 0 ? lines.sort(linesDesc) : null;
}

/**
 * php.net's releases of `line` → its newest release and its newest SECURITY release (`tags` holds `"security"`). Only
 * entries of that line count; `null` when there are none.
 */
export function parsePhpNetLine(text: string, line: string): { newest: string; newestSecurity: string | null } | null {
    const parsed = json(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const releases = Object.entries(parsed as Record<string, unknown>).flatMap(([version, r]) => {
        if (!FULL.test(version) || lineOf(version) !== line || typeof r !== 'object' || r === null) return [];
        const tags = (r as { tags?: unknown }).tags;
        return [{ version, security: Array.isArray(tags) && tags.includes('security') }];
    }).sort((a, b) => compareVersionsDesc(a.version, b.version));
    if (releases.length === 0) return null;
    return { newest: releases[0]!.version, newestSecurity: releases.find((r) => r.security)?.version ?? null };
}

/** This Genie release's own list: PHP_RECIPES, no live floor. */
export function bakedPhpCatalog(): PhpCatalog {
    return { source: 'baked', at: null, lines: PHP_RECIPES.map((r) => ({ line: lineOf(r.version), newest: r.version, securityFloor: null })) };
}

export interface PhpCatalogInput {
    readonly platform: PhpPlatform;
    readonly at: number;
    /** windows.php.net's lines (parseWindowsReleaseLines); `null` = not read. Used on Windows. */
    readonly windows: Record<string, string> | null;
    /** php.net's supported lines; `null` = not read. */
    readonly supported: readonly string[] | null;
    /** php.net's releases per line (parsePhpNetLine); a line absent or `null` = not read. */
    readonly lines: Readonly<Record<string, { newest: string; newestSecurity: string | null } | null>>;
}

/**
 * THE CATALOG from what came back. Which lines: php.net's supported ones; when that was not read, the baked lines plus
 * any NEWER line the other data names (a new 8.6 is offered, an old 8.1 never is). Each line's newest: on Windows the
 * build windows.php.net lists, elsewhere php.net's newest — never below the baked version of that line. Nothing usable
 * (no live newest and no live floor for any line) = the baked catalog.
 */
export function buildPhpCatalog(input: PhpCatalogInput): PhpCatalog {
    const baked = new Map(PHP_RECIPES.map((r) => [lineOf(r.version), r.version]));
    const liveNewest = (line: string): string | null => (input.platform === 'win32' ? input.windows?.[line] ?? null : input.lines[line]?.newest ?? null);
    let lines: string[];
    if (input.supported !== null && input.supported.length > 0) {
        lines = [...input.supported];
    } else {
        const top = [...baked.keys()].sort(linesDesc)[0] ?? '0.0';
        const named = [...Object.keys(input.windows ?? {}), ...Object.keys(input.lines)].filter((l) => LINE.test(l) && linesDesc(l, top) < 0);
        lines = [...new Set([...baked.keys(), ...named])];
    }
    let live = false;
    const out: PhpCatalogLine[] = [];
    for (const line of lines.sort(linesDesc)) {
        const fromFeed = liveNewest(line);
        const bakedV = baked.get(line) ?? null;
        const newest = fromFeed !== null && bakedV !== null ? maxOf(fromFeed, bakedV) : fromFeed ?? bakedV;
        if (newest === null) continue;
        const securityFloor = input.lines[line]?.newestSecurity ?? null;
        if (fromFeed !== null || securityFloor !== null) live = true;
        out.push({ line, newest, securityFloor });
    }
    if (!live || out.length === 0) return bakedPhpCatalog();
    return { source: 'live', at: input.at, lines: out };
}

/** The versions the catalog installs: the newest of each line, newest first. */
export function catalogVersions(catalog: PhpCatalog): string[] {
    return catalog.lines.map((l) => l.newest);
}

export function catalogLine(catalog: PhpCatalog, line: string): PhpCatalogLine | null {
    return catalog.lines.find((l) => l.line === line) ?? null;
}

/** A catalog read back from where the feed stored it, or `null` when the text is not one. */
export function parseStoredCatalog(text: string | null): PhpCatalog | null {
    if (text === null) return null;
    const parsed = json(text) as Partial<PhpCatalog> | null;
    if (parsed?.source !== 'live' || typeof parsed.at !== 'number' || !Array.isArray(parsed.lines)) return null;
    const lines = parsed.lines.filter((l): l is PhpCatalogLine => typeof l === 'object' && l !== null && LINE.test(String(l.line)) && FULL.test(String(l.newest))
        && lineOf(l.newest) === l.line && (l.securityFloor === null || (FULL.test(String(l.securityFloor)) && lineOf(String(l.securityFloor)) === l.line)));
    if (lines.length === 0) return null;
    // A stored catalog is still held to this release's minimum.
    const baked = new Map(PHP_RECIPES.map((r) => [lineOf(r.version), r.version]));
    return { source: 'live', at: parsed.at, lines: lines.map((l) => ({ line: l.line, newest: baked.has(l.line) ? maxOf(l.newest, baked.get(l.line)!) : l.newest, securityFloor: l.securityFloor })).sort((a, b) => linesDesc(a.line, b.line)) };
}

/**
 * THE CATALOG THIS PROCESS USES. One per process, set by the feed when php.net answers (main/php-release-feed.ts):
 * the installer, the Toolchain list, the probe's security badge and the update choices all read it, so a refresh reaches
 * every one of them at once. Until then, and offline, it is the baked list.
 */
let current: PhpCatalog = bakedPhpCatalog();

export function currentPhpCatalog(): PhpCatalog {
    return current;
}

export function setPhpCatalog(catalog: PhpCatalog): void {
    current = catalog;
}

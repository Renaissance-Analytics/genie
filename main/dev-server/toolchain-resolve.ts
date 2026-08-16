import type { AdapterContext, DirectSource } from './toolchain-adapters';
import type { HostToolName } from './toolchain-detect';
import { compareVersionsDesc, recipesFor, versionLine } from './toolchain-versions';

/**
 * Resolve a versioned direct-download {@link DirectSource} to a concrete URL.
 *
 * git / node / php on Windows ship only versioned assets — there is no fixed
 * "latest" file to link — so the adapters emit `url: null` + a `source` and defer
 * to this. The PARSING of a vendor index into a URL is pure, so it is tested with
 * an injected {@link FetchJson}; the one impure thing (the HTTP GET) is the seam.
 *
 * Never throws — a failed resolve is `null`. What the caller does with a null is
 * the other half of the contract: {@link resolveFailureHelp} turns it into a
 * sentence that names the index Genie asked and what to do instead, because
 * "could not resolve a download url" is where the owner's clean-machine run
 * dead-ended (genie#209).
 */

/** Fetch a URL and parse it as JSON. The injected seam. */
export type FetchJson = (url: string) => Promise<unknown>;

/** Node's `process.arch` mapped onto the vendors' download vocabulary. */
function nodeArch(arch: string | undefined): 'x64' | 'arm64' {
    return arch === 'arm64' ? 'arm64' : 'x64';
}

export async function resolveDownloadUrl(
    source: DirectSource,
    ctx: AdapterContext,
    fetchJson: FetchJson,
): Promise<string | null> {
    try {
        switch (source) {
            // `await` inside the try so a rejected fetch is caught here (a bare
            // `return promise` would settle after the try and escape the catch).
            case 'git-for-windows':
                return await resolveGitForWindows(ctx, fetchJson);
            case 'nodejs-dist':
                return await resolveNodejsDist(ctx, fetchJson);
            case 'php-windows':
                return await resolvePhpWindows(ctx, fetchJson);
        }
    } catch {
        return null;
    }
}

/**
 * What a user should DO about a resolve that returned null, per source.
 *
 * A failure that only says it failed sends a person to a search engine. Each of
 * these names the index Genie asked, the reason it could come up empty, and the
 * way past it — including doing it by hand, which is always available.
 */
export function resolveFailureHelp(source: DirectSource, tool: HostToolName): string {
    switch (source) {
        case 'git-for-windows':
            return (
                'The git-for-windows release index (api.github.com) returned no installer for this machine. ' +
                `Check your network or proxy and run setup again, or install ${tool} yourself and re-run detection.`
            );
        case 'nodejs-dist':
            return (
                'The release index at nodejs.org/dist returned no current LTS build for this machine. ' +
                `Check your network or proxy and run setup again, or install ${tool} yourself and re-run detection.`
            );
        case 'php-windows':
            return (
                "The windows.php.net release index had no 64-bit non-thread-safe build Genie can install " +
                '(that is the build carrying php-cgi.exe, which the PHP serve mode needs), and it publishes no arm64 build at all. ' +
                `Check your network or proxy and run setup again, or install ${tool} yourself and re-run detection.`
            );
    }
}

// --- git for windows -------------------------------------------------------

const GIT_FOR_WINDOWS_LATEST =
    'https://api.github.com/repos/git-for-windows/git/releases/latest';

interface GitHubRelease {
    assets?: { name?: string; browser_download_url?: string }[];
}

/** Pick the standalone `.exe` installer for the machine's bitness. Prefers the
 *  64-bit build; falls back to 32-bit; ignores the portable/7z archives. */
async function resolveGitForWindows(ctx: AdapterContext, fetchJson: FetchJson): Promise<string | null> {
    const release = (await fetchJson(GIT_FOR_WINDOWS_LATEST)) as GitHubRelease;
    const assets = release?.assets ?? [];
    const isInstaller = (name: string, bits: '64' | '32') =>
        /^Git-.*\.exe$/i.test(name) && name.includes(`${bits}-bit`);
    const want: ('64' | '32')[] = nodeArch(ctx.arch) === 'arm64' ? ['64', '32'] : ['64', '32'];
    for (const bits of want) {
        const hit = assets.find((a) => a.name && a.browser_download_url && isInstaller(a.name, bits));
        if (hit?.browser_download_url) return hit.browser_download_url;
    }
    return null;
}

// --- node ------------------------------------------------------------------

const NODEJS_INDEX = 'https://nodejs.org/dist/index.json';

interface NodeRelease {
    version?: string;
    /** `false` for a non-LTS line, or the codename string for an LTS one. */
    lts?: string | false;
}

/** Build the latest-LTS Windows zip URL. The index is newest-first, so the first
 *  entry whose `lts` is a codename is the current LTS. */
async function resolveNodejsDist(ctx: AdapterContext, fetchJson: FetchJson): Promise<string | null> {
    const index = (await fetchJson(NODEJS_INDEX)) as NodeRelease[];
    const lts = Array.isArray(index) ? index.find((r) => r.version && r.lts) : undefined;
    if (!lts?.version) return null;
    return `https://nodejs.org/dist/${lts.version}/node-${lts.version}-win-${nodeArch(ctx.arch)}.zip`;
}

// --- php on windows --------------------------------------------------------

/**
 * windows.php.net's machine index: one entry per release LINE (`"8.4"`), each
 * carrying its current patch `version` and a build per
 * `{ts|nts}-{toolset}-{arch}`. The URL 302s to downloads.php.net; the fetch seam
 * follows redirects.
 */
const PHP_WINDOWS_INDEX = 'https://windows.php.net/downloads/releases/releases.json';
const PHP_WINDOWS_BASE = 'https://windows.php.net/downloads/releases/';

/**
 * Build the current PHP zip URL for this machine.
 *
 * Two decisions, and neither is guesswork:
 *
 *   - **the LINE is capped** at the newest php {@link recipesFor this release
 *     ships a recipe for}. The owner's rule for the version pick-list — *"each
 *     release will include what we know we can support"* — is the same rule here;
 *     it also means the wizard and the Toolchain Manager install the same PHP
 *     rather than two tables drifting apart.
 *   - **the PATCH is live.** windows.php.net MOVES a release into `archives/`
 *     the day a patch supersedes it, so a pinned patch 404s on release day; the
 *     index always names the file currently sitting at the releases root.
 *
 * The build is the 64-bit NON-thread-safe one. NTS is the FastCGI build and its
 * archive carries `php-cgi.exe` — genie#206 was exactly that binary's absence.
 *
 * Which machines can have php AT ALL is the recipe table's call and is not
 * second-guessed here: windows.php.net publishes no arm64 build, so `recipesFor`
 * offers nothing there and this returns null without asking the index. One rule,
 * one place — a duplicate arch check here would be the thing that refuses an
 * arm64 build on the day one starts shipping.
 */
async function resolvePhpWindows(ctx: AdapterContext, fetchJson: FetchJson): Promise<string | null> {
    const newestSupported = newestSupportedPhpLine(ctx);
    if (!newestSupported) return null;

    const index = await fetchJson(PHP_WINDOWS_INDEX);
    if (!index || typeof index !== 'object' || Array.isArray(index)) return null;

    // Newest first, never above the supported line. Older lines stay in play so
    // a line whose build is temporarily missing falls back rather than failing.
    const lines = Object.keys(index as Record<string, unknown>)
        .filter((k) => /^\d+\.\d+$/.test(k) && compareVersionsDesc(k, newestSupported) >= 0)
        .sort(compareVersionsDesc);

    for (const line of lines) {
        const path = ntsX64ZipPath((index as Record<string, unknown>)[line]);
        if (path) return PHP_WINDOWS_BASE + path;
    }
    return null;
}

/** The newest php LINE this release of Genie has a recipe for on this machine. */
function newestSupportedPhpLine(ctx: AdapterContext): string | undefined {
    const newest = recipesFor('php', {
        os: String(ctx.os),
        ...(ctx.arch ? { arch: String(ctx.arch) } : {}),
    })[0];
    return newest ? versionLine('php', newest.version) : undefined;
}

/**
 * The 64-bit non-thread-safe zip inside one release-line entry.
 *
 * The toolset token is READ from the key (`nts-vs17-x64`) rather than assumed,
 * so the line that eventually ships `vs18` resolves without a code change. A
 * vendor index is still untrusted input: only a plain archive FILENAME is
 * accepted, never a path that could climb out of the releases directory.
 */
function ntsX64ZipPath(entry: unknown): string | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
        if (!/^nts-[\w.]+-x64$/.test(key)) continue;
        const path = (value as { zip?: { path?: string } })?.zip?.path;
        if (typeof path === 'string' && /^[\w.+-]+\.zip$/.test(path)) return path;
    }
    return undefined;
}

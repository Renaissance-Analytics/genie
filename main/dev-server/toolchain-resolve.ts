import type { AdapterContext, DirectSource } from './toolchain-adapters';

/**
 * Resolve a versioned direct-download {@link DirectSource} to a concrete URL.
 *
 * git / node / php on Windows ship only versioned assets — there is no fixed
 * "latest" file to link — so the adapters emit `url: null` + a `source` and defer
 * to this. The PARSING of a vendor index into a URL is pure, so it is tested with
 * an injected {@link FetchJson}; the one impure thing (the HTTP GET) is the seam.
 *
 * Never throws — a failed resolve is `null`, which the executor turns into a
 * per-tool failure, never a crash. A source with no reliable machine index yet
 * (php-windows) is a deliberate `null` rather than a fabricated URL that rots.
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
                // No stable machine index on windows.php.net; php on Windows is
                // normally Herd's (detected + reused), so this is an honest null.
                return null;
        }
    } catch {
        return null;
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

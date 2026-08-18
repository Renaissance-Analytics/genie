/**
 * PURE. Where a TOOL's binary came from, read off its resolved path (genie#213).
 *
 * The Toolchain page has two halves with two models. Language rows come from
 * `scanToolchain`, so each can say who installed it and which directory it is —
 * that is what makes "which php is this?" answerable on a machine carrying
 * three. Tool rows (git, docker, composer, claude-code, codex) come from the
 * `ToolUpdate` path and carry a name and two version numbers, so the same
 * questions have no answer for half the screen.
 *
 * #213 weighs two fixes. The larger one widens the per-version scan to cover
 * these tools; but they are genuinely single-version, install-once things, and
 * that model exists because LANGUAGES need pinning — forcing them into it adds
 * ceremony for no gain. This is the smaller one: the two missing facts, derived
 * from the path the probe already resolves.
 *
 * MANAGED vs DETECTED is the distinction that carries weight. Genie can update
 * what it installed; it must not offer to update a Docker that winget owns, nor
 * list it as if the two were the same kind of thing. Naming the foreign
 * installer sits on top of that as best-effort — a path either says or it does
 * not, and when it does not the answer is `unknown` rather than a guess that
 * will read as fact in a support thread.
 */

/** Who put the binary there, as far as its path can say. */
export type ToolInstallSource =
    | 'genie'
    | 'winget'
    | 'program-files'
    | 'homebrew'
    | 'npm-global'
    | 'system'
    | 'unknown';

export interface ToolInstallOrigin {
    /** True only for a binary inside Genie's own toolchain root — i.e. the ones
     *  Genie may update. */
    managedByGenie: boolean;
    source: ToolInstallSource;
    /** The directory holding the binary. Absent when nothing resolved. Reported
     *  even when the source is `unknown`: it is the whole answer to "which git
     *  answered?", which is most of the reason this exists. */
    directory?: string;
}

export interface OriginContext {
    platform: string;
    home: string;
    /** Genie's toolchain root — `genieToolchainRoot(userDataDir(), platform)`. */
    genieRoot: string;
}

const UNRESOLVED: ToolInstallOrigin = { managedByGenie: false, source: 'unknown' };

/** Compare paths the way the platform does: Windows is case-insensitive, so the
 *  SAME install reached through a differently-cased PATH entry must not read as
 *  a foreign one — Genie would then offer to install a second copy of it. */
function normalize(p: string, platform: string): string {
    const slashed = p.replace(/\\/g, '/');
    return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** Is `child` inside `parent`? Compares on a separator boundary, so
 *  `…/toolchain-backup` is not mistaken for a child of `…/toolchain`. */
function within(child: string, parent: string, platform: string): boolean {
    if (!parent) return false;
    const c = normalize(child, platform);
    const p = normalize(parent, platform).replace(/\/+$/, '');
    return c === p || c.startsWith(`${p}/`);
}

/** The directory holding the binary, in the platform's own separator. */
function dirnameFor(resolved: string, platform: string): string {
    const sep = platform === 'win32' ? '\\' : '/';
    const cut = Math.max(resolved.lastIndexOf('\\'), resolved.lastIndexOf('/'));
    return cut <= 0 ? resolved : resolved.slice(0, cut).replace(/[\\/]+$/, '') || sep;
}

/** Best-effort: which installer's territory does this path sit in? Ordered
 *  most-specific first — an npm global directory under AppData\Roaming must not
 *  be claimed by a broader Windows rule. */
function classify(resolved: string, ctx: OriginContext): ToolInstallSource {
    const p = normalize(resolved, ctx.platform);
    const home = normalize(ctx.home, ctx.platform);

    // npm's global bin, on either platform's default and the common override.
    if (
        p.includes('/appdata/roaming/npm/') ||
        p.includes('/.npm-global/') ||
        p.includes('/npm/bin/') ||
        p.includes('/lib/node_modules/.bin/')
    ) {
        return 'npm-global';
    }

    if (ctx.platform === 'win32') {
        if (p.includes('/microsoft/winget/')) return 'winget';
        if (p.startsWith('c:/program files')) return 'program-files';
        return 'unknown';
    }

    // Homebrew: the Apple-silicon prefix, the Intel prefix, and the Cellar the
    // symlinks in those prefixes point into (a resolved path may be either).
    if (p.startsWith('/opt/homebrew/') || p.startsWith('/usr/local/cellar/') || p.startsWith('/usr/local/Cellar/')) {
        return 'homebrew';
    }
    if (p.startsWith('/usr/bin/') || p.startsWith('/bin/') || p.startsWith('/usr/sbin/')) return 'system';
    // A hand-rolled location under $HOME says nothing about who put it there.
    if (home && p.startsWith(`${home}/`)) return 'unknown';
    return 'unknown';
}

/**
 * Classify a resolved binary path. Never throws; an unresolved probe (the tool
 * is missing, or `where`/`which` failed) reports nothing rather than inventing a
 * location — a version check must not be able to crash the panel that renders
 * it, and neither must this.
 */
export function toolInstallOrigin(
    resolved: string | undefined,
    ctx: OriginContext,
): ToolInstallOrigin {
    if (!resolved) return UNRESOLVED;

    const directory = dirnameFor(resolved, ctx.platform);
    if (within(resolved, ctx.genieRoot, ctx.platform)) {
        return { managedByGenie: true, source: 'genie', directory };
    }
    return { managedByGenie: false, source: classify(resolved, ctx), directory };
}

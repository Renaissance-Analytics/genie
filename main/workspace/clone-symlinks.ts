import { AGENT_DOC_FILES } from '../mcp/agent-config';

/**
 * PURE (but for an injected filesystem). Cloning a repo that contains SYMLINKS
 * on a platform that cannot create them — genie#214.
 *
 * ## What broke
 *
 * A `.agi` envelope keeps `CLAUDE.md` as a symlink to `AGENTS.md`. Creating a
 * symlink on Windows requires Developer Mode or elevation, and without it git
 * does not skip the file — it fails the entire checkout:
 *
 *   error: unable to create symlink CLAUDE.md: Filename too long
 *   fatal: unable to checkout working tree
 *   warning: Clone succeeded, but checkout failed.
 *
 * The repository is on disk with an EMPTY working tree, so adding the workspace
 * fails outright. ("Filename too long" is git's misleading rendering of the
 * failed symlink call; the path is fine.)
 *
 * ## The two halves
 *
 * `core.symlinks=false` is git's own switch for this: it checks each symlink out
 * as an ORDINARY FILE whose content is the link target. That alone turns a fatal
 * checkout into a working tree — but leaves a `CLAUDE.md` whose entire contents
 * are the string `AGENTS.md`, and Claude Code would load exactly that as the
 * workspace's instructions. So the placeholder is then MATERIALISED into the
 * real document.
 *
 * This is the same conclusion the workspace already reached for its own docs —
 * on platforms without working symlinks Genie keeps `AGENTS.md` and `CLAUDE.md`
 * byte-identical rather than linked — applied at the moment a repo arrives.
 */

/** The filesystem this needs, injected so every branch is testable without one. */
export interface CloneFs {
    /** File contents, or null when the file is not there. */
    read(path: string): Promise<string | null>;
    write(path: string, body: string): Promise<void>;
    /** Byte length, or -1 when absent. */
    size(path: string): Promise<number>;
}

/**
 * A symlink placeholder is SHORT. Git writes exactly the link target, so a real
 * document never fits — this bounds "could this be a link target?" before any
 * content is compared, so a large file is never even considered.
 */
const MAX_PLACEHOLDER_BYTES = 512;

/**
 * Extra `-c` config for a clone on this platform.
 *
 * Only Windows gets `core.symlinks=false`. macOS and Linux create symlinks
 * natively, and forcing it there would turn a working link into a stray text
 * file for no reason.
 */
export function cloneConfigFor(platform: NodeJS.Platform | string): string[] {
    return platform === 'win32' ? ['core.symlinks=false'] : [];
}

export interface MaterializeResult {
    /** Which doc files were replaced with their target's real content. */
    materialized: string[];
}

/**
 * Turn agent-doc symlink PLACEHOLDERS into the real document.
 *
 * Scoped deliberately to {@link AGENT_DOC_FILES} rather than walking the tree
 * for anything that looks like a link: a general "materialise every symlink"
 * would rewrite files this has no business touching, and these two are the ones
 * that actually break an agent when they arrive as a one-line stub.
 *
 * A file is only treated as a placeholder when ALL of these hold:
 *   - it is small enough to be a path;
 *   - its entire content is a single line with no whitespace;
 *   - that line names one of the OTHER agent docs; and
 *   - that named file exists and has content.
 *
 * Anything else is somebody's real document and is left alone — the one outcome
 * worth being paranoid about, since the repair overwrites a file.
 */
export async function materializeAgentDocLinks(
    repoPath: string,
    platform: NodeJS.Platform | string,
    fx: CloneFs,
): Promise<MaterializeResult> {
    // Elsewhere the checkout produced REAL symlinks. Reading one already returns
    // the target's content, and writing to it would replace the link with a copy.
    if (platform !== 'win32') return { materialized: [] };

    const sep = '\\';
    const docs = Object.values(AGENT_DOC_FILES);
    const materialized: string[] = [];

    for (const name of docs) {
        const full = `${repoPath}${sep}${name}`;
        const bytes = await fx.size(full);
        if (bytes < 0 || bytes > MAX_PLACEHOLDER_BYTES) continue;

        const body = await fx.read(full);
        if (body === null) continue;

        const candidate = body.trim();
        // A link target is one bare path. Any whitespace inside means prose.
        if (!candidate || /\s/.test(candidate)) continue;
        // …and it must name one of the other docs, not itself.
        if (candidate === name || !docs.includes(candidate)) continue;

        const target = await fx.read(`${repoPath}${sep}${candidate}`);
        if (target === null || target.length === 0) continue;

        await fx.write(full, target);
        materialized.push(name);
    }

    return { materialized };
}

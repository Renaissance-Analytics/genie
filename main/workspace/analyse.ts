import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Detect the shape of a workspace folder so the upgrade wizard can
 * present a planning UI. We never mutate the source folder — we just
 * read its top-level layout, peek into git metadata, and suggest where
 * each thing might go inside a fresh `{slug}.agi` envelope.
 *
 *   - `repos`     — directories with a `.git/` inside; candidates for
 *                   `repos/<rename>/` submodules.
 *   - `knowledge` — directories whose name matches a known knowledge
 *                   convention (plans, docs, notes, k, .ai, chats,
 *                   memory, issues, pm) OR loose `.md` / `.txt` / `.rst`
 *                   files at the root.
 *   - `other`     — everything else, shown for context but never
 *                   selected by default.
 */

export interface AnalyseRepoCandidate {
    rel_path: string;
    abs_path: string;
    /** Suggested name for the submodule directory inside `repos/`. */
    default_name: string;
    /** `git config remote.origin.url`, if the repo has one. */
    origin_url: string | null;
    /** `git rev-parse --abbrev-ref HEAD` (e.g. "main"). */
    head_ref: string | null;
}

export interface AnalyseKnowledgeCandidate {
    rel_path: string;
    abs_path: string;
    kind: 'file' | 'directory';
    /** Suggested subdir inside `.ai/`. Empty string = land at `.ai/` root. */
    suggested_target: string;
    size?: number;
}

export interface AnalyseOtherEntry {
    rel_path: string;
    kind: 'file' | 'directory';
}

/**
 * What the source folder fundamentally IS — drives the wizard's framing:
 *
 *   - 'single-repo'     — the folder itself is one git repo (monorepos
 *                          included: one .git = one repo = one submodule).
 *   - 'repo-collection' — no root .git, but one or more subfolders are
 *                          git repos; each becomes its own submodule.
 *   - 'plain-folder'    — no git anywhere at the top level. Knowledge
 *                          can still move into the envelope.
 */
export type SourceKind = 'single-repo' | 'repo-collection' | 'plain-folder';

export interface AnalyseResult {
    root: string;
    source_kind: SourceKind;
    repos: AnalyseRepoCandidate[];
    knowledge: AnalyseKnowledgeCandidate[];
    other: AnalyseOtherEntry[];
}

/**
 * Map of known top-level dir names → suggested target inside `.ai/`.
 * Lower-cased lookup. Empty-string target means "land directly at the
 * root of `.ai/`" rather than under a subdir.
 */
const KNOWLEDGE_DIR_MAP: Record<string, string> = {
    plans: 'plans',
    plan: 'plans',
    knowledge: 'knowledge',
    docs: 'knowledge',
    wiki: 'knowledge',
    notes: 'knowledge',
    pm: 'pm',
    chat: 'chat',
    chats: 'chat',
    memory: 'memory',
    memories: 'memory',
    issues: 'issues',
    bugs: 'issues',
    // Aliases for the knowledge root itself — these get spread into .ai/
    'k': '',
    '.ai': '',
    ai: '',
    agent: '',
};

const KNOWLEDGE_FILE_EXTS = new Set(['.md', '.txt', '.rst', '.adoc']);

const SKIP_NAMES = new Set([
    '.git',
    '.DS_Store',
    'Thumbs.db',
    'node_modules',
    '.idea',
    '.vscode',
]);

export async function analyseFolder(root: string): Promise<AnalyseResult> {
    if (!fs.existsSync(root)) {
        throw new Error(`Folder does not exist: ${root}`);
    }
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${root}`);
    }

    const entries = await fsp.readdir(root, { withFileTypes: true });
    const repos: AnalyseRepoCandidate[] = [];
    const knowledge: AnalyseKnowledgeCandidate[] = [];
    const other: AnalyseOtherEntry[] = [];

    // The single most common source is the folder ITSELF being one git
    // repo (plain repo or monorepo — one .git either way). It becomes one
    // submodule named after the folder. Nested .git dirs inside it are
    // that repo's own submodules/worktrees — they travel with the parent,
    // so we don't offer them separately.
    const rootIsRepo = fs.existsSync(path.join(root, '.git'));
    if (rootIsRepo) {
        const { origin, head } = await readGitInfo(root);
        const leaf = path.basename(root.replace(/[\\/]+$/, ''));
        repos.push({
            rel_path: '.',
            abs_path: root,
            default_name: sanitiseRepoName(leaf),
            origin_url: origin,
            head_ref: head,
        });
    }

    for (const entry of entries) {
        if (SKIP_NAMES.has(entry.name)) continue;
        const abs = path.join(root, entry.name);

        if (entry.isDirectory()) {
            // Probe for a git repo. Both `.git` dirs and `.git` files
            // (worktrees / submodules) count. Skipped when the root is
            // itself a repo — see above.
            const dotGit = path.join(abs, '.git');
            if (fs.existsSync(dotGit)) {
                if (rootIsRepo) {
                    other.push({ rel_path: entry.name, kind: 'directory' });
                    continue;
                }
                const { origin, head } = await readGitInfo(abs);
                repos.push({
                    rel_path: entry.name,
                    abs_path: abs,
                    default_name: sanitiseRepoName(entry.name),
                    origin_url: origin,
                    head_ref: head,
                });
                continue;
            }

            const lookup = KNOWLEDGE_DIR_MAP[entry.name.toLowerCase()];
            if (lookup !== undefined) {
                knowledge.push({
                    rel_path: entry.name,
                    abs_path: abs,
                    kind: 'directory',
                    suggested_target: lookup,
                });
                continue;
            }

            other.push({ rel_path: entry.name, kind: 'directory' });
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (KNOWLEDGE_FILE_EXTS.has(ext)) {
                let size: number | undefined;
                try {
                    size = (await fsp.stat(abs)).size;
                } catch {
                    /* ignore */
                }
                knowledge.push({
                    rel_path: entry.name,
                    abs_path: abs,
                    kind: 'file',
                    suggested_target: 'knowledge',
                    size,
                });
                continue;
            }
            other.push({ rel_path: entry.name, kind: 'file' });
        }
    }

    // Sort each list alphabetically so the UI is stable. The root-repo
    // row ('.') sorts first naturally.
    repos.sort((a, b) => a.rel_path.localeCompare(b.rel_path));
    knowledge.sort((a, b) => a.rel_path.localeCompare(b.rel_path));
    other.sort((a, b) => a.rel_path.localeCompare(b.rel_path));

    const source_kind: SourceKind = rootIsRepo
        ? 'single-repo'
        : repos.length > 0
            ? 'repo-collection'
            : 'plain-folder';

    return { root, source_kind, repos, knowledge, other };
}

/**
 * Drop a leading underscore (some workspaces use `_name` as a "this is
 * internal" convention; inside the envelope it just becomes "name"),
 * and trim characters git refuses to accept in a submodule path.
 */
function sanitiseRepoName(name: string): string {
    return name.replace(/^_+/, '').replace(/[^A-Za-z0-9._-]/g, '-') || name;
}

interface GitInfo {
    origin: string | null;
    head: string | null;
}

async function readGitInfo(cwd: string): Promise<GitInfo> {
    let origin: string | null = null;
    let head: string | null = null;
    try {
        const out = await execFileAsync('git', ['config', 'remote.origin.url'], { cwd });
        const stdout = out.stdout.trim();
        origin = stdout || null;
    } catch {
        origin = null;
    }
    try {
        const out = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        const stdout = out.stdout.trim();
        head = stdout || null;
    } catch {
        head = null;
    }
    return { origin, head };
}

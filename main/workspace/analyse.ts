import { execFile, spawn } from 'node:child_process';
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
 *   - 'single-repo'     — the folder itself is one git repo with NO
 *                          submodules. It becomes ONE submodule.
 *   - 'monorepo'        — the folder is a git repo that DECLARES git
 *                          submodules (a `.gitmodules` listing ≥1). The
 *                          wizard can either wrap it whole (one submodule)
 *                          or explode it into its member submodules.
 *   - 'repo-collection' — no root .git, but one or more subfolders are
 *                          git repos; each becomes its own submodule.
 *   - 'plain-folder'    — no git anywhere at the top level. Knowledge
 *                          can still move into the envelope.
 */
export type SourceKind = 'single-repo' | 'monorepo' | 'repo-collection' | 'plain-folder';

/**
 * One entry parsed from the root repo's `.gitmodules`. Present only for
 * 'monorepo' sources. `url` is whatever `.gitmodules` declares (usually a
 * remote URL; may be relative — left verbatim so the wizard can decide).
 */
export interface SubmoduleEntry {
    /** The `[submodule "<name>"]` section name. */
    name: string;
    /** The submodule's checkout path relative to the repo root. */
    path: string;
    /** The submodule's declared remote URL. */
    url: string;
}

/**
 * Per-entry classification for SINGLE-REPO sources. Everything at the
 * top level defaults to "part of the codebase" — the repo's own git
 * store then refines that: tracked entries genuinely travel with the
 * submodule clone, while ignored/untracked entries (a gitignored .ai/,
 * loose WIP notes) would be LEFT BEHIND unless the envelope captures
 * them as knowledge or root items.
 */
export interface RootEntry {
    rel_path: string;
    abs_path: string;
    kind: 'file' | 'directory';
    git_state: 'tracked' | 'untracked' | 'ignored';
    /** Default disposition the wizard pre-selects. */
    suggested: 'codebase' | 'knowledge' | 'root';
    /** `.ai/` subdir when suggested === 'knowledge'. */
    suggested_target: string;
}

export interface AnalyseResult {
    root: string;
    source_kind: SourceKind;
    repos: AnalyseRepoCandidate[];
    knowledge: AnalyseKnowledgeCandidate[];
    other: AnalyseOtherEntry[];
    /** Present for 'single-repo' AND 'monorepo' sources (root is a repo). */
    root_entries?: RootEntry[];
    /**
     * The root repo's declared submodules, parsed from `.gitmodules`.
     * Non-empty exactly when `source_kind === 'monorepo'`.
     */
    submodules: SubmoduleEntry[];
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

/**
 * Regenerable build/dependency output. When these show up ignored in a
 * single-repo source we still default them to "codebase" (= do nothing,
 * the toolchain recreates them) rather than suggesting a copy.
 */
const REGENERABLE_NAMES = new Set([
    'node_modules',
    'vendor',
    'dist',
    'build',
    'out',
    'target',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
    'coverage',
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
    // repo. It becomes one submodule named after the folder. Nested .git
    // dirs inside it are that repo's own submodules/worktrees — they
    // travel with the parent, so we don't offer them separately. If the
    // root repo DECLARES submodules (`.gitmodules`), that promotes the
    // source to a 'monorepo' so the wizard can explode it into members.
    const rootIsRepo = fs.existsSync(path.join(root, '.git'));
    const submodules = rootIsRepo ? await parseGitModules(root) : [];
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
        ? submodules.length > 0
            ? 'monorepo'
            : 'single-repo'
        : repos.length > 0
            ? 'repo-collection'
            : 'plain-folder';

    const root_entries = rootIsRepo
        ? await classifyRootEntries(root, entries)
        : undefined;

    return { root, source_kind, repos, knowledge, other, root_entries, submodules };
}

/**
 * Parse the root repo's `.gitmodules` into structured submodule entries.
 * The file is INI-ish:
 *
 *   [submodule "fancy-ui"]
 *       path = repos/fancy-ui
 *       url = git@github.com:org/fancy-ui.git
 *
 * We prefer `git config -f .gitmodules --list` (handles quoting, comments,
 * and continuation the same way git does) and fall back to a tolerant
 * hand parser when git is unavailable. Only entries that have BOTH a path
 * and a url are returned; section name comes from the `[submodule "…"]`
 * header. Returns [] when there is no `.gitmodules`.
 */
export async function parseGitModules(root: string): Promise<SubmoduleEntry[]> {
    const modulesPath = path.join(root, '.gitmodules');
    if (!fs.existsSync(modulesPath)) return [];

    // Preferred path: let git itself flatten the file. Output lines look
    // like `submodule.fancy-ui.path repos/fancy-ui`. The middle key (the
    // section name) can itself contain dots, so we split on the FIRST and
    // LAST dot only: submodule.<name>.<field>.
    try {
        const out = await execFileAsync(
            'git',
            ['config', '-f', '.gitmodules', '--list'],
            { cwd: root, maxBuffer: 8 * 1024 * 1024 },
        );
        const byName = new Map<string, { path?: string; url?: string }>();
        for (const line of out.stdout.split('\n')) {
            if (!line) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const fullKey = line.slice(0, eq);
            const value = line.slice(eq + 1);
            if (!fullKey.startsWith('submodule.')) continue;
            const rest = fullKey.slice('submodule.'.length);
            const lastDot = rest.lastIndexOf('.');
            if (lastDot === -1) continue;
            const name = rest.slice(0, lastDot);
            const field = rest.slice(lastDot + 1);
            const cur = byName.get(name) ?? {};
            if (field === 'path') cur.path = value.trim();
            else if (field === 'url') cur.url = value.trim();
            byName.set(name, cur);
        }
        const entries: SubmoduleEntry[] = [];
        for (const [name, v] of byName) {
            if (v.path && v.url) {
                entries.push({ name, path: v.path, url: v.url });
            }
        }
        if (entries.length > 0) {
            entries.sort((a, b) => a.path.localeCompare(b.path));
            return entries;
        }
        // git produced nothing usable — fall through to the hand parser
        // (e.g. a malformed file git skipped but we can still salvage).
    } catch {
        /* git missing or refused the file — hand-parse below */
    }

    return parseGitModulesText(fs.readFileSync(modulesPath, 'utf8'));
}

/**
 * Tolerant fallback parser for `.gitmodules` content. Reads
 * `[submodule "name"]` sections and their `path =` / `url =` keys. Lines
 * starting with `#` or `;` are comments. Only fully-specified entries
 * (both path and url) are emitted.
 */
export function parseGitModulesText(text: string): SubmoduleEntry[] {
    const out: SubmoduleEntry[] = [];
    let current: { name: string; path?: string; url?: string } | null = null;
    const flush = () => {
        if (current && current.path && current.url) {
            out.push({ name: current.name, path: current.path, url: current.url });
        }
    };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const header = line.match(/^\[submodule\s+"([^"]*)"\]$/i)
            ?? line.match(/^\[submodule\s+"?([^"\]]+)"?\]$/i);
        if (header) {
            flush();
            current = { name: header[1].trim() };
            continue;
        }
        if (!current) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        const value = line.slice(eq + 1).trim();
        if (key === 'path') current.path = value;
        else if (key === 'url') current.url = value;
    }
    flush();
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
}

/**
 * Single-repo classification: consult the repo's own git store. One
 * `git ls-files` gives the tracked top-level set; the rest are sorted
 * into ignored vs untracked via one batched `git check-ignore --stdin`.
 *
 * Suggested dispositions:
 *   - tracked                                  → codebase (travels with the clone)
 *   - knowledge-convention name (any state)    → knowledge (.ai/<mapped>)
 *   - regenerable ignored output (dist/, etc.) → codebase (toolchain recreates it)
 *   - everything else untracked/ignored        → codebase too — but flagged by
 *     git_state so the UI can warn "won't travel" and let the user flip it.
 *     Defaulting dotfiles/.env to a COPY would risk committing secrets into
 *     the (git-tracked, possibly pushed) envelope.
 */
async function classifyRootEntries(
    root: string,
    entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>,
): Promise<RootEntry[]> {
    const names = entries
        .filter((e) => e.name !== '.git' && (e.isDirectory() || e.isFile()))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }));

    // Tracked top-level prefixes from one ls-files pass.
    const tracked = new Set<string>();
    try {
        // Plain ls-files lists tracked paths — there is no --name-only
        // here (that's a diff option); names are already the output.
        const out = await execFileAsync('git', ['ls-files'], {
            cwd: root,
            maxBuffer: 32 * 1024 * 1024,
        });
        for (const line of out.stdout.split('\n')) {
            if (!line) continue;
            const top = line.split('/')[0];
            if (top) tracked.add(top);
        }
    } catch {
        /* not actually a repo / git missing — everything reads untracked */
    }

    // Batched ignore check for the non-tracked remainder. check-ignore
    // exits 1 when NOTHING matched and 0 when something did — stdout is
    // authoritative either way, so collect it regardless of exit code.
    const ignored = new Set<string>();
    const untrackedNames = names.filter((n) => !tracked.has(n.name));
    if (untrackedNames.length > 0) {
        try {
            const out = await runGitWithStdin(
                root,
                ['check-ignore', '--stdin'],
                untrackedNames.map((n) => n.name).join('\n'),
            );
            for (const line of out.split('\n')) {
                if (line) ignored.add(line.trim());
            }
        } catch {
            /* git missing — treat all as untracked */
        }
    }

    return names.map(({ name, dir }) => {
        const git_state: RootEntry['git_state'] = tracked.has(name)
            ? 'tracked'
            : ignored.has(name)
                ? 'ignored'
                : 'untracked';

        const knowledgeTarget = dir
            ? KNOWLEDGE_DIR_MAP[name.toLowerCase()]
            : KNOWLEDGE_FILE_EXTS.has(path.extname(name).toLowerCase())
                ? 'knowledge'
                : undefined;

        let suggested: RootEntry['suggested'] = 'codebase';
        let suggested_target = '';
        if (knowledgeTarget !== undefined && git_state !== 'tracked') {
            // Knowledge-shaped AND not in git — would be lost on clone.
            // Tracked knowledge dirs stay codebase by default (they
            // already travel); the user can still flip them to copy.
            if (!REGENERABLE_NAMES.has(name.toLowerCase())) {
                suggested = 'knowledge';
                suggested_target = knowledgeTarget;
            }
        }

        return {
            rel_path: name,
            abs_path: path.join(root, name),
            kind: dir ? ('directory' as const) : ('file' as const),
            git_state,
            suggested,
            suggested_target,
        };
    });
}

/**
 * Drop a leading underscore (some workspaces use `_name` as a "this is
 * internal" convention; inside the envelope it just becomes "name"),
 * and trim characters git refuses to accept in a submodule path.
 */
function sanitiseRepoName(name: string): string {
    return name.replace(/^_+/, '').replace(/[^A-Za-z0-9._-]/g, '-') || name;
}

/**
 * Run git with data piped to stdin and resolve with stdout. Async
 * execFile has no `input` option (that's execFileSync) — without
 * explicitly writing + closing stdin, `git check-ignore --stdin`
 * blocks forever. Non-zero exits still resolve: check-ignore uses
 * exit 1 for "no matches", which isn't an error for us.
 */
function runGitWithStdin(
    cwd: string,
    args: string[],
    input: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d: string) => {
            stdout += d;
        });
        child.on('error', reject);
        child.on('close', () => resolve(stdout));
        child.stdin.write(input);
        child.stdin.end();
    });
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

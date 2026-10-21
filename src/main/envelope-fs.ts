import { execFile, spawn } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
    knowledgeTargetFor,
    parseGitModulesText,
    sanitiseRepoName,
    sourceKindOf,
    SKIP_NAMES,
    suggestDisposition,
    unionSubmodules,
    type GitState,
    type KnowledgeCandidate,
    type OtherEntry,
    type RepoCandidate,
    type RootEntry,
    type SourceAnalysis,
    type SubmoduleEntry,
} from '../core/envelope-plan.js';
import type { EnvelopePorts } from './envelope-wizard-host.js';

/**
 * THE REAL DISK AND GIT THE ENVELOPE BUILD RUNS ON (Add workspace parity item 7). main.ts hands these to
 * envelope-wizard-host as they are, and test/envelope-build.test.ts drives the SAME functions against real folders and
 * a real git — what the test measures is what the app runs.
 *
 * Everything that touches the SOURCE only reads it: readdir, stat, and git commands that do not write (`config --get`,
 * `rev-parse`, `ls-files`, `check-ignore`). `git status` is deliberately absent — it may rewrite the source's index.
 */

const isDir = async (p: string) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };
const exists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };

/** One read-only git command; `null` when it fails (not a repo, no such config, no git). */
function gitRead(cwd: string, args: readonly string[]): Promise<string | null> {
    return new Promise((done) => {
        execFile('git', [...args], { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => done(error ? null : String(stdout)));
    });
}

/** git with input on stdin (Genie 1's runGitWithStdin): `check-ignore` exits 1 for "none matched", which is an answer. */
function gitWithStdin(cwd: string, args: readonly string[], input: string): Promise<string> {
    return new Promise((done) => {
        const child = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d: string) => { out += d; });
        child.on('error', () => done(''));
        child.on('close', () => done(out));
        child.stdin.end(input);
    });
}

async function gitInfo(cwd: string): Promise<{ origin: string | null; head: string | null }> {
    const origin = (await gitRead(cwd, ['config', '--get', 'remote.origin.url']))?.trim() || null;
    const head = (await gitRead(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null;
    return { origin, head };
}

/** The root repo's `.gitmodules`, as git reads it (`config -f --list`), else Genie 1's tolerant parser. */
async function declaredSubmodules(root: string): Promise<Array<{ name: string; path: string; url: string }>> {
    const file = join(root, '.gitmodules');
    if (!(await exists(file))) return [];
    const listed = await gitRead(root, ['config', '-f', '.gitmodules', '--list']);
    if (listed) {
        const byName = new Map<string, { path?: string; url?: string }>();
        for (const line of listed.split('\n')) {
            const eq = line.indexOf('=');
            if (eq === -1 || !line.startsWith('submodule.')) continue;
            const key = line.slice('submodule.'.length, eq);
            const dot = key.lastIndexOf('.');
            if (dot === -1) continue;
            const name = key.slice(0, dot);
            const field = key.slice(dot + 1);
            const cur = byName.get(name) ?? {};
            if (field === 'path') cur.path = line.slice(eq + 1).trim();
            else if (field === 'url') cur.url = line.slice(eq + 1).trim();
            byName.set(name, cur);
        }
        const out = [...byName].flatMap(([name, v]) => (v.path && v.url ? [{ name, path: v.path, url: v.url }] : []));
        if (out.length > 0) return out.sort((a, b) => a.path.localeCompare(b.path));
    }
    return parseGitModulesText(await readFile(file, 'utf8'));
}

/** Genie 1's classifyRootEntries: the repo's own git says what is tracked, ignored, or neither. */
async function rootEntries(root: string, names: Array<{ name: string; dir: boolean }>): Promise<RootEntry[]> {
    const tracked = new Set<string>();
    for (const line of ((await gitRead(root, ['ls-files'])) ?? '').split('\n')) {
        const top = line.split('/')[0];
        if (top) tracked.add(top);
    }
    const ignored = new Set<string>();
    const rest = names.filter((n) => !tracked.has(n.name));
    if (rest.length > 0) {
        // A directory is asked about with its trailing slash, so a `dir/` pattern matches it as git would.
        const out = await gitWithStdin(root, ['check-ignore', '--stdin'], rest.map((n) => (n.dir ? `${n.name}/` : n.name)).join('\n'));
        for (const line of out.split('\n')) if (line.trim()) ignored.add(line.trim().replace(/\/+$/, ''));
    }
    return names.map(({ name, dir }) => {
        const gitState: GitState = tracked.has(name) ? 'tracked' : ignored.has(name) ? 'ignored' : 'untracked';
        const kind = dir ? ('directory' as const) : ('file' as const);
        return { relPath: name, absPath: join(root, name), kind, gitState, ...suggestDisposition(name, kind, gitState) };
    });
}

/**
 * WHAT THE FOLDER IS (Genie 1's analyseFolder, analyse.ts): the folder itself a repo (single repo, or a monorepo when it
 * declares submodules or holds clones at its top level), a collection of repos, or a plain folder; the repos it has,
 * their remotes and branches; the knowledge-shaped entries; and, for a repo, every top-level entry by its git state.
 */
export async function analyseFolder(root: string): Promise<SourceAnalysis> {
    if (!(await isDir(root))) throw new Error(`${root} is not a folder Genie can read`);
    const entries = await readdir(root, { withFileTypes: true });
    const rootIsRepo = await exists(join(root, '.git'));
    const repos: RepoCandidate[] = [];
    const knowledge: KnowledgeCandidate[] = [];
    const other: OtherEntry[] = [];
    const nested: SubmoduleEntry[] = [];

    if (rootIsRepo) {
        const { origin, head } = await gitInfo(root);
        repos.push({ relPath: '.', absPath: root, defaultName: sanitiseRepoName(basename(resolve(root))), originUrl: origin, headRef: head });
    }
    for (const e of entries) {
        if (SKIP_NAMES.has(e.name)) continue;
        const abs = join(root, e.name);
        if (e.isDirectory()) {
            if (await exists(join(abs, '.git'))) {
                const { origin, head } = await gitInfo(abs);
                // Under a root repo, a nested clone is a monorepo MEMBER; with no remote its "URL" is its own folder.
                if (rootIsRepo) nested.push({ name: e.name, path: e.name, url: origin ?? abs, localPath: abs });
                else repos.push({ relPath: e.name, absPath: abs, defaultName: sanitiseRepoName(e.name), originUrl: origin, headRef: head });
                continue;
            }
            const target = knowledgeTargetFor(e.name, 'directory');
            if (target !== undefined) knowledge.push({ relPath: e.name, absPath: abs, kind: 'directory', suggestedTarget: target });
            else other.push({ relPath: e.name, kind: 'directory' });
        } else if (e.isFile()) {
            if (knowledgeTargetFor(e.name, 'file') !== undefined) {
                let size: number | undefined;
                try { size = (await stat(abs)).size; } catch { size = undefined; }
                knowledge.push({ relPath: e.name, absPath: abs, kind: 'file', suggestedTarget: 'knowledge', ...(size !== undefined ? { size } : {}) });
            } else other.push({ relPath: e.name, kind: 'file' });
        }
    }
    const byRel = (a: { relPath: string }, b: { relPath: string }) => a.relPath.localeCompare(b.relPath);
    repos.sort(byRel);
    knowledge.sort(byRel);
    other.sort(byRel);

    const declared: SubmoduleEntry[] = [];
    if (rootIsRepo) {
        for (const d of await declaredSubmodules(root)) {
            const checkout = join(root, ...d.path.split('/'));
            declared.push({ ...d, localPath: (await exists(join(checkout, '.git'))) ? checkout : null });
        }
    }
    const submodules = unionSubmodules(declared, nested);
    const names = entries.filter((e) => e.name !== '.git' && (e.isDirectory() || e.isFile())).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    return {
        root,
        sourceKind: sourceKindOf(rootIsRepo, submodules.length, repos.length),
        repos,
        knowledge,
        other,
        rootEntries: rootIsRepo ? await rootEntries(root, names) : null,
        submodules,
    };
}

export interface EnvelopeFsOptions {
    /** Where Import from Git clones wait; the OS temp folder unless a test says otherwise. */
    stagingBase?: string | undefined;
}

const STAGE_PREFIX = 'genie-import-';

export function nodeEnvelopePorts(options: EnvelopeFsOptions = {}): EnvelopePorts {
    const base = resolve(options.stagingBase ?? tmpdir());
    /**
     * The stage folder a path is in: `<base>/genie-import-XXXXXX` itself or anything under it — a folder `mkdtemp` made for
     * an import, recognised by where it is, so a restarted Genie still knows its own. Anything else is `null`, and is never
     * removed: a person's folder can only ever be read here.
     */
    const stageOf = (path: string): string | null => {
        let p = resolve(path);
        while (dirname(p) !== p) {
            if (dirname(p) === base) return basename(p).startsWith(STAGE_PREFIX) ? p : null;
            p = dirname(p);
        }
        return null;
    };
    return {
        analyse: analyseFolder,
        copy: async (from, to, kind) => {
            await mkdir(kind === 'file' ? dirname(to) : to, { recursive: true });
            // Genie 1's copyDirRecursive: a directory's CONTENTS into the target, its .git (a nested repo's) left behind.
            if (kind === 'file') await copyFile(from, to);
            else await cp(from, to, { recursive: true, force: true, filter: (src) => basename(src) !== '.git' });
        },
        copyEnvFiles: async (from, to) => {
            // Genie 1's copyEnvFiles: best effort, top level only — a failed copy never fails the build.
            try {
                for (const e of await readdir(from, { withFileTypes: true })) {
                    if (!e.isFile() || (e.name !== '.env' && !e.name.startsWith('.env.'))) continue;
                    try { await copyFile(join(from, e.name), join(to, e.name)); } catch { /* skip this one */ }
                }
            } catch { /* not a readable folder: nothing to restore */ }
        },
        staging: {
            make: async () => { await mkdir(base, { recursive: true }); return mkdtemp(join(base, STAGE_PREFIX)); },
            owns: (path) => stageOf(path) !== null,
            remove: async (path) => { const stage = stageOf(path); if (stage) await rm(stage, { recursive: true, force: true }); },
        },
    };
}

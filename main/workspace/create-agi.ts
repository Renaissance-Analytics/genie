import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { simpleGit } from 'simple-git';
import { blankProjectJson, writeProjectJson } from './project-json';

const execFileAsync = promisify(execFile);

/**
 * Auto-create a fresh `{slug}.agi` envelope. Implements the public
 * `.agi` format contract documented in `docs/agi-format.md`.
 *
 *   1. Scaffold skeleton (project.json, repos/, .ai/{plans,knowledge,pm,chat,memory,issues}/, sandbox/, .trash/)
 *   2. git init
 *   3. Write .gitignore that excludes the sandbox + trash
 *   4. Initial commit of project.json + skeleton
 *   5. Optional: set up `github.com/<owner>/<slug>.agi` remote
 */

export interface CreateAgiOpts {
    slug: string;            // becomes folder name and {slug} in remote
    name: string;            // human-readable display name
    parent_path: string;     // where the envelope folder will be created
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

export interface CreateAgiResult {
    path: string;            // absolute path to the new envelope
    git_log_count: number;   // sanity check — should be 1 after init
    remote?: string;
}

/**
 * The envelope skeleton. `.ai/` replaces the older `k/` knowledge zone
 * so the layout matches the broader agentic-tooling convention
 * (Cursor, Claude, and friends all read `.ai/`-prefixed config). The
 * AGI gateway preserves unknown fields in project.json so the rename
 * is a one-way migration on the envelope side; pre-existing `k/`
 * folders are NOT renamed automatically — they keep working in place.
 */
const SKELETON_DIRS = [
    'repos',
    '.ai',
    '.ai/plans',
    '.ai/knowledge',
    '.ai/pm',
    '.ai/chat',
    '.ai/memory',
    '.ai/issues',
    'sandbox',
    '.trash',
];

const GITIGNORE_TEMPLATE = `# Envelope-owned scratch, never committed.
sandbox/**
!sandbox/.gitkeep

# Soft-delete buffer.
.trash/**
!.trash/.gitkeep

# Local OS noise.
.DS_Store
Thumbs.db
*.log
`;

/**
 * The on-disk envelope folder name. The `.agi` suffix is the envelope
 * convention (it's what the GitHub remote uses too) and keeps the
 * envelope distinct from the SOURCE repo when both live under the same
 * parent — e.g. upgrading `…/civicognita-web` writes the envelope to
 * `…/civicognita-web.agi` instead of colliding with the source. Idempotent
 * if the slug already carries the suffix.
 */
export function envelopeFolderName(slug: string): string {
    return /\.agi$/i.test(slug) ? slug : `${slug}.agi`;
}

export async function createAgiEnvelope(
    opts: CreateAgiOpts,
): Promise<CreateAgiResult> {
    const envelopePath = path.join(
        opts.parent_path,
        envelopeFolderName(opts.slug),
    );
    if (fs.existsSync(envelopePath)) {
        const entries = fs.readdirSync(envelopePath);
        if (entries.length > 0) {
            throw new Error(
                `Target folder "${envelopePath}" is not empty. Choose an empty location or use Import on the existing folder.`,
            );
        }
    } else {
        fs.mkdirSync(envelopePath, { recursive: true });
    }

    // Scaffold dirs
    for (const d of SKELETON_DIRS) {
        const full = path.join(envelopePath, d);
        fs.mkdirSync(full, { recursive: true });
        // Keep empty dirs around in git.
        const keep = path.join(full, '.gitkeep');
        if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
    }

    // project.json
    writeProjectJson(envelopePath, blankProjectJson(opts.name, opts.slug));

    // .gitignore
    fs.writeFileSync(
        path.join(envelopePath, '.gitignore'),
        GITIGNORE_TEMPLATE,
        'utf8',
    );

    // git init + initial commit. Set a local user.email / user.name so
    // the commit succeeds even when the host has no global git identity
    // (CI runners, fresh installs, sandboxed environments). The user can
    // still override these via `git config` after the fact; this is just
    // a sane default so we're not blocked on env-level configuration.
    const git = simpleGit(envelopePath);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.email', 'genie@localhost');
    await git.addConfig('user.name', 'Genie');
    await git.add('.');
    await git.commit('Initial commit — {slug}.agi envelope scaffolded by Genie');

    let remote: string | undefined;
    if (opts.remote) {
        if (opts.remote.kind === 'paste') {
            await git.addRemote('origin', opts.remote.url);
            remote = opts.remote.url;
        } else if (opts.remote.kind === 'auto') {
            // The actual GitHub API call is owned by main/git/remote.ts
            // because it needs auth + error handling. We just record the
            // intended URL so the caller can run that step separately.
            const url = `https://github.com/${opts.remote.owner}/${opts.slug}.agi.git`;
            await git.addRemote('origin', url);
            remote = url;
        }
    }

    const log = await git.log();
    return {
        path: envelopePath,
        git_log_count: log.total,
        remote,
    };
}

/**
 * Convert an existing project (local folder OR remote git URL) into a
 * fresh `{slug}.agi` envelope. The source becomes a submodule under
 * `repos/<sub-name>/`. The envelope itself is a brand-new git repo at
 * `<parent_path>/<slug>.agi/`. The source is never modified.
 *
 * Source variants:
 *   - { kind: 'local', path: '...' } — the folder is expected to be a
 *     git repo (has .git). We read its `origin` URL if present and use
 *     that as the submodule remote; if there's no origin, we use the
 *     local path itself (git supports file:// submodules just fine).
 *   - { kind: 'remote', url: '...' } — used as the submodule URL
 *     directly.
 */
export interface ConvertToAgiOpts {
    slug: string;
    name: string;
    parent_path: string;
    source:
        | { kind: 'local'; path: string }
        | { kind: 'remote'; url: string };
    /** Submodule directory name under repos/. Defaults to the repo's basename. */
    sub_name?: string;
    /** Optional remote for the new envelope itself (mirrors CreateAgiOpts). */
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

export interface ConvertToAgiResult extends CreateAgiResult {
    submodule_path: string;
    submodule_url: string;
}

export interface AgiPlanRepo {
    /** Absolute path on disk OR a remote URL (git@github.com:... / https://). */
    source: string;
    /** True when `source` is a local filesystem path (vs. a remote URL). */
    is_local: boolean;
    /** Submodule directory name inside `repos/`. e.g. "app", "brain". */
    submodule_name: string;
}

export interface AgiPlanKnowledge {
    source_abs_path: string;
    kind: 'file' | 'directory';
    /**
     * Target inside `.ai/`. Empty string means "spread the directory's
     * contents directly into `.ai/`" (used for legacy `k/` and `.ai/`
     * folders). Otherwise it's a single segment subdir name like
     * "plans" or "knowledge".
     */
    target_subdir: string;
    /**
     * Copy to the ENVELOPE ROOT instead of `.ai/` — for items that
     * belong beside project.json (a top-level README, an existing
     * scripts/ dir). Files land at the root; directories keep their
     * basename (never spread — spreading at root could collide with
     * the skeleton). When true, `target_subdir` is ignored.
     */
    to_envelope_root?: boolean;
}

export interface ConvertPlanOpts {
    slug: string;
    name: string;
    parent_path: string;
    repos: AgiPlanRepo[];
    knowledge: AgiPlanKnowledge[];
    remote?:
        | { kind: 'none' }
        | { kind: 'paste'; url: string }
        | { kind: 'auto'; owner: string };
}

/**
 * Plan-based variant of `convertToAgi`. The single-source convertToAgi
 * is now expressible as a plan with one repo entry and no knowledge.
 * The interactive Upgrade wizard fans out into this for projects whose
 * source structure doesn't match the one-folder-one-repo assumption.
 */
export async function convertToAgiPlan(opts: ConvertPlanOpts): Promise<CreateAgiResult> {
    // Validate every submodule name up front so the envelope skeleton
    // doesn't get half-built before we bail on a bad path.
    for (const r of opts.repos) {
        if (!/^[A-Za-z0-9._-]+$/.test(r.submodule_name)) {
            throw new Error(
                `Invalid submodule name "${r.submodule_name}". Use letters, numbers, dashes, underscores, dots.`,
            );
        }
    }
    const seenNames = new Set<string>();
    for (const r of opts.repos) {
        if (seenNames.has(r.submodule_name)) {
            throw new Error(`Duplicate submodule name "${r.submodule_name}".`);
        }
        seenNames.add(r.submodule_name);
    }

    const base = await createAgiEnvelope({
        slug: opts.slug,
        name: opts.name,
        parent_path: opts.parent_path,
        remote: opts.remote,
    });

    for (const r of opts.repos) {
        const submodulePath = `repos/${r.submodule_name}`;
        try {
            await runGitSubmoduleAdd(base.path, r.source, submodulePath);
        } catch (e) {
            throw new Error(
                `Failed to add submodule from ${r.source} → ${submodulePath}: ${(e as Error).message}`,
            );
        }
    }

    for (const k of opts.knowledge) {
        const basename = path.basename(k.source_abs_path);
        const targetDir = k.to_envelope_root
            ? k.kind === 'directory'
                ? path.join(base.path, basename)
                : base.path
            : path.join(base.path, '.ai', k.target_subdir);
        fs.mkdirSync(targetDir, { recursive: true });
        if (k.kind === 'file') {
            fs.copyFileSync(k.source_abs_path, path.join(targetDir, basename));
        } else {
            copyDirRecursive(k.source_abs_path, targetDir);
        }
    }

    if (opts.repos.length > 0 || opts.knowledge.length > 0) {
        const git = simpleGit({ baseDir: base.path });
        await git.add('.');
        const parts: string[] = [];
        if (opts.repos.length > 0) {
            parts.push(
                `${opts.repos.length} submodule${opts.repos.length === 1 ? '' : 's'}`,
            );
        }
        if (opts.knowledge.length > 0) {
            parts.push(
                `${opts.knowledge.length} knowledge item${opts.knowledge.length === 1 ? '' : 's'}`,
            );
        }
        await git.commit(`Convert: migrate ${parts.join(' + ')}`);
    }

    return base;
}

/**
 * Push the envelope's initial commit to its configured `origin` remote.
 * Used by the wizard after the GitHub auto-create flow: the empty repo
 * was provisioned on GitHub, the envelope was built locally with the
 * clone URL as origin, and now we push so the remote has content.
 * Setting upstream tracking with `-u` lets later `git push` from the
 * editor or CLI work without args.
 */
export async function pushEnvelopeToOrigin(
    envelopePath: string,
    branch: string,
): Promise<void> {
    const git = simpleGit({ baseDir: envelopePath });
    try {
        await git.push(['-u', 'origin', branch]);
    } catch (e) {
        throw new Error(
            `Failed to push envelope to origin: ${(e as Error).message}. ` +
                'The local envelope is intact; you can push later via Git.',
        );
    }
}

/**
 * Walk a directory and copy its contents into `dest`. We can't use
 * `fs.cpSync` directly because Electron's Node version doesn't ship a
 * stable variant on all platforms — this is the small recursive version
 * that's been load-tested across our targets.
 */
function copyDirRecursive(src: string, dest: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const e of entries) {
        if (e.name === '.git') continue;
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) {
            fs.mkdirSync(d, { recursive: true });
            copyDirRecursive(s, d);
        } else if (e.isFile()) {
            fs.copyFileSync(s, d);
        }
    }
}

export async function convertToAgi(opts: ConvertToAgiOpts): Promise<ConvertToAgiResult> {
    // Resolve the submodule URL + display name before we scaffold anything,
    // so a bad source aborts cleanly without leaving a half-built envelope.
    const { url: submoduleUrl, name: defaultName } = await resolveSource(opts.source);
    const subName = opts.sub_name || defaultName;
    if (!/^[a-zA-Z0-9._-]+$/.test(subName)) {
        throw new Error(
            `Invalid submodule name "${subName}". Use letters, numbers, dashes, underscores, dots.`,
        );
    }

    // Scaffold the envelope the same way createAgiEnvelope does.
    const base = await createAgiEnvelope({
        slug: opts.slug,
        name: opts.name,
        parent_path: opts.parent_path,
        remote: opts.remote,
    });

    // Local-path submodules need `protocol.file.allow=always` since git 2.38
    // (CVE-2022-39253). The parent envelope's .git/config doesn't reach the
    // nested `git clone` that `submodule add` spawns. Setting it via env
    // (GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n + GIT_CONFIG_VALUE_n) DOES
    // propagate to child git processes — that's git's documented escape
    // hatch for setting config at the process boundary. Remote URLs
    // (https://, ssh://, git@) ignore the flag.
    const submodulePath = `repos/${subName}`;
    // Local-path submodules need protocol.file.allow=always since git 2.38
    // (CVE-2022-39253). simple-git's block-unsafe-operations-plugin keeps
    // adding new flags that refuse the env/config patterns required to
    // pass that through, so for this single risky operation we drop down
    // to plain `git` via execFile. Everything else still goes through
    // simple-git.
    await runGitSubmoduleAdd(base.path, submoduleUrl, submodulePath);
    const git = simpleGit({ baseDir: base.path });
    await git.add('.');
    await git.commit(`Convert: add ${subName} as submodule under repos/`);

    const log = await git.log();
    return {
        ...base,
        git_log_count: log.total,
        submodule_path: submodulePath,
        submodule_url: submoduleUrl,
    };
}

async function resolveSource(
    source: ConvertToAgiOpts['source'],
): Promise<{ url: string; name: string }> {
    if (source.kind === 'remote') {
        const trimmed = source.url.trim();
        if (!trimmed) throw new Error('Remote URL is required.');
        return { url: trimmed, name: deriveRepoName(trimmed) };
    }

    // Local source.
    if (!fs.existsSync(source.path)) {
        throw new Error(`Source folder does not exist: ${source.path}`);
    }
    const dotGit = path.join(source.path, '.git');
    if (!fs.existsSync(dotGit)) {
        throw new Error(
            `Source folder is not a git repository: ${source.path}. Run 'git init' there first, or pick a folder that already has a .git directory.`,
        );
    }
    let originUrl: string | null = null;
    try {
        const out = await simpleGit(source.path).getConfig('remote.origin.url');
        originUrl = out.value?.trim() || null;
    } catch {
        /* no origin set — fall back to the local path */
    }
    const url = originUrl ?? source.path;
    return { url, name: deriveRepoName(originUrl ?? path.basename(source.path)) };
}

/**
 * Run `git submodule add <url> <path>` directly via execFile. Bypasses
 * simple-git's block-unsafe-operations-plugin (which refuses the env +
 * GIT_CONFIG_* knobs we need for local-path submodules). For local-path
 * sources, sets protocol.file.allow=always via env so it propagates to
 * the nested `git clone` that `submodule add` spawns. Throws with a
 * trimmed stderr on failure so the caller can wrap it in a friendlier
 * error message.
 */
async function runGitSubmoduleAdd(
    cwd: string,
    url: string,
    targetPath: string,
): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (isLocalPathLikeUrl(url)) {
        env.GIT_CONFIG_COUNT = String((Number(env.GIT_CONFIG_COUNT ?? '0') || 0) + 1);
        const idx = Number(env.GIT_CONFIG_COUNT) - 1;
        env[`GIT_CONFIG_KEY_${idx}`] = 'protocol.file.allow';
        env[`GIT_CONFIG_VALUE_${idx}`] = 'always';
    }
    try {
        await execFileAsync('git', ['submodule', 'add', url, targetPath], {
            cwd,
            env,
            // Generous: a remote clone could ship megabytes of metadata.
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch (e) {
        const err = e as { stderr?: string; message: string };
        const msg = (err.stderr ?? '').toString().trim() || err.message;
        throw new Error(msg);
    }
}

/**
 * True for absolute local paths (POSIX or Windows) and `file://` URLs —
 * the cases where modern git refuses to fetch a submodule without an
 * explicit `protocol.file.allow=always`.
 */
function isLocalPathLikeUrl(value: string): boolean {
    if (value.startsWith('file://')) return true;
    if (value.startsWith('/')) return true;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    return false;
}

export function deriveRepoName(urlOrPath: string): string {
    // Strip trailing slash, then take the last segment, then drop a .git suffix.
    const trimmed = urlOrPath.replace(/[/\\]+$/, '');
    const parts = trimmed.split(/[/\\:]/);
    const last = parts[parts.length - 1] ?? 'repo';
    return last.replace(/\.git$/i, '') || 'repo';
}

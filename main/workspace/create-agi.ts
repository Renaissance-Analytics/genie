import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { simpleGit } from 'simple-git';
import {
    blankProjectJson,
    projectJsonFromRepos,
    writeProjectJson,
    type ProjectJsonRepoInput,
} from './project-json';
import { consolidateMcp } from './mcp';

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

/** Human-facing structure guide written to the envelope root. */
function readmeTemplate(name: string, slug: string): string {
    const folder = envelopeFolderName(slug);
    return `# ${name}

This is a **\`.agi\` envelope** — an Aionima project monorepo that bundles
one or more code repositories together with shared knowledge, planning,
and scratch space. Created with Genie.

## Layout

\`\`\`
${folder}/
├── project.json     Envelope manifest — repo registry + metadata
├── .gitmodules      Submodule registry (the repos below)
├── repos/           Code repositories, each a git submodule
├── .ai/             Shared knowledge (humans + agents)
│   ├── knowledge/   Notes, docs, references
│   ├── plans/       Plans and design docs
│   ├── pm/          Project management
│   ├── chat/        Saved conversations
│   ├── memory/      Long-lived agent memory
│   └── issues/      Issue notes
├── sandbox/         Scratch space (gitignored)
└── .trash/          Soft-delete buffer (gitignored)
\`\`\`

## Working with it

Clone with submodules:

\`\`\`
git clone --recurse-submodules <url>
# or, after a plain clone:
git submodule update --init --recursive
\`\`\`

Each folder under \`repos/\` is an independent repository pinned to a
specific commit. The envelope tracks \`project.json\`, \`.ai/\`, and the
submodule pointers — never the code inside the submodules (that lives in
each repo). Advance a pin with \`git submodule update --remote repos/<name>\`.

For the agent-oriented version of this guide, see \`AGENTS.md\`
(\`CLAUDE.md\` is a symlink to it).
`;
}

/** Agent-facing structure guide. CLAUDE.md symlinks to this. */
function agentsTemplate(name: string): string {
    return `# AGENTS.md — ${name} (.agi envelope)

You are working inside a **\`.agi\` envelope**: an Aionima project monorepo.
\`CLAUDE.md\` is a symlink to this file.

## Structure

- \`repos/<name>/\` — code repositories, each a git **submodule** pinned to
  a commit. Do code work INSIDE these: commit/push in the repo, then the
  envelope's submodule pointer is advanced separately.
- \`.ai/\` — shared knowledge, writable by humans and agents:
  - \`.ai/knowledge/\` — notes, docs, references
  - \`.ai/plans/\` — plans and design docs
  - \`.ai/pm/\` — project management
  - \`.ai/chat/\` — saved conversations
  - \`.ai/memory/\` — long-lived memory
  - \`.ai/issues/\` — issue notes
- \`sandbox/\` — scratch space, gitignored. Use freely; never relied upon.
- \`.trash/\` — soft-delete buffer, gitignored.
- \`project.json\` — the envelope manifest (repo registry + metadata).

## Rules

- The envelope never commits code that belongs to a submodule. Code lives
  in \`repos/<name>\`; the envelope only tracks the submodule pointer.
- \`.ai/\`, \`sandbox/\`, \`.trash/\` are envelope-owned — never submoduled.
- After cloning: \`git submodule update --init --recursive\`.
- Submodule pins advance deliberately
  (\`git submodule update --remote repos/<name>\`), not automatically.
`;
}

/**
 * Turn the staged CLAUDE.md into a real git symlink → AGENTS.md, then
 * sync the working tree to match. Done at the git layer (mode 120000 +
 * checkout-index) rather than fs.symlinkSync so it's a true committed
 * symlink on every platform — Windows working trees can't create file
 * symlinks without elevation, but git stores/restores them fine.
 */
async function makeClaudeSymlink(
    git: ReturnType<typeof simpleGit>,
    envelopePath: string,
): Promise<void> {
    const claude = path.join(envelopePath, 'CLAUDE.md');
    try {
        // CLAUDE.md currently holds exactly "AGENTS.md" (the link target),
        // already staged by `git add .` as a normal blob — so its hash IS
        // the symlink blob we want. Flip the index entry's mode to 120000.
        const sha = (await git.raw(['hash-object', claude])).trim();
        await git.raw([
            'update-index',
            '--add',
            '--cacheinfo',
            `120000,${sha},CLAUDE.md`,
        ]);
        // Materialise the working tree from the index so it matches the
        // 120000 entry — a real symlink where the OS allows (macOS/Linux),
        // a plain "AGENTS.md" file where it doesn't (Windows). Either way
        // the tree is clean against the index.
        await git.raw(['checkout-index', '-f', '--', 'CLAUDE.md']);
    } catch {
        // Worst case the index flip failed — CLAUDE.md stays a plain file
        // containing the AGENTS.md content path. Rewrite it as a readable
        // pointer so it's not a confusing one-liner.
        try {
            fs.writeFileSync(
                claude,
                '# CLAUDE.md\n\nSee [AGENTS.md](./AGENTS.md) — the envelope structure guide.\n',
            );
            await git.add('CLAUDE.md');
        } catch {
            /* best effort */
        }
    }
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

    // Structure docs. README.md for humans, AGENTS.md for agents, and
    // CLAUDE.md as a symlink to AGENTS.md. (Written to disk here; the
    // CLAUDE.md symlink is materialised at the git layer after `git add`.)
    fs.writeFileSync(
        path.join(envelopePath, 'README.md'),
        readmeTemplate(opts.name, opts.slug),
        'utf8',
    );
    fs.writeFileSync(
        path.join(envelopePath, 'AGENTS.md'),
        agentsTemplate(opts.name),
        'utf8',
    );
    fs.writeFileSync(path.join(envelopePath, 'CLAUDE.md'), 'AGENTS.md');

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
    await makeClaudeSymlink(git, envelopePath);
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
    /**
     * `submodule_name` of the host (primary) member — the repo Aionima
     * builds/hosts. The rest are packages it consumes from the registry.
     * When omitted (or not matching any repo) and there's exactly one
     * repo, that lone repo is treated as the host; with multiple repos and
     * no match, no host is designated (hosting stays disabled).
     */
    primary?: string;
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

    // Designate the host. With an explicit primary, match it by name; with
    // exactly one repo and no explicit primary, that lone repo is the host;
    // otherwise no host (hosting stays disabled).
    const hostName =
        opts.primary && opts.repos.some((r) => r.submodule_name === opts.primary)
            ? opts.primary
            : opts.repos.length === 1
                ? opts.repos[0].submodule_name
                : undefined;

    const members: ProjectJsonRepoInput[] = [];
    for (const r of opts.repos) {
        const submodulePath = `repos/${r.submodule_name}`;
        try {
            await runGitSubmoduleAdd(base.path, r.source, submodulePath);
        } catch (e) {
            throw new Error(
                `Failed to add submodule from ${r.source} → ${submodulePath}: ${(e as Error).message}`,
            );
        }
        // Record the submodule's tracked branch so `git submodule update
        // --remote` can advance the pin later. A freshly cloned submodule is
        // normally on its default branch; a detached HEAD (clone pinned to a
        // bare commit) has no symbolic ref, so we fall back to 'main'.
        const branch = await readSubmoduleBranch(base.path, submodulePath);
        try {
            await execFileAsync(
                'git',
                ['config', '-f', '.gitmodules', `submodule.${r.submodule_name}.branch`, branch],
                { cwd: base.path },
            );
        } catch {
            /* best effort — the submodule still works without a tracked branch */
        }
        members.push({
            name: r.submodule_name,
            url: r.source,
            branch,
            isHost: r.submodule_name === hostName,
        });
    }

    // Write the populated project.json (repos[] with role/branch/path + host
    // designation), replacing the blank one createAgiEnvelope scaffolded.
    if (members.length > 0) {
        writeProjectJson(
            base.path,
            projectJsonFromRepos(opts.name, opts.slug, members),
        );
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

    // Surface any MCP config the submodules carry at the envelope root so
    // a Claude/Cursor session opened on the monorepo sees their servers.
    const mcp = consolidateMcp(base.path);

    if (opts.repos.length > 0 || opts.knowledge.length > 0 || mcp.files.length > 0) {
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
        if (mcp.servers.length > 0) {
            parts.push(
                `${mcp.servers.length} MCP server${mcp.servers.length === 1 ? '' : 's'}`,
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
    // Surface the submodule's MCP config (if any) at the envelope root.
    consolidateMcp(base.path);
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
 * Resolve the tracked branch for a freshly-added submodule, used to set
 * `submodule.<name>.branch` in `.gitmodules`. Reads the submodule's
 * current branch via `symbolic-ref --short HEAD`. A submodule cloned at a
 * pinned commit lands on a DETACHED HEAD (no symbolic ref) — there git
 * exits non-zero, and we fall back to 'main' so `--remote` still has a
 * branch to track.
 */
async function readSubmoduleBranch(
    envelopePath: string,
    submodulePath: string,
): Promise<string> {
    try {
        const out = await execFileAsync(
            'git',
            ['-C', submodulePath, 'symbolic-ref', '--short', 'HEAD'],
            { cwd: envelopePath },
        );
        const branch = out.stdout.trim();
        if (branch) return branch;
    } catch {
        /* detached HEAD or git error — fall through to the default */
    }
    return 'main';
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

/**
 * Envelope structure-doc health. Older envelopes (created before Genie
 * scaffolded these, or imported from elsewhere) may be missing the
 * human/agent guides. The UI uses this to show a backfill prompt.
 */
export interface StructureDocStatus {
    /** Path exists and looks like an envelope (has project.json or .git). */
    isEnvelope: boolean;
    hasReadme: boolean;
    hasAgents: boolean;
    hasClaude: boolean;
    /** True when at least one of the three docs is missing. */
    missing: boolean;
    /** Whether the envelope has an `origin` remote (drives push offer). */
    hasRemote: boolean;
}

export async function structureDocStatus(
    envelopePath: string,
): Promise<StructureDocStatus> {
    const exists = (f: string) => fs.existsSync(path.join(envelopePath, f));
    const isEnvelope =
        fs.existsSync(envelopePath) &&
        (exists('project.json') || exists('.git'));
    const hasReadme = exists('README.md');
    const hasAgents = exists('AGENTS.md');
    const hasClaude = exists('CLAUDE.md');

    let hasRemote = false;
    if (isEnvelope && exists('.git')) {
        try {
            const remotes = await simpleGit({ baseDir: envelopePath }).getRemotes();
            hasRemote = remotes.some((r) => r.name === 'origin');
        } catch {
            hasRemote = false;
        }
    }

    return {
        isEnvelope,
        hasReadme,
        hasAgents,
        hasClaude,
        missing: isEnvelope && !(hasReadme && hasAgents && hasClaude),
        hasRemote,
    };
}

export interface AddStructureDocsResult {
    added: string[];
    committed: boolean;
    pushed: boolean;
    pushError?: string;
}

/**
 * Backfill the structure docs into an existing envelope: write any of
 * README.md / AGENTS.md / CLAUDE.md that are missing, commit them, and
 * (best-effort) push to origin. Idempotent — only writes what's absent,
 * and re-establishes the CLAUDE.md symlink at the git layer.
 */
export async function addStructureDocs(
    envelopePath: string,
    name: string,
    slug: string,
): Promise<AddStructureDocsResult> {
    const exists = (f: string) => fs.existsSync(path.join(envelopePath, f));
    const added: string[] = [];

    if (!exists('README.md')) {
        fs.writeFileSync(
            path.join(envelopePath, 'README.md'),
            readmeTemplate(name, slug),
            'utf8',
        );
        added.push('README.md');
    }
    if (!exists('AGENTS.md')) {
        fs.writeFileSync(
            path.join(envelopePath, 'AGENTS.md'),
            agentsTemplate(name),
            'utf8',
        );
        added.push('AGENTS.md');
    }
    const needClaude = !exists('CLAUDE.md');
    if (needClaude) {
        fs.writeFileSync(path.join(envelopePath, 'CLAUDE.md'), 'AGENTS.md');
        added.push('CLAUDE.md');
    }

    if (added.length === 0) {
        return { added, committed: false, pushed: false };
    }

    const git = simpleGit({ baseDir: envelopePath });
    // Make sure a commit identity exists (envelope may predate Genie's).
    try {
        const cfg = await git.listConfig();
        const all = cfg.all as Record<string, string | string[]>;
        if (!all['user.email']) await git.addConfig('user.email', 'genie@localhost');
        if (!all['user.name']) await git.addConfig('user.name', 'Genie');
    } catch {
        /* best effort */
    }

    await git.add(added);
    if (needClaude) await makeClaudeSymlink(git, envelopePath);
    await git.commit('Add envelope structure docs (README + AGENTS + CLAUDE)');

    let pushed = false;
    let pushError: string | undefined;
    try {
        const remotes = await git.getRemotes();
        if (remotes.some((r) => r.name === 'origin')) {
            const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
            await git.push(['-u', 'origin', branch || 'main']);
            pushed = true;
        }
    } catch (e) {
        pushError = e instanceof Error ? e.message : String(e);
    }

    return { added, committed: true, pushed, pushError };
}

export interface ConsolidateMcpCommitResult {
    servers: string[];
    /** Files written to disk at the envelope root. */
    files: string[];
    committed: boolean;
    pushed: boolean;
    pushError?: string;
    /**
     * True when the written files are gitignored, so Genie wrote them
     * locally (sessions opened on the monorepo use them) but did NOT
     * commit — committing could leak MCP tokens the config may hold.
     */
    gitignored?: boolean;
}

/**
 * Consolidate repo MCP configs to the envelope root (both .mcp.json and
 * .cursor/mcp.json) for local sessions, then commit + best-effort push
 * the files that are tracked. On-demand sibling of addStructureDocs.
 *
 * SAFETY: MCP configs can hold bearer tokens, which is exactly why an
 * envelope may gitignore `.mcp.json`. We never force-add an ignored
 * file — that would leak secrets into the repo. Ignored files are still
 * written to disk (the actual requirement: sessions starting on the
 * monorepo pick them up) but left uncommitted, and we say so.
 */
export async function consolidateMcpAndCommit(
    envelopePath: string,
): Promise<ConsolidateMcpCommitResult> {
    const res = consolidateMcp(envelopePath);
    if (res.files.length === 0) {
        return { servers: [], files: [], committed: false, pushed: false };
    }

    const git = simpleGit({ baseDir: envelopePath });
    try {
        const cfg = await git.listConfig();
        const all = cfg.all as Record<string, string | string[]>;
        if (!all['user.email']) await git.addConfig('user.email', 'genie@localhost');
        if (!all['user.name']) await git.addConfig('user.name', 'Genie');
    } catch {
        /* best effort */
    }

    // Only stage files that aren't gitignored. check-ignore exits 1 (and
    // simple-git throws) when a path is NOT ignored — so a throw means
    // "addable", a non-empty stdout means "ignored, skip".
    const candidates = ['.mcp.json', '.cursor/mcp.json'];
    const addable: string[] = [];
    for (const f of candidates) {
        if (!fs.existsSync(path.join(envelopePath, f))) continue;
        try {
            const out = await git.raw(['check-ignore', f]);
            if (!out.trim()) addable.push(f); // empty stdout, exit 0: not ignored
        } catch {
            addable.push(f); // exit 1: not ignored
        }
    }

    if (addable.length === 0) {
        return {
            servers: res.servers,
            files: res.files,
            committed: false,
            pushed: false,
            gitignored: true,
        };
    }

    await git.add(addable);
    const staged = (await git.diff(['--cached', '--name-only'])).trim();
    if (!staged) {
        // Files already matched what's committed — nothing to do.
        return { servers: res.servers, files: res.files, committed: false, pushed: false };
    }
    await git.commit(
        `Consolidate MCP config to envelope root (${res.servers.length} server${res.servers.length === 1 ? '' : 's'})`,
    );

    let pushed = false;
    let pushError: string | undefined;
    try {
        const remotes = await git.getRemotes();
        if (remotes.some((r) => r.name === 'origin')) {
            const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
            await git.push(['-u', 'origin', branch || 'main']);
            pushed = true;
        }
    } catch (e) {
        pushError = e instanceof Error ? e.message : String(e);
    }

    return { servers: res.servers, files: res.files, committed: true, pushed, pushError };
}

import { newWorkspaceProblem, workspaceFolderName } from './add-workspace.js';
import { slugOf } from './repo-registry.js';

/**
 * A NEW `<slug>.agi` AROUND WHAT THE PERSON ALREADY HAS (Add workspace parity item 7; Genie 1's InteractiveUpgradeWizard +
 * analyse.ts + create-agi.ts `convertToAgiPlan`). The pure half: what a folder IS (single repo / monorepo / collection of
 * repos / plain folder), the wizard's draft and its defaults, the plan it hands the main process, and why a plan cannot be
 * built. Nothing here touches a disk.
 *
 * Genie 2 used to WRAP the person's folder in place — project.json, .ai/, sandbox/, .trash/ written into their repo, a
 * dirty working tree in a repository they had just cloned. Genie 1 never did: the source is READ, the repos become
 * submodules of a NEW envelope (cloned FROM the source or its remote), and knowledge is COPIED out (create-agi.ts:745-758).
 * The source is never modified; that is the promise this module's plan is shaped around.
 */

export type SourceKind = 'single-repo' | 'monorepo' | 'repo-collection' | 'plain-folder';
export type EntryKind = 'file' | 'directory';
export type GitState = 'tracked' | 'untracked' | 'ignored';

/** A git repository found in the source: the folder itself (`relPath` '.') or a top-level subfolder. */
export interface RepoCandidate {
    readonly relPath: string;
    readonly absPath: string;
    /** Its suggested `repos/<name>`. */
    readonly defaultName: string;
    /** `remote.origin.url`, when it has one. */
    readonly originUrl: string | null;
    /** The branch it is on (`git rev-parse --abbrev-ref HEAD`). */
    readonly headRef: string | null;
}

/** A member of a monorepo: a submodule its `.gitmodules` declares, or a git repo nested at its top level. */
export interface SubmoduleEntry {
    readonly name: string;
    /** Its checkout path inside the monorepo. */
    readonly path: string;
    /** The declared URL; for a nested repo with no origin, its absolute local path (Genie 1's fallback). */
    readonly url: string;
    /** The checkout on disk, when it is a git repository there (a checked-out submodule, a nested clone); else `null`. */
    readonly localPath: string | null;
}

/** A knowledge-shaped entry of a folder that is not itself a repo (a collection or a plain folder). */
export interface KnowledgeCandidate {
    readonly relPath: string;
    readonly absPath: string;
    readonly kind: EntryKind;
    /** Suggested subfolder of `.ai/`; '' = `.ai/` itself (a directory's contents spread into it). */
    readonly suggestedTarget: string;
    readonly size?: number;
}

export interface OtherEntry {
    readonly relPath: string;
    readonly kind: EntryKind;
}

/** A top-level entry of a folder that IS a repo, with what its own git says about it. */
export interface RootEntry {
    readonly relPath: string;
    readonly absPath: string;
    readonly kind: EntryKind;
    readonly gitState: GitState;
    readonly suggested: 'codebase' | 'knowledge' | 'root';
    readonly suggestedTarget: string;
}

export interface SourceAnalysis {
    readonly root: string;
    readonly sourceKind: SourceKind;
    readonly repos: readonly RepoCandidate[];
    readonly knowledge: readonly KnowledgeCandidate[];
    readonly other: readonly OtherEntry[];
    /** Present when the folder itself is a repository (single repo, monorepo). */
    readonly rootEntries: readonly RootEntry[] | null;
    /** The monorepo's members; non-empty exactly when `sourceKind` is 'monorepo'. */
    readonly submodules: readonly SubmoduleEntry[];
}

/** Never listed, never offered (Genie 1's ignore.ts SKIP_NAMES). */
export const SKIP_NAMES: ReadonlySet<string> = new Set(['.git', '.DS_Store', 'Thumbs.db', 'node_modules', '.idea', '.vscode']);

/** Regenerable output: knowledge-shaped or not, it stays codebase (Genie 1's ignore.ts REGENERABLE_NAMES). */
export const REGENERABLE_NAMES: ReadonlySet<string> = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'coverage']);

/** Genie 1's KNOWLEDGE_DIR_MAP (analyse.ts:120-139): a top-level folder's name → its place in `.ai/` ('' = spread into `.ai/`). */
export const KNOWLEDGE_DIR_MAP: Readonly<Record<string, string>> = {
    plans: 'plans', plan: 'plans',
    knowledge: 'knowledge', docs: 'knowledge', wiki: 'knowledge', notes: 'knowledge',
    pm: 'pm',
    chat: 'chat', chats: 'chat',
    memory: 'memory', memories: 'memory',
    issues: 'issues', bugs: 'issues',
    k: '', '.ai': '', ai: '', agent: '',
};

export const KNOWLEDGE_FILE_EXTS: ReadonlySet<string> = new Set(['.md', '.txt', '.rst', '.adoc']);

/** The `.ai/` targets the Knowledge step offers (Genie 1's KNOWLEDGE_TARGETS). */
export const KNOWLEDGE_TARGETS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'plans', label: '.ai/plans/' },
    { value: 'knowledge', label: '.ai/knowledge/' },
    { value: 'pm', label: '.ai/pm/' },
    { value: 'chat', label: '.ai/chat/' },
    { value: 'memory', label: '.ai/memory/' },
    { value: 'issues', label: '.ai/issues/' },
    { value: '', label: '.ai/ (root)' },
];

/** Genie 1's sanitiseRepoName: a leading underscore dropped (`_app` is "internal" by convention), anything git refuses in a path a dash. */
export function sanitiseRepoName(name: string): string {
    return name.replace(/^_+/, '').replace(/[^A-Za-z0-9._-]/g, '-') || name;
}

/**
 * Genie 1's isLocalPathLikeUrl (create-agi.ts): absolute POSIX and Windows paths, `file://`, UNC shares and `./` `../`
 * relative paths — the sources git refuses to clone a submodule from without `protocol.file.allow=always`. Scheme and
 * scp-style URLs clone over the network and are not local.
 */
export function isLocalPathLike(value: string): boolean {
    if (value.startsWith('file://')) return true;
    if (value.startsWith('/')) return true;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    if (value.startsWith('\\\\')) return true;
    return !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && /^\.\.?[\\/]/.test(value);
}

/** `path.extname` without node: '' for a dotfile (`.env`) and for a name with no dot. */
function extOf(name: string): string {
    const i = name.lastIndexOf('.');
    return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/** Where a knowledge-shaped entry belongs in `.ai/` ('' = `.ai/` itself); `undefined` = not knowledge. */
export function knowledgeTargetFor(name: string, kind: EntryKind): string | undefined {
    if (kind === 'file') return KNOWLEDGE_FILE_EXTS.has(extOf(name)) ? 'knowledge' : undefined;
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(KNOWLEDGE_DIR_MAP, key) ? KNOWLEDGE_DIR_MAP[key] : undefined;
}

/**
 * Genie 1's classifyRootEntries default (analyse.ts:461-494): what is tracked already travels with the repo (Codebase);
 * a knowledge-shaped entry git does NOT carry would be left behind, so it is suggested into `.ai/`. Everything else stays
 * Codebase — a gitignored `.env` suggested into the envelope would commit a secret into a repository that may be pushed.
 */
export function suggestDisposition(name: string, kind: EntryKind, gitState: GitState): { suggested: RootEntry['suggested']; suggestedTarget: string } {
    const target = knowledgeTargetFor(name, kind);
    if (target !== undefined && gitState !== 'tracked' && !REGENERABLE_NAMES.has(name.toLowerCase())) return { suggested: 'knowledge', suggestedTarget: target };
    return { suggested: 'codebase', suggestedTarget: '' };
}

/** Genie 1's source_kind (analyse.ts:265-271). */
export function sourceKindOf(rootIsRepo: boolean, members: number, repos: number): SourceKind {
    if (rootIsRepo) return members > 0 ? 'monorepo' : 'single-repo';
    return repos > 0 ? 'repo-collection' : 'plain-folder';
}

const normRel = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * A monorepo's members (Genie 1's unionSubmodules): its declared submodules and the git repos nested at its top level,
 * one per checkout path. The DECLARED entry wins — its URL is the configured remote — and keeps the checkout a nested
 * scan found on disk. Sorted by path, for a stable table.
 */
export function unionSubmodules(declared: readonly SubmoduleEntry[], nested: readonly SubmoduleEntry[]): SubmoduleEntry[] {
    const byPath = new Map<string, SubmoduleEntry>();
    for (const s of nested) byPath.set(normRel(s.path), { ...s, path: normRel(s.path) });
    for (const s of declared) {
        const key = normRel(s.path);
        const found = byPath.get(key);
        byPath.set(key, { ...s, path: key, localPath: s.localPath ?? found?.localPath ?? null });
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Genie 1's tolerant `.gitmodules` reader (analyse.ts parseGitModulesText): only entries with both a path and a url. */
export function parseGitModulesText(text: string): Array<{ name: string; path: string; url: string }> {
    const out: Array<{ name: string; path: string; url: string }> = [];
    let current: { name: string; path?: string; url?: string } | null = null;
    const flush = () => { if (current?.path && current.url) out.push({ name: current.name, path: current.path, url: current.url }); };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const header = /^\[submodule\s+"([^"]*)"\]$/i.exec(line) ?? /^\[submodule\s+"?([^"\]]+)"?\]$/i.exec(line);
        if (header) { flush(); current = { name: header[1]!.trim() }; continue; }
        if (!current) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        const value = line.slice(eq + 1).trim();
        if (key === 'path') current.path = value;
        else if (key === 'url') current.url = value;
    }
    flush();
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* ===== The wizard's draft ================================================================================================ */

/**
 * Where a repo's submodule comes FROM (Genie 1's RepoSourceMode): its existing remote, or the folder on disk. Genie 1 also
 * had 'fork' (fork on GitHub into the chosen owner, then submodule the fork); that is Add workspace parity item 12 and
 * needs the GitHub write client. It plugs in at `repoSourceUrl`, the one place a row becomes a URL.
 */
export type RepoSource = 'origin' | 'local';

export interface RepoRow {
    /** Stable identity for the table: the source's relative path. */
    readonly key: string;
    readonly relPath: string;
    readonly localPath: string | null;
    readonly originUrl: string | null;
    readonly headRef: string | null;
    readonly included: boolean;
    /** Its `repos/<name>`. */
    readonly name: string;
    readonly source: RepoSource;
}

export type Disposition = 'codebase' | 'knowledge' | 'root' | 'ignore';

export interface DispositionRow extends RootEntry {
    readonly disposition: Disposition;
    readonly targetSubdir: string;
}

export interface KnowledgeRow extends KnowledgeCandidate {
    readonly included: boolean;
    readonly targetSubdir: string;
}

export interface WizardDraft {
    readonly analysis: SourceAnalysis;
    /** The source is a clone Genie made for Import from Git: it is removed after the build, so nothing may point at it. */
    readonly staged: boolean;
    readonly monorepoMode: 'explode' | 'wrap';
    readonly repos: readonly RepoRow[];
    /** Exploded monorepo: the host member's name. */
    readonly primary: string;
    readonly knowledge: readonly KnowledgeRow[];
    readonly dispositions: readonly DispositionRow[];
    readonly name: string;
    readonly nameTouched: boolean;
    readonly parent: string;
}

export function startDraft(analysis: SourceAnalysis, at: { parent: string; staged?: boolean }): WizardDraft {
    const leaf = analysis.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'workspace';
    const exploding = analysis.sourceKind === 'monorepo' && analysis.submodules.length > 0;
    const repos = exploding ? explodeRows(analysis.submodules) : wrapRows(analysis.repos);
    const primary = exploding ? (repos.find((r) => r.included)?.name ?? '') : '';
    return {
        analysis,
        staged: at.staged === true,
        monorepoMode: 'explode',
        repos,
        primary,
        knowledge: analysis.knowledge.map((k) => ({ ...k, included: true, targetSubdir: k.suggestedTarget })),
        dispositions: (analysis.rootEntries ?? []).map((e) => ({ ...e, disposition: e.suggested, targetSubdir: e.suggestedTarget })),
        // Genie 1: an exploded monorepo is named after its host, anything else after the folder.
        name: primary || leaf.replace(/\.agi$/i, ''),
        nameTouched: false,
        parent: at.parent,
    };
}

/** Genie 1's buildWrapRows: a row per repo found; from its remote when it has one, else the folder on disk. */
function wrapRows(candidates: readonly RepoCandidate[]): RepoRow[] {
    return candidates.map((c): RepoRow => ({ key: c.relPath, relPath: c.relPath, localPath: c.absPath, originUrl: c.originUrl, headRef: c.headRef, included: true, name: c.defaultName, source: c.originUrl ? 'origin' : 'local' }));
}

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '') === b.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Genie 1's buildExplodeRows: a row per member, named by its path's leaf. A member whose "URL" is only its own checkout
 * (a nested clone with no remote) has no Origin; a declared URL is the configured remote, even when it is a path.
 */
function explodeRows(subs: readonly SubmoduleEntry[]): RepoRow[] {
    return subs.map((s): RepoRow => {
        const leaf = s.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? s.name;
        const originUrl = s.localPath !== null && samePath(s.url, s.localPath) ? null : s.url;
        return { key: s.path, relPath: s.path, localPath: s.localPath, originUrl, headRef: null, included: true, name: sanitiseRepoName(leaf), source: originUrl ? 'origin' : 'local' };
    });
}

/** Genie 1's setMonorepoModeAndRebuild: explode = a row per member, wrap = the monorepo as one row. */
export function setMonorepoMode(draft: WizardDraft, mode: 'explode' | 'wrap'): WizardDraft {
    if (draft.analysis.sourceKind !== 'monorepo' || mode === draft.monorepoMode) return draft;
    if (mode === 'wrap') return { ...draft, monorepoMode: 'wrap', repos: wrapRows(draft.analysis.repos), primary: '' };
    const repos = explodeRows(draft.analysis.submodules);
    const primary = repos.find((r) => r.included)?.name ?? '';
    return { ...draft, monorepoMode: 'explode', repos, primary, name: !draft.nameTouched && primary ? primary : draft.name };
}

const exploded = (d: WizardDraft) => d.analysis.sourceKind === 'monorepo' && d.monorepoMode === 'explode';

/**
 * Change one row. In an exploded monorepo the host stays valid (Genie 1's effect, :515-528): a renamed host keeps being the
 * host under its new name; an unchecked one hands over to the first member still included, renaming the workspace while
 * its name is still Genie's suggestion.
 */
export function patchRepo(draft: WizardDraft, key: string, patch: Partial<Pick<RepoRow, 'included' | 'name' | 'source'>>): WizardDraft {
    const before = draft.repos.find((r) => r.key === key);
    const repos = draft.repos.map((r) => (r.key === key ? { ...r, ...patch } : r));
    if (!exploded(draft)) return { ...draft, repos };
    let primary = before && before.name.trim() === draft.primary && patch.name !== undefined ? patch.name.trim() : draft.primary;
    const included = repos.filter((r) => r.included);
    if (!included.some((r) => r.name.trim() === primary)) primary = included[0]?.name.trim() ?? '';
    return { ...draft, repos, primary, name: !draft.nameTouched && primary && primary !== draft.primary ? primary : draft.name };
}

/** Genie 1's choosePrimary: the host, and the workspace's name with it while the person has not typed one. */
export function choosePrimary(draft: WizardDraft, name: string): WizardDraft {
    return { ...draft, primary: name, name: !draft.nameTouched && name ? name : draft.name };
}

/** The person typed a name: from here on it is theirs. */
export function renameWorkspace(draft: WizardDraft, name: string): WizardDraft {
    return { ...draft, name, nameTouched: true };
}

/** A source that IS a repo has a git store to ask, so its Knowledge step is the per-entry disposition table. */
export function usesDisposition(kind: SourceKind): boolean {
    return kind === 'single-repo' || kind === 'monorepo';
}

/**
 * The sources a row may be added from: Origin when it has a remote, Local when there is a checkout on disk Genie keeps.
 * An Import from Git clone is removed after the build, so a submodule pointing at it would point at nothing.
 */
export function sourceOptions(row: RepoRow, staged: boolean): RepoSource[] {
    return [...(row.originUrl ? (['origin'] as const) : []), ...(!staged && row.localPath ? (['local'] as const) : [])];
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const nameProblem = (name: string) => (NAME_RE.test(name) && name !== '.' && name !== '..' ? null : `"${name}" cannot be a folder under repos/. Use letters, numbers, dashes, underscores and dots.`);

/** Genie 1's repoNamesValid, with its reason: every INCLUDED row named, each name once, each a folder git accepts. */
export function repoNamesProblem(rows: readonly RepoRow[]): string | null {
    const names = rows.filter((r) => r.included).map((r) => r.name.trim());
    if (names.some((n) => n === '')) return 'Each repository needs a name.';
    if (new Set(names).size !== names.length) return 'Repository names must be unique.';
    for (const n of names) { const p = nameProblem(n); if (p) return p; }
    return null;
}

/* ===== The plan the main process builds ================================================================================== */

export interface PlanRepo {
    readonly name: string;
    /** What `git submodule add` clones: the remote URL, or the local path. */
    readonly url: string;
    readonly local: boolean;
}

export interface PlanKnowledge {
    readonly from: string;
    readonly kind: EntryKind;
    /** 'ai' = into `.ai/<subdir>`; 'root' = beside project.json. */
    readonly to: 'ai' | 'root';
    readonly subdir: string;
}

export interface EnvelopePlan {
    /** The display name; the folder is `workspaceFolderName(name)` under `parent`. */
    readonly name: string;
    readonly parent: string;
    /** The analysed folder — the envelope may never be written inside it. */
    readonly source: string;
    readonly staged: boolean;
    readonly repos: readonly PlanRepo[];
    readonly knowledge: readonly PlanKnowledge[];
    /** The host repo's name; `null` = none designated (one repo is its own host). */
    readonly primary: string | null;
}

/** The ONE place a row becomes a submodule URL (the seam item 12's fork plugs into). */
export function repoSourceUrl(row: RepoRow): PlanRepo {
    const name = row.name.trim();
    // Origin: the repo's remote (Genie 1 :672-678). Local: the folder on disk, which git needs protocol.file.allow for (:679-683).
    if (row.source === 'origin' && row.originUrl) return { name, url: row.originUrl, local: false };
    return { name, url: row.localPath ?? row.originUrl ?? '', local: true };
}

/** The draft as the plan the main process builds (Genie 1's ConvertPlanOpts, :658-713). */
export function buildPlan(draft: WizardDraft): EnvelopePlan {
    const knowledge: PlanKnowledge[] = usesDisposition(draft.analysis.sourceKind)
        // Codebase travels with the repo and Ignore is left out: neither is copied.
        ? draft.dispositions.filter((r) => r.disposition === 'knowledge' || r.disposition === 'root').map((r) => ({ from: r.absPath, kind: r.kind, to: r.disposition === 'root' ? 'root' : 'ai', subdir: r.disposition === 'knowledge' ? r.targetSubdir : '' }))
        : draft.knowledge.filter((r) => r.included).map((r) => ({ from: r.absPath, kind: r.kind, to: 'ai', subdir: r.targetSubdir }));
    return {
        name: draft.name,
        parent: draft.parent,
        source: draft.analysis.root,
        staged: draft.staged,
        repos: draft.repos.filter((r) => r.included).map(repoSourceUrl),
        knowledge,
        // Only an exploded monorepo names a host; a lone repo is its own (envelopeRepos).
        primary: exploded(draft) && draft.primary ? draft.primary : null,
    };
}

/** A plan as it arrives over IPC or the remote wire: exactly the fields Genie builds from, or `null`. */
export function parseEnvelopePlan(raw: unknown): EnvelopePlan | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const p = raw as Record<string, unknown>;
    const str = (v: unknown): v is string => typeof v === 'string';
    if (!str(p.name) || !str(p.parent) || !str(p.source) || typeof p.staged !== 'boolean' || !Array.isArray(p.repos) || !Array.isArray(p.knowledge)) return null;
    if (p.primary !== null && !str(p.primary)) return null;
    const repos: PlanRepo[] = [];
    for (const r of p.repos as unknown[]) {
        const o = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
        if (!str(o.name) || !str(o.url) || typeof o.local !== 'boolean') return null;
        repos.push({ name: o.name, url: o.url, local: o.local });
    }
    const knowledge: PlanKnowledge[] = [];
    for (const k of p.knowledge as unknown[]) {
        const o = (typeof k === 'object' && k !== null ? k : {}) as Record<string, unknown>;
        if (!str(o.from) || (o.kind !== 'file' && o.kind !== 'directory') || (o.to !== 'ai' && o.to !== 'root') || !str(o.subdir)) return null;
        // A target inside `.ai/` is one of its folders, never a path that climbs out of it.
        if (!KNOWLEDGE_TARGETS.some((t) => t.value === o.subdir) && o.to === 'ai') return null;
        knowledge.push({ from: o.from, kind: o.kind, to: o.to, subdir: o.subdir });
    }
    return { name: p.name, parent: p.parent, source: p.source, staged: p.staged, repos, knowledge, primary: (p.primary as string | null) };
}

/** What makes a folder an envelope; a Root item may not replace it. */
const ENVELOPE_OWNED: ReadonlySet<string> = new Set(['project.json', '.gitmodules', '.gitignore', '.git', 'repos', '.ai', 'sandbox', '.trash']);

const leafOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

/** Forward slashes, no trailing one; a Windows drive path compared case-insensitively, as its filesystem does. */
function normAbs(p: string): string {
    const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

/**
 * Why this plan cannot be built, or `null` — checked before anything is written (Genie 1 validated its names before the
 * skeleton, convertToAgiPlan :659-674). The envelope is a NEW folder BESIDE the source: one written inside it would change
 * the very folder this route promises not to touch.
 */
export function planProblem(plan: EnvelopePlan): string | null {
    const named = newWorkspaceProblem(plan.name, plan.parent);
    if (named) return named;
    const seen = new Set<string>();
    for (const r of plan.repos) {
        const p = nameProblem(r.name);
        if (p) return p;
        if (seen.has(r.name)) return `Duplicate repository name "${r.name}".`;
        seen.add(r.name);
        if (r.url.trim() === '') return `${r.name} has nowhere to be added from.`;
        if (plan.staged && r.local) return `${r.name} has no remote to add it from. Genie removes the clone it made for this import once the workspace is built, so a repository in it can only come from its remote.`;
    }
    const target = `${normAbs(plan.parent)}/${workspaceFolderName(plan.name)}`;
    const source = normAbs(plan.source);
    if (target === source || target.startsWith(`${source}/`)) return `The new workspace would be written inside ${plan.source}, the folder being brought in, and Genie never changes that folder. Choose a folder outside it.`;
    for (const k of plan.knowledge) {
        const leaf = leafOf(k.from);
        if (k.to === 'root' && ENVELOPE_OWNED.has(leaf)) return `"${leaf}" would replace the workspace's own ${leaf}. Send it to Knowledge, or leave it out.`;
    }
    return null;
}

/**
 * The manifest's `repos[]`, `primaryRepo` and `hosting` for the built envelope (Genie 1's projectJsonFromRepos): each repo
 * at `repos/<name>` with the branch its submodule tracks; the host is the named primary, or a lone repo; the rest are
 * packages. `slug` because Genie 2's registry reads repos by it (core/repo-registry.ts).
 */
export function envelopeRepos(members: ReadonlyArray<{ name: string; url: string; branch: string | null }>, primary: string | null): Record<string, unknown> {
    const host = primary !== null && members.some((m) => m.name === primary) ? primary : members.length === 1 ? members[0]!.name : '';
    return {
        primaryRepo: host,
        hosting: { enabled: host !== '' },
        // A detached submodule tracks no branch: none is recorded rather than a guessed `main` (as the Tynn import does).
        repos: members.map((m) => ({ name: m.name, slug: slugOf(m.name), url: m.url, path: `repos/${m.name}`, role: m.name === host ? 'host' : 'package', ...(m.branch ? { branch: m.branch } : {}) })),
    };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Genie 1's second commit: "Convert: migrate N submodules + M knowledge items". `null` = nothing to commit. */
export function convertCommitMessage(repos: number, knowledge: number): string | null {
    const parts = [...(repos > 0 ? [plural(repos, 'submodule')] : []), ...(knowledge > 0 ? [plural(knowledge, 'knowledge item')] : [])];
    return parts.length === 0 ? null : `Convert: migrate ${parts.join(' + ')}`;
}

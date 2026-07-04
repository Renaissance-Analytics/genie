import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { addWorkspace, getAllSettings, listWorkspaces } from '../db';
import { TynnBackend } from '../backend/tynn';
import {
    cloneAgiEnvelope,
    convertToAgiPlan,
    pushEnvelopeToOrigin,
} from '../workspace/create-agi';
import { readTynnLink } from './provision';

const execFileAsync = promisify(execFile);

/**
 * Ops-project WORKSPACE provisioning.
 *
 * An Ops project governs other (slave/child) projects. Each child has its own
 * `*.agi` envelope published on a remote. This module lets an Ops agent stand up
 * a local Genie WORKSPACE for every governed child that doesn't already have
 * one — clone the child's `*.agi` repo, register it as a workspace, surface it
 * in the rail.
 *
 * Sibling of ops-repos.ts (which manages the Ops envelope's *submodules*). Here
 * we manage local *workspaces* instead. Like that module the work is split into
 * a read-only PLAN (which children are present vs. missing) and an APPLY that
 * only ever runs on the user's approval (or when the auto-provision toggle is
 * on). This is PROVISION-ONLY: extra/un-governed workspaces are never removed.
 *
 * Tynn does NOT store a child's `*.agi` repo URL — Genie resolves it. For a
 * child that already has a local workspace we read that workspace's `origin`;
 * for a missing one we build the conventional `github.com/<owner>/<name>.agi`
 * URL. When the child has a registered PRIMARY repo we derive both the owner
 * and the name from THAT repo (the envelope lives beside the code repo, e.g.
 * `Renaissance-Analytics/wondermill.agi`, NOT at the project slug); otherwise we
 * fall back to the owner *slug* + project *slug* (NOT the display name, which
 * has spaces). The resolved URL rides in the plan so the user sees exactly what
 * will be cloned before approving.
 */

/** Whether a missing child's envelope repo actually exists on its remote. */
export type ChildRemoteState = 'exists' | 'not-found' | 'auth-required' | 'unknown';

/** A governed child and where it stands locally. */
export interface OpsChildStatus {
    /** The child's Tynn project id. */
    projectId: string;
    /** The child's Tynn project name (display). */
    name: string;
    /** The child's slug (drives the workspace folder + repo name). */
    slug: string;
    /** 'present' = a local workspace already exists; 'missing' = none yet. */
    status: 'present' | 'missing';
    /**
     * For a 'missing' child: the `*.agi` repo URL Genie would clone. Null when
     * it can't be resolved (no owner to build the conventional URL) — such a
     * child can't be provisioned automatically and is reported, not cloned.
     */
    cloneUrl: string | null;
    /**
     * For a 'missing' child with a cloneUrl: whether that repo actually EXISTS
     * on the remote (probed with `git ls-remote`). The conventional URL is a
     * GUESS — a child whose envelope was never published probes 'not-found'
     * and needs `scaffold`, not `provision`. Null when not probed (present
     * children, or no URL to probe).
     */
    remote: ChildRemoteState | null;
    /**
     * The child's SOURCE repo URL (its registered primary code repo), when
     * known — what `scaffold` builds the new envelope around. Null when the
     * child has no registered repo.
     */
    sourceRepoUrl: string | null;
    /** The local workspace path, when 'present'. */
    workspacePath?: string;
}

export interface OpsProvisionPlan {
    /** True when the linked Tynn project is an Ops project. */
    isOps: boolean;
    /** False when not signed in to Tynn (can't fetch the children). */
    signedIn: boolean;
    /** Every governed child + its local status. */
    children: OpsChildStatus[];
    /** The destination parent folder new workspaces are cloned into. */
    parentPath: string;
    /** Whether the auto-provision toggle is on (apply skips the approval gate). */
    autoProvision: boolean;
}

/** A child the apply step will actually clone (resolved subset of the plan). */
export interface OpsProvisionTarget {
    projectId: string;
    name: string;
    slug: string;
    cloneUrl: string;
}

/** Whether the ops auto-provision-workspaces toggle is ON (default off). */
export function opsAutoProvisionEnabled(): boolean {
    try {
        return getAllSettings().ops_auto_provision_workspaces === 'on';
    } catch {
        return false;
    }
}

/** The slave fields that drive `*.agi` clone-URL derivation. */
export interface ChildAgiUrlSource {
    /** Owner *slug* (org/user slug, e.g. `civicognita`). Fallback owner. */
    ownerSlug: string | null | undefined;
    /** Project slug. Fallback repo name. */
    slug: string;
    /** GitHub owner of the child's PRIMARY repo, when registered. */
    repoOwner?: string | null;
    /** GitHub name of the child's PRIMARY repo, when registered. */
    repoName?: string | null;
}

/**
 * Build the conventional `*.agi` clone URL for a child.
 *
 * PREFERRED: when the child has a registered primary repo we use ITS GitHub
 * owner + name → `github.com/<repoOwner>/<repoName>.agi.git`. The envelope lives
 * beside the code repo (e.g. `Renaissance-Analytics/wondermill.agi`), which is
 * NOT necessarily the project slug (`wishswonderscom`).
 *
 * FALLBACK (no primary repo): the owner *slug* + project *slug* →
 * `github.com/<ownerSlug>/<slug>.agi.git`, mirroring createAgiEnvelope's
 * auto-remote shape. Pass the owner *slug* (never the display name — it has
 * spaces and yields an invalid URL).
 *
 * Returns null when neither form can be built — we never guess a URL we can't
 * form. The resolved URL is surfaced for approval, since a GitHub login may
 * still differ from the Tynn slug.
 */
export function childAgiCloneUrl(src: ChildAgiUrlSource): string | null {
    const repoOwner = src.repoOwner?.trim();
    const repoName = src.repoName?.trim();
    if (repoOwner && repoName) {
        return `https://github.com/${repoOwner}/${repoName}.agi.git`;
    }

    const owner = src.ownerSlug?.trim();
    if (owner && src.slug.trim()) {
        return `https://github.com/${owner}/${src.slug}.agi.git`;
    }

    return null;
}

/**
 * Classify a `git ls-remote` / `git clone` failure by its stderr. PURE — the
 * strings are git's stable user-facing errors across transports:
 *   - "repository '…' not found" / "Repository not found" → the repo does not
 *     exist (or this account can't see it — GitHub deliberately conflates the
 *     two; for OUR conventional-URL probe, not-found is the honest reading).
 *   - credential prompts / permission errors → reachable but needs auth.
 */
export function classifyGitRemoteError(stderr: string): ChildRemoteState {
    const s = (stderr ?? '').toLowerCase();
    if (/repository .* not found|not found/.test(s) && /repository|remote/.test(s)) {
        return 'not-found';
    }
    if (
        /authentication failed|could not read username|permission denied|access denied|403/.test(s)
    ) {
        return 'auth-required';
    }
    return 'unknown';
}

/** Probe whether a remote repo exists, without cloning. `GIT_TERMINAL_PROMPT=0`
 *  so a private/auth-walled remote fails fast instead of hanging on a prompt. */
export type RemoteProbe = (url: string) => Promise<ChildRemoteState>;

export async function probeRemote(url: string): Promise<ChildRemoteState> {
    try {
        await execFileAsync('git', ['ls-remote', '--heads', url], {
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            timeout: 15_000,
            maxBuffer: 4 * 1024 * 1024,
        });
        return 'exists';
    } catch (e) {
        const err = e as { stderr?: string; killed?: boolean };
        if (err.killed) return 'unknown'; // timeout — don't claim either way
        return classifyGitRemoteError((err.stderr ?? '').toString());
    }
}

/** The child's SOURCE (primary code) repo URL, when registered. */
export function childSourceRepoUrl(src: ChildAgiUrlSource): string | null {
    const owner = src.repoOwner?.trim();
    const name = src.repoName?.trim();
    return owner && name ? `https://github.com/${owner}/${name}.git` : null;
}

/**
 * Resolve the default parent folder new child workspaces are cloned into: the
 * Ops envelope's OWN parent directory, so governed projects sit beside it.
 */
function defaultParentPath(opsWorkspacePath: string): string {
    return path.dirname(opsWorkspacePath);
}

/**
 * Compute the provisioning plan for an Ops workspace. Read-only — never touches
 * disk. Returns isOps=false when the workspace isn't linked to an Ops Tynn
 * project (the caller surfaces a "not an ops project" message).
 */
export async function computeOpsProvisionPlan(
    opsWorkspacePath: string,
    /** Injectable for tests; defaults to the real `git ls-remote` probe. */
    probe: RemoteProbe = probeRemote,
): Promise<OpsProvisionPlan> {
    const parentPath = defaultParentPath(opsWorkspacePath);
    const autoProvision = opsAutoProvisionEnabled();
    const base: OpsProvisionPlan = {
        isOps: false,
        signedIn: false,
        children: [],
        parentPath,
        autoProvision,
    };

    const link = readTynnLink(opsWorkspacePath);
    if (!link?.projectId) return base;

    const backend = new TynnBackend();
    const signedIn = !!(await backend.whoami());
    if (!signedIn) return base;

    const { isOpsProject, slaves } = await backend.opsSlaves(link.projectId);
    if (!isOpsProject) return { ...base, signedIn: true };

    // child Tynn project id → local workspace. Presence is keyed off the
    // workspace ROW's tynn_project_id (set when Genie provisions/registers a
    // workspace) — provisioned envelopes often have no `tynn.projectId` in their
    // project.json, so reading the link alone reports every child as 'missing'.
    // Fall back to the project.json link for rows lacking the field.
    const localByProjectId = new Map<string, { path: string }>();
    for (const ws of listWorkspaces()) {
        const projectId = ws.tynn_project_id || readTynnLink(ws.path)?.projectId;
        if (projectId) localByProjectId.set(projectId, { path: ws.path });
    }

    const children: OpsChildStatus[] = slaves.map((s) => {
        const local = localByProjectId.get(s.id);
        const urlSource: ChildAgiUrlSource = {
            ownerSlug: s.owner_slug,
            slug: s.slug,
            repoOwner: s.repo_owner,
            repoName: s.repo_name,
        };
        if (local) {
            return {
                projectId: s.id,
                name: s.name,
                slug: s.slug,
                status: 'present',
                cloneUrl: null,
                remote: null,
                sourceRepoUrl: childSourceRepoUrl(urlSource),
                workspacePath: local.path,
            };
        }
        return {
            projectId: s.id,
            name: s.name,
            slug: s.slug,
            status: 'missing',
            cloneUrl: childAgiCloneUrl(urlSource),
            remote: null,
            sourceRepoUrl: childSourceRepoUrl(urlSource),
        };
    });

    // The conventional cloneUrl is a GUESS — verify each missing child's repo
    // actually exists before anyone treats it as clonable (a URL that 404s used
    // to be advertised as "missing (clonable)" and then die mid-provision).
    // Parallel: one ls-remote per missing child.
    await Promise.all(
        children
            .filter((c) => c.status === 'missing' && c.cloneUrl)
            .map(async (c) => {
                try {
                    c.remote = await probe(c.cloneUrl!);
                } catch {
                    c.remote = 'unknown';
                }
            }),
    );

    return { isOps: true, signedIn: true, children, parentPath, autoProvision };
}

/**
 * Provisionable targets from a plan: missing children whose envelope repo
 * actually EXISTS on the remote ('unknown' — e.g. a probe timeout — is still
 * attempted so a flaky network can't block provisioning; a probed 'not-found'
 * or 'auth-required' is NOT, and is reported instead of dying mid-clone).
 */
export function provisionTargets(plan: OpsProvisionPlan): OpsProvisionTarget[] {
    return plan.children
        .filter(
            (c): c is OpsChildStatus & { cloneUrl: string } =>
                c.status === 'missing' &&
                !!c.cloneUrl &&
                (c.remote === 'exists' || c.remote === 'unknown' || c.remote === null),
        )
        .map((c) => ({
            projectId: c.projectId,
            name: c.name,
            slug: c.slug,
            cloneUrl: c.cloneUrl,
        }));
}

/** A child the scaffold step will build an envelope for. */
export interface OpsScaffoldTarget {
    projectId: string;
    name: string;
    slug: string;
    /** The envelope repo to CREATE (the conventional `*.agi` URL). */
    envelopeUrl: string;
    /** The child's existing source repo, added as the envelope's submodule. */
    sourceRepoUrl: string;
}

/**
 * Scaffoldable targets: missing children whose envelope repo does NOT exist on
 * the remote but whose SOURCE repo is registered — `scaffold` builds the
 * `<slug>.agi` envelope around that source repo and publishes it.
 */
export function scaffoldTargets(plan: OpsProvisionPlan): OpsScaffoldTarget[] {
    return plan.children
        .filter(
            (c): c is OpsChildStatus & { cloneUrl: string; sourceRepoUrl: string } =>
                c.status === 'missing' &&
                c.remote === 'not-found' &&
                !!c.cloneUrl &&
                !!c.sourceRepoUrl,
        )
        .map((c) => ({
            projectId: c.projectId,
            name: c.name,
            slug: c.slug,
            envelopeUrl: c.cloneUrl,
            sourceRepoUrl: c.sourceRepoUrl,
        }));
}

export interface OpsProvisionResult {
    /** Children whose workspace was cloned + registered (by name). */
    provisioned: Array<{ name: string; workspaceId: string; path: string }>;
    /** Per-child failures — best-effort, one bad child never aborts the batch. */
    errors: string[];
}

/**
 * Clone + register a workspace for each APPROVED target. Each op is best-effort;
 * failures are collected, not thrown. A child whose workspace already exists
 * (someone provisioned it between plan + apply) is skipped, not re-cloned. Must
 * only be called with the user's approval OR when the auto-provision toggle is
 * on — the gating itself lives in the MCP handler, like manageProcess.
 */
export async function applyOpsProvision(
    opsWorkspacePath: string,
    targets: OpsProvisionTarget[],
): Promise<OpsProvisionResult> {
    const provisioned: OpsProvisionResult['provisioned'] = [];
    const errors: string[] = [];
    const parentPath = defaultParentPath(opsWorkspacePath);
    const settings = getAllSettings();

    // A child already registered (by its Tynn project id == workspace id) is a
    // no-op — never re-clone over an existing workspace.
    const existingIds = new Set(listWorkspaces().map((w) => w.id));

    for (const t of targets) {
        if (existingIds.has(t.projectId)) continue;
        try {
            const { path: wsPath } = await cloneAgiEnvelope({
                url: t.cloneUrl,
                parent_path: parentPath,
                folder: t.slug,
            });
            const saved = addWorkspace({
                id: t.projectId,
                backend: 'tynn',
                project_id: t.projectId,
                project_name: t.name,
                tynn_project_id: t.projectId,
                tynn_project_name: t.name,
                shape: 'agi',
                path: wsPath,
                editor: null,
                editor_cmd: null,
                start_cmd: null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 1,
            });
            provisioned.push({ name: t.name, workspaceId: saved.id, path: wsPath });
            existingIds.add(saved.id);
        } catch (e) {
            errors.push(`${t.name}: ${describeCloneFailure(e, t.cloneUrl)}`);
        }
    }

    return { provisioned, errors };
}

/** A clone failure the caller can ACT on — not-found vs auth vs raw error. */
export function describeCloneFailure(e: unknown, url: string): string {
    const raw = e instanceof Error ? e.message : String(e);
    switch (classifyGitRemoteError(raw)) {
        case 'not-found':
            return `envelope repo not found at ${url} — it may not exist yet (use action:"scaffold" to create it from the child's source repo)`;
        case 'auth-required':
            return `authentication failed for ${url} — check the git credentials this Genie uses for that host`;
        default:
            return raw;
    }
}

/** What applyOpsScaffold needs from the GitHub layer, injected so this module
 *  stays github-free and unit-testable. Must create (or reuse an existing
 *  empty) repo at the given owner/name and never return a half-state. */
export type CreateRemoteRepo = (opts: {
    owner: string;
    name: string;
    description: string;
}) => Promise<{ clone_url: string }>;

export interface OpsScaffoldResult {
    /** Children whose envelope was scaffolded + published + registered. */
    scaffolded: Array<{ name: string; workspaceId: string; path: string }>;
    /** Per-child failures — best-effort, one bad child never aborts the batch. */
    errors: string[];
}

/** owner/name of the conventional envelope URL (…github.com/<owner>/<name>.git). */
export function parseEnvelopeUrl(url: string): { owner: string; name: string } | null {
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url.trim());
    return m ? { owner: m[1], name: m[2] } : null;
}

/**
 * SCAFFOLD a missing envelope for each approved target (genie#6): build the
 * `<slug>.agi` envelope locally with the child's SOURCE repo as its submodule,
 * create the envelope repo on GitHub, push, and register the workspace. Each
 * child is best-effort; a failure after the local build still leaves a working
 * local envelope (reported so the user can push later). Must only run with the
 * user's approval — the gate lives in the MCP handler.
 */
export async function applyOpsScaffold(
    opsWorkspacePath: string,
    targets: OpsScaffoldTarget[],
    createRemoteRepo: CreateRemoteRepo,
): Promise<OpsScaffoldResult> {
    const scaffolded: OpsScaffoldResult['scaffolded'] = [];
    const errors: string[] = [];
    const parentPath = defaultParentPath(opsWorkspacePath);
    const settings = getAllSettings();
    const existingIds = new Set(listWorkspaces().map((w) => w.id));

    for (const t of targets) {
        if (existingIds.has(t.projectId)) continue;
        try {
            const parsed = parseEnvelopeUrl(t.envelopeUrl);
            if (!parsed) throw new Error(`unrecognised envelope URL ${t.envelopeUrl}`);

            // 1. Local envelope: skeleton + the source repo as repos/<name>.
            const subName = deriveEnvelopeSubName(t.sourceRepoUrl);
            const built = await convertToAgiPlan({
                slug: t.slug,
                name: t.name,
                parent_path: parentPath,
                repos: [
                    { source: t.sourceRepoUrl, is_local: false, submodule_name: subName },
                ],
                knowledge: [],
                remote: { kind: 'paste', url: t.envelopeUrl },
            });

            // 2. Create the remote (idempotent for an empty leftover) + push.
            // A failure HERE keeps the local envelope — report it actionably.
            let pushed = true;
            let pushNote = '';
            try {
                await createRemoteRepo({
                    owner: parsed.owner,
                    name: parsed.name,
                    description: `${t.name} — .agi envelope (scaffolded by Genie)`,
                });
                await pushEnvelopeToOrigin(built.path, 'main');
            } catch (e) {
                pushed = false;
                pushNote = e instanceof Error ? e.message : String(e);
            }

            // 3. Register the workspace either way — the envelope exists and works
            // locally; publishing can be retried from git.
            const saved = addWorkspace({
                id: t.projectId,
                backend: 'tynn',
                project_id: t.projectId,
                project_name: t.name,
                tynn_project_id: t.projectId,
                tynn_project_name: t.name,
                shape: 'agi',
                path: built.path,
                editor: null,
                editor_cmd: null,
                start_cmd: null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 1,
            });
            scaffolded.push({ name: t.name, workspaceId: saved.id, path: built.path });
            existingIds.add(saved.id);
            if (!pushed) {
                errors.push(
                    `${t.name}: envelope scaffolded locally at ${built.path} but publishing to ${t.envelopeUrl} failed — ${pushNote}`,
                );
            }
        } catch (e) {
            errors.push(`${t.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return { scaffolded, errors };
}

/** Submodule dir name for the child's source repo (its repo basename). */
function deriveEnvelopeSubName(sourceRepoUrl: string): string {
    const base = sourceRepoUrl
        .replace(/[/\\]+$/, '')
        .split(/[/\\:]/)
        .pop() ?? 'app';
    const name = base.replace(/\.git$/i, '') || 'app';
    return /^[A-Za-z0-9._-]+$/.test(name) ? name : 'app';
}

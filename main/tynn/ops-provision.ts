import path from 'path';
import { addWorkspace, getAllSettings, listWorkspaces } from '../db';
import { TynnBackend } from '../backend/tynn';
import { cloneAgiEnvelope } from '../workspace/create-agi';
import { readTynnLink } from './provision';

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
 * for a missing one we build the conventional `github.com/<owner>/<slug>.agi`
 * URL (the same shape createAgiEnvelope uses for its auto-remote). The resolved
 * URL rides in the plan so the user sees exactly what will be cloned before
 * approving.
 */

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

/**
 * Build the conventional `*.agi` clone URL for a child from its owner + slug.
 * Mirrors createAgiEnvelope's auto-remote shape
 * (`https://github.com/<owner>/<slug>.agi.git`). Returns null without an owner —
 * we never guess a URL we can't form. The GitHub owner *login* may differ from
 * the Tynn display name, which is why the URL is surfaced for approval.
 */
export function childAgiCloneUrl(
    owner: string | null | undefined,
    slug: string,
): string | null {
    const o = owner?.trim();
    if (!o || !slug.trim()) return null;
    return `https://github.com/${o}/${slug}.agi.git`;
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

    // child Tynn project id → local workspace (by that workspace's tynn link).
    const localByProjectId = new Map<string, { path: string }>();
    for (const ws of listWorkspaces()) {
        const wl = readTynnLink(ws.path);
        if (wl?.projectId) localByProjectId.set(wl.projectId, { path: ws.path });
    }

    const children: OpsChildStatus[] = slaves.map((s) => {
        const local = localByProjectId.get(s.id);
        if (local) {
            return {
                projectId: s.id,
                name: s.name,
                slug: s.slug,
                status: 'present',
                cloneUrl: null,
                workspacePath: local.path,
            };
        }
        return {
            projectId: s.id,
            name: s.name,
            slug: s.slug,
            status: 'missing',
            cloneUrl: childAgiCloneUrl(s.owner_name, s.slug),
        };
    });

    return { isOps: true, signedIn: true, children, parentPath, autoProvision };
}

/** Provisionable targets from a plan: missing children that have a clone URL. */
export function provisionTargets(plan: OpsProvisionPlan): OpsProvisionTarget[] {
    return plan.children
        .filter(
            (c): c is OpsChildStatus & { cloneUrl: string } =>
                c.status === 'missing' && !!c.cloneUrl,
        )
        .map((c) => ({
            projectId: c.projectId,
            name: c.name,
            slug: c.slug,
            cloneUrl: c.cloneUrl,
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
                editor: settings.default_editor ?? 'cursor',
                editor_cmd: settings.default_editor_cmd ?? null,
                start_cmd: settings.default_start_cmd ?? null,
                env_file: settings.default_env_file ?? '.env',
                last_opened_at: null,
                created_by_genie: 1,
            });
            provisioned.push({ name: t.name, workspaceId: saved.id, path: wsPath });
            existingIds.add(saved.id);
        } catch (e) {
            errors.push(
                `${t.name}: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }

    return { provisioned, errors };
}

import { execFile } from 'child_process';
import { promisify } from 'util';
import { simpleGit } from 'simple-git';
import { listWorkspaces } from '../db';
import { TynnBackend } from '../backend/tynn';
import {
    readProjectJson,
    writeProjectJson,
    type ProjectJsonRepo,
} from '../workspace/project-json';
import { readTynnLink } from './provision';

const execFileAsync = promisify(execFile);

/**
 * Ops-project repo auto-management.
 *
 * An Ops project is knowledge-only (no repo of its own) but governs other
 * projects. Its envelope's repos should be the `*.agi` envelopes of the
 * projects it's connected to (its slaves). Tynn knows the slaves; Genie resolves
 * each slave's `*.agi` repo by matching it to a LOCAL workspace (by the slave's
 * Tynn project id, stored in that workspace's project.json `tynn` block) and
 * reading that workspace's `origin` remote. We compute a PLAN (read-only) and
 * only mutate the envelope on EXPLICIT user approval. Only repos Genie added
 * (`managedByOps`) are eligible for automatic removal — hand-added repos are
 * never touched.
 */

export interface OpsRepoDesired {
    /** repos/<name> submodule dir (the slave's slug). */
    name: string;
    /** The slave envelope's `origin` remote (its `*.agi` repo). */
    url: string;
    /** The slave's Tynn project id. */
    projectId: string;
}

export interface OpsRepoPlan {
    /** True when the linked Tynn project is an Ops project. */
    isOps: boolean;
    /** False when not signed in to Tynn (can't fetch slaves). */
    signedIn: boolean;
    toAdd: OpsRepoDesired[];
    toRemove: Array<{ name: string }>;
    /** Slaves with no matching local workspace — their repo can't be resolved. */
    missingLocally: Array<{ name: string; projectId: string }>;
}

/**
 * Pure reconcile: which desired (slave) repos are missing from the envelope,
 * and which Genie-managed repos are no longer desired. Compares by URL so a
 * repo present under any name counts as present. Only `managedByOps` repos are
 * candidates for removal.
 */
export function diffOpsRepos(
    desired: OpsRepoDesired[],
    current: ProjectJsonRepo[],
): { toAdd: OpsRepoDesired[]; toRemove: Array<{ name: string }> } {
    const currentUrls = new Set(current.map((c) => c.url).filter((u): u is string => !!u));
    const desiredUrls = new Set(desired.map((d) => d.url));

    const toAdd = desired.filter((d) => !currentUrls.has(d.url));
    const toRemove = current
        .filter((c) => c.managedByOps && c.url && !desiredUrls.has(c.url))
        .map((c) => ({ name: c.name }));

    return { toAdd, toRemove };
}

async function originUrl(wsPath: string): Promise<string | null> {
    try {
        const out = await simpleGit(wsPath).getConfig('remote.origin.url');
        return out.value?.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Compute the Ops-repo reconcile plan for a workspace. Read-only — never
 * mutates git or project.json. Returns isOps=false when the workspace isn't
 * linked to an Ops Tynn project.
 */
export async function computeOpsRepoPlan(opsWorkspacePath: string): Promise<OpsRepoPlan> {
    const base: OpsRepoPlan = {
        isOps: false,
        signedIn: false,
        toAdd: [],
        toRemove: [],
        missingLocally: [],
    };

    const link = readTynnLink(opsWorkspacePath);
    if (!link?.projectId) return base;

    const backend = new TynnBackend();
    const signedIn = !!(await backend.whoami());
    if (!signedIn) return base;

    const { isOpsProject, slaves } = await backend.opsSlaves(link.projectId);
    if (!isOpsProject) return { ...base, signedIn: true };

    // slave Tynn project id → local workspace path (by that workspace's link).
    const localByProjectId = new Map<string, string>();
    for (const ws of listWorkspaces()) {
        const wl = readTynnLink(ws.path);
        if (wl?.projectId) localByProjectId.set(wl.projectId, ws.path);
    }

    const desired: OpsRepoDesired[] = [];
    const missingLocally: Array<{ name: string; projectId: string }> = [];
    for (const s of slaves) {
        const wsPath = localByProjectId.get(s.id);
        const url = wsPath ? await originUrl(wsPath) : null;
        if (wsPath && url) {
            desired.push({ name: s.slug || s.id, url, projectId: s.id });
        } else {
            missingLocally.push({ name: s.slug || s.name, projectId: s.id });
        }
    }

    const current = readProjectJson(opsWorkspacePath)?.repos ?? [];
    const { toAdd, toRemove } = diffOpsRepos(desired, current);

    return { isOps: true, signedIn: true, toAdd, toRemove, missingLocally };
}

/**
 * Apply an APPROVED subset of the plan: add the given slave repos as submodules
 * (marked `managedByOps`) and/or remove the named managed repos. Each op is
 * best-effort; failures are collected, not thrown, so one bad repo doesn't
 * abort the batch. Must only be called with the user's explicit approval.
 */
export async function applyOpsRepoPlan(
    opsWorkspacePath: string,
    approved: { add?: OpsRepoDesired[]; remove?: string[] },
): Promise<{ added: string[]; removed: string[]; errors: string[] }> {
    const added: string[] = [];
    const removed: string[] = [];
    const errors: string[] = [];

    for (const a of approved.add ?? []) {
        try {
            await execFileAsync('git', ['submodule', 'add', a.url, `repos/${a.name}`], {
                cwd: opsWorkspacePath,
                maxBuffer: 64 * 1024 * 1024,
            });
            const pj = readProjectJson(opsWorkspacePath) ?? {};
            const repos = [...(pj.repos ?? [])];
            if (!repos.some((r) => r.name === a.name)) {
                repos.push({
                    name: a.name,
                    url: a.url,
                    path: `repos/${a.name}`,
                    role: 'package',
                    managedByOps: true,
                });
            }
            writeProjectJson(opsWorkspacePath, { repos });
            added.push(a.name);
        } catch (e) {
            errors.push(`add ${a.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    for (const name of approved.remove ?? []) {
        try {
            await execFileAsync('git', ['submodule', 'deinit', '-f', `repos/${name}`], {
                cwd: opsWorkspacePath,
            });
            await execFileAsync('git', ['rm', '-f', `repos/${name}`], { cwd: opsWorkspacePath });
            const pj = readProjectJson(opsWorkspacePath) ?? {};
            writeProjectJson(opsWorkspacePath, {
                repos: (pj.repos ?? []).filter((r) => r.name !== name),
            });
            removed.push(name);
        } catch (e) {
            errors.push(`remove ${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    return { added, removed, errors };
}

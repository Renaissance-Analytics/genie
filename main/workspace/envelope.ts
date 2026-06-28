import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
    readProjectJson,
    writeProjectJson,
    type ProjectJsonRepo,
    type ProjectJsonRepoRole,
} from './project-json';
import { detectFolder } from './detect';

const execFileAsync = promisify(execFile);

/**
 * Per-workspace ENVELOPE management for the workspace settings window: the repo
 * registry (project.json `repos[]` + the git submodules under `repos/`) and the
 * `.ai/` knowledge folders. A plain-folder (non-`.agi`) workspace has neither —
 * the `is*` flags report false so the settings UI hides those sections.
 *
 * Mutations mirror the Ops repo reconcile (git submodule add / deinit + rm, then
 * project.json) and leave the change STAGED — the user commits it through their
 * normal git flow, exactly like the Ops-managed repo panel does.
 */

/** A member repo as the settings UI sees it: registry truth + on-disk reality. */
export interface EnvelopeRepoView {
    name: string;
    url: string | null;
    role: ProjectJsonRepoRole | null;
    /** Checkout path inside the envelope (`repos/<name>`). */
    path: string;
    /** Present in project.json `repos[]`. */
    inRegistry: boolean;
    /** A git checkout exists at `repos/<name>` on disk. */
    onDisk: boolean;
}

/**
 * Standard `.ai/` knowledge subfolders, mirroring the upgrade wizard's
 * KNOWLEDGE_TARGETS. `knowledge` is the canonical one; the rest are the
 * companion buckets an envelope organises shared context into.
 */
export const KNOWLEDGE_DIRS = [
    'knowledge',
    'plans',
    'pm',
    'chat',
    'memory',
    'issues',
] as const;

export interface KnowledgeFolderView {
    name: string;
    /** Envelope-relative path, e.g. `.ai/knowledge`. */
    relPath: string;
    exists: boolean;
    /** Number of entries directly inside (0 when absent; `.gitkeep` excluded). */
    entryCount: number;
}

/** Git-safe submodule directory name (mirrors convertToAgiPlan's validation). */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * True when a folder is (or is becoming) a `.agi` envelope — a full envelope, or
 * a pre-init one with repos/ but no root git yet. Plain repos / folders are not.
 */
function isEnvelopeFolder(workspacePath: string): boolean {
    const det = detectFolder(workspacePath);
    return det.state === 'FULL_ENVELOPE' || det.state === 'PRE_INIT';
}

/**
 * Pure: join the project.json registry with the repo folders actually on disk
 * into one de-duplicated, name-sorted view. A repo can be in the registry but
 * uncloned (`onDisk:false`), or on disk but unregistered (`inRegistry:false` —
 * e.g. a hand-added submodule project.json never learned about).
 */
export function mergeRepoViews(
    registry: ProjectJsonRepo[],
    onDiskNames: string[],
): EnvelopeRepoView[] {
    const onDisk = new Set(onDiskNames);
    const byName = new Map<string, EnvelopeRepoView>();
    for (const r of registry) {
        byName.set(r.name, {
            name: r.name,
            url: r.url ?? null,
            role: r.role ?? null,
            path: r.path ?? `repos/${r.name}`,
            inRegistry: true,
            onDisk: onDisk.has(r.name),
        });
    }
    for (const name of onDiskNames) {
        if (byName.has(name)) continue;
        byName.set(name, {
            name,
            url: null,
            role: null,
            path: `repos/${name}`,
            inRegistry: false,
            onDisk: true,
        });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface EnvelopeReposResult {
    isEnvelope: boolean;
    repos: EnvelopeRepoView[];
}

/** Read the workspace's envelope repos (registry ∪ on-disk). */
export function listEnvelopeRepos(workspacePath: string): EnvelopeReposResult {
    if (!isEnvelopeFolder(workspacePath)) return { isEnvelope: false, repos: [] };
    const registry = readProjectJson(workspacePath)?.repos ?? [];
    const onDisk = detectFolder(workspacePath).repos ?? [];
    return { isEnvelope: true, repos: mergeRepoViews(registry, onDisk) };
}

export interface RepoMutationResult {
    ok: boolean;
    error?: string;
}

/**
 * Add a repo to the envelope: `git submodule add <url> repos/<name>`, then record
 * it in project.json as a `package`. Mirrors the Ops add path; the change is left
 * staged (not committed). Validates the name (git submodule path charset) and
 * refuses a duplicate before touching git.
 */
export async function addEnvelopeRepo(
    workspacePath: string,
    url: string,
    name: string,
): Promise<RepoMutationResult> {
    const cleanUrl = url.trim();
    const cleanName = name.trim();
    if (!cleanUrl) return { ok: false, error: 'Enter the repository URL.' };
    if (!NAME_RE.test(cleanName)) {
        return { ok: false, error: 'Name must use only letters, numbers, . _ or -.' };
    }
    const existing = readProjectJson(workspacePath)?.repos ?? [];
    if (existing.some((r) => r.name === cleanName)) {
        return { ok: false, error: `A repo named "${cleanName}" already exists.` };
    }
    try {
        await execFileAsync(
            'git',
            ['submodule', 'add', cleanUrl, `repos/${cleanName}`],
            { cwd: workspacePath, maxBuffer: 64 * 1024 * 1024 },
        );
        const pj = readProjectJson(workspacePath) ?? {};
        const repos = [...(pj.repos ?? [])];
        if (!repos.some((r) => r.name === cleanName)) {
            repos.push({
                name: cleanName,
                url: cleanUrl,
                path: `repos/${cleanName}`,
                role: 'package',
            });
        }
        writeProjectJson(workspacePath, { repos });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Remove a repo from the envelope: `git submodule deinit -f` + `git rm -f` (both
 * best-effort — a registry-only entry has nothing on disk to drop), then drop it
 * from project.json. The change is left staged. The `host` repo can't be removed
 * here — it's the build target; orphaning it would break the envelope.
 */
export async function removeEnvelopeRepo(
    workspacePath: string,
    name: string,
): Promise<RepoMutationResult> {
    const pj = readProjectJson(workspacePath) ?? {};
    const entry = (pj.repos ?? []).find((r) => r.name === name);
    if (entry?.role === 'host') {
        return { ok: false, error: 'Can’t remove the host repo (the build target).' };
    }
    await execFileAsync('git', ['submodule', 'deinit', '-f', `repos/${name}`], {
        cwd: workspacePath,
    }).catch(() => {});
    await execFileAsync('git', ['rm', '-f', `repos/${name}`], {
        cwd: workspacePath,
    }).catch(() => {});
    // Always unregister — the user asked to remove it, and a registry-only entry
    // (no submodule on disk) is removed by this step alone.
    writeProjectJson(workspacePath, {
        repos: (pj.repos ?? []).filter((r) => r.name !== name),
    });
    return { ok: true };
}

export interface KnowledgeResult {
    isEnvelope: boolean;
    /** Whether the `.ai/` folder itself exists. */
    aiExists: boolean;
    folders: KnowledgeFolderView[];
}

/** The standard `.ai/` knowledge folders + whether each exists and how full. */
export function listKnowledgeFolders(workspacePath: string): KnowledgeResult {
    if (!isEnvelopeFolder(workspacePath)) {
        return { isEnvelope: false, aiExists: false, folders: [] };
    }
    const aiDir = path.join(workspacePath, '.ai');
    const aiExists = fs.existsSync(aiDir);
    const folders: KnowledgeFolderView[] = KNOWLEDGE_DIRS.map((name) => {
        const abs = path.join(aiDir, name);
        let exists = false;
        let entryCount = 0;
        try {
            if (fs.statSync(abs).isDirectory()) {
                exists = true;
                entryCount = fs
                    .readdirSync(abs)
                    .filter((n) => n !== '.gitkeep').length;
            }
        } catch {
            /* absent — exists stays false */
        }
        return { name, relPath: `.ai/${name}`, exists, entryCount };
    });
    return { isEnvelope: true, aiExists, folders };
}

/**
 * Scaffold a standard `.ai/<name>` knowledge folder (with a `.gitkeep` so the
 * empty folder is committable). Only the known KNOWLEDGE_DIRS are allowed, so
 * the renderer can't create arbitrary paths.
 */
export async function createKnowledgeFolder(
    workspacePath: string,
    name: string,
): Promise<RepoMutationResult> {
    if (!(KNOWLEDGE_DIRS as readonly string[]).includes(name)) {
        return { ok: false, error: 'Unknown knowledge folder.' };
    }
    try {
        const abs = path.join(workspacePath, '.ai', name);
        await fsp.mkdir(abs, { recursive: true });
        const keep = path.join(abs, '.gitkeep');
        if (!fs.existsSync(keep)) await fsp.writeFile(keep, '', 'utf8');
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

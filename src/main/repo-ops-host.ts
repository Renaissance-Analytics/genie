import { join } from 'node:path';
import { addRepo, listRepos, removeRepo, type RepoEntry } from '../core/repo-registry.js';

/**
 * REPO OPERATIONS IN THE APP (§6.1) — the main-process half over the pure registry. Reads the envelope's
 * project.json through ports, applies the rule, writes the manifest back. A workspace without a manifest is
 * told to convert first; a folder that does not exist is refused before anything is written; the host repo
 * cannot be removed. Every refusal is a reason the surface shows.
 */

export interface RepoOpsPorts {
    readonly fs: {
        exists(path: string): Promise<boolean>;
        readJson(path: string): Promise<unknown>;
        writeJson(path: string, value: unknown): Promise<void>;
    };
    readonly registry: { workspace(id: string): { id: string; path: string } | null };
}

type Manifest = { ok: true; path: string; manifest: Record<string, unknown> } | { ok: false; reason: string };

async function manifestOf(ports: RepoOpsPorts, workspaceId: string): Promise<Manifest> {
    const ws = ports.registry.workspace(workspaceId);
    if (!ws) return { ok: false, reason: `no workspace "${workspaceId}"` };
    const path = join(ws.path, 'project.json');
    const raw = await ports.fs.readJson(path);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'this workspace has no project.json; convert it to an envelope first' };
    return { ok: true, path, manifest: raw as Record<string, unknown> };
}

export async function listReposOf(ports: RepoOpsPorts, workspaceId: string): Promise<{ ok: true; repos: RepoEntry[] } | { ok: false; reason: string }> {
    const m = await manifestOf(ports, workspaceId);
    return m.ok ? { ok: true, repos: listRepos(m.manifest) } : m;
}

export async function addRepoTo(ports: RepoOpsPorts, workspaceId: string, input: { name: string; path: string; url?: string }): Promise<{ ok: true; slug: string } | { ok: false; reason: string }> {
    const m = await manifestOf(ports, workspaceId);
    if (!m.ok) return m;
    const result = addRepo(m.manifest, input);
    if (!result.ok) return result;
    const ws = ports.registry.workspace(workspaceId)!;
    const added = listRepos(result.manifest).find((r) => r.slug === result.slug)!;
    if (!(await ports.fs.exists(join(ws.path, ...added.path.split('/'))))) return { ok: false, reason: `${added.path} does not exist inside the envelope; clone or create it first` };
    await ports.fs.writeJson(m.path, result.manifest);
    return { ok: true, slug: result.slug };
}

export async function removeRepoFrom(ports: RepoOpsPorts, workspaceId: string, slug: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const m = await manifestOf(ports, workspaceId);
    if (!m.ok) return m;
    const result = removeRepo(m.manifest, slug);
    if (!result.ok) return result;
    await ports.fs.writeJson(m.path, result.manifest);
    return { ok: true };
}

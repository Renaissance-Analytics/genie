import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { folderName, workspaceDisplayName } from '../core/workspace-name.js';
import { nodeIsDirectory } from './missing-workspaces.js';
import { isInside } from './paths.js';

/**
 * "LOCATE FOLDER" (host split P7, build spec item 3; ruling R1, 2026-11-23): the registry is told where a workspace's
 * folder IS. The Dashboard offers it on a workspace whose recorded folder is not there (missing-workspaces.ts); it
 * works for a workspace that is not missing too.
 *
 * The folder the person picked (absolute, from the host's picker) must exist and be a directory, and must not be,
 * hold or sit inside the folder of ANOTHER registered workspace (a hibernated one included: only its recorded path is
 * compared, its folder is not read). When both this workspace and the picked folder name an envelope id (project.json
 * `id`) and the two differ, the folder is another envelope and is refused in words; a folder with no project.json, or
 * one that names no id, is accepted.
 *
 * On success ONLY the record's `path` changes (Registry.setWorkspacePath), and the missing look runs again at once so
 * the flag clears. Nothing is written when any check fails.
 */

export type RelocateResult = { ok: true; path: string } | { ok: false; reason: string };

export interface WorkspaceRelocatePorts {
    readonly registry: {
        /** Every registered workspace, hibernated ones included. */
        workspaceStates(): readonly { readonly id: string; readonly path: string; readonly asleep?: boolean | undefined }[];
        /** Rewrites that record's `path` and nothing else; `false` when there is no such workspace. */
        setWorkspacePath(workspaceId: string, path: string): Promise<boolean>;
    };
    readonly fs: {
        /** `true` a directory; `false` nothing there or not a directory; a rejection when the look itself failed. */
        isDirectory(path: string): Promise<boolean>;
        /** A file's text, or `null` when it cannot be read. */
        readText(path: string): Promise<string | null>;
    };
    /** Look at the folders again (MissingWorkspaces.check). Absent: this host keeps no missing flag. */
    readonly recheck?: (() => Promise<void>) | undefined;
    /** Injected by a test; the host's own rule otherwise (Windows compares paths without case). */
    readonly caseInsensitive?: boolean | undefined;
}

/** What a project.json says of its envelope: its `id` when it names one, and the name a person knows it by. */
function envelopeOf(manifest: string | null, path: string): { id: string | null; name: string } {
    let id: string | null = null;
    if (manifest !== null) {
        try {
            const parsed = JSON.parse(manifest) as { id?: unknown } | null;
            if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && parsed.id.trim().length > 0) id = parsed.id.trim();
        } catch {
            // not JSON: it names no id
        }
    }
    return { id, name: workspaceDisplayName(manifest, path) };
}

export async function relocateWorkspaceIn(ports: WorkspaceRelocatePorts, workspaceId: string, picked: string): Promise<RelocateResult> {
    const all = ports.registry.workspaceStates();
    const workspace = all.find((w) => w.id === workspaceId);
    if (!workspace) return { ok: false, reason: `no workspace "${workspaceId}"` };
    if (typeof picked !== 'string' || picked.trim().length === 0 || !isAbsolute(picked)) return { ok: false, reason: 'pick the folder by its full path' };
    const path = resolve(picked);

    let there: boolean;
    try {
        there = await ports.fs.isDirectory(path);
    } catch (error) {
        return { ok: false, reason: `Genie could not look at ${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!there) return { ok: false, reason: `${path} does not exist, or is not a folder` };

    const inside = (child: string, parent: string) => isInside(child, parent, ports.caseInsensitive);
    for (const other of all) {
        if (other.id === workspaceId) continue;
        const theirs = other.id;
        if (inside(path, other.path) && inside(other.path, path)) return { ok: false, reason: `${path} is the folder of the workspace ${theirs}` };
        if (inside(path, other.path)) return { ok: false, reason: `${path} is inside the folder of the workspace ${theirs} (${other.path})` };
        if (inside(other.path, path)) return { ok: false, reason: `${path} holds the folder of the workspace ${theirs} (${other.path})` };
    }

    // The picked folder's own account of itself. A folder with no project.json is accepted.
    const found = envelopeOf(await ports.fs.readText(join(path, 'project.json')), path);
    // This workspace's envelope id, from the folder it was in when that can still be read. A hibernated workspace's
    // folder is never read, and a folder that is gone has nothing to read: then no id is known, and none is compared.
    const unchanged = inside(path, workspace.path) && inside(workspace.path, path);
    if (found.id !== null && !unchanged && workspace.asleep !== true) {
        const own = envelopeOf(await ports.fs.readText(join(workspace.path, 'project.json')), workspace.path);
        if (own.id !== null && own.id !== found.id) {
            const mine = own.name || folderName(workspace.path) || workspaceId;
            return { ok: false, reason: `that folder is ${found.name}, not ${mine}` };
        }
    }

    if (path !== workspace.path) {
        const written = await ports.registry.setWorkspacePath(workspaceId, path);
        if (!written) return { ok: false, reason: `no workspace "${workspaceId}"` };
    }
    await ports.recheck?.();
    return { ok: true, path };
}

/** The real disk, for genie-host. */
export function nodeRelocateFs(): WorkspaceRelocatePorts['fs'] {
    return {
        isDirectory: nodeIsDirectory,
        readText: async (path) => { try { return await readFile(path, 'utf8'); } catch { return null; } },
    };
}

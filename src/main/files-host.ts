import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
    FILE_SIZE_CAP,
    activityFrom,
    attributionFrom,
    buildTree,
    changedGroups,
    confine,
    openRefusal,
    unreportedChanges,
    type Activity,
    type ChangedGroup,
    type Entry,
    type FileAttribution,
    type FileEvent,
    type TreeNode,
} from '../core/files-panel.js';

/**
 * THE FILES HOST (§4.3) — the main-process half of the one file panel per workspace. Lists a
 * workspace's tree (never `.git` or `node_modules`), opens a file by its CONFINED relative path and
 * refuses in words (outside the root, over the size cap, unreadable) rather than hand back a blank,
 * and derives attribution from the agents' own tool events through ports. A watcher records what
 * changed on disk; anything no agent reported is `unreported`, and the host never names an author it
 * was not told. Pure logic lives in `core/files-panel.ts`; this file owns the filesystem and the ports.
 */

export interface FilesHostPorts {
    readonly workspace: (id: string) => { id: string; path: string } | null;
    readonly agentsOf: (workspaceId: string) => ReadonlyArray<{ id: string; name: string }>;
    readonly eventsOf: (agentId: string) => readonly FileEvent[];
    readonly sizeCap?: number;
}

export type OpenResult = { ok: true; path: string; text: string } | { ok: false; path: string; error: string };

export interface FilesState {
    readonly files: readonly FileAttribution[];
    readonly activity: readonly Activity[];
    readonly unreported: readonly string[];
    readonly changed: readonly ChangedGroup[] | null;
}

const SKIP = new Set(['.git', 'node_modules']);
const OUTSIDE = 'that path is outside the workspace; Genie opens nothing there';

export class FilesHost {
    readonly #ports: FilesHostPorts;
    readonly #cap: number;
    readonly #watchers = new Map<string, FSWatcher>();
    readonly #changedOnDisk = new Map<string, Set<string>>();
    readonly #listeners = new Set<(workspaceId: string) => void>();

    constructor(ports: FilesHostPorts) {
        this.#ports = ports;
        this.#cap = ports.sizeCap ?? FILE_SIZE_CAP;
    }

    async tree(workspaceId: string): Promise<TreeNode[] | null> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws) return null;
        const entries: Entry[] = [];
        const walk = async (rel: string): Promise<void> => {
            const dirents = await readdir(rel ? join(ws.path, rel) : ws.path, { withFileTypes: true });
            for (const d of dirents) {
                if (SKIP.has(d.name)) continue;
                const path = rel ? `${rel}/${d.name}` : d.name;
                if (d.isDirectory()) { entries.push({ path, kind: 'dir' }); await walk(path); }
                else if (d.isFile()) entries.push({ path, kind: 'file' });
            }
        };
        await walk('');
        return buildTree(entries);
    }

    async open(workspaceId: string, path: string): Promise<OpenResult> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws) return { ok: false, path, error: 'no such workspace' };
        const rel = confine(ws.path, path);
        if (rel === null || rel === '') return { ok: false, path, error: OUTSIDE };
        const full = join(ws.path, ...rel.split('/'));
        try {
            const info = await stat(full);
            const refusal = openRefusal(info.size, this.#cap);
            if (refusal) return { ok: false, path: rel, error: refusal };
            return { ok: true, path: rel, text: await readFile(full, 'utf8') };
        } catch (error) {
            return { ok: false, path: rel, error: error instanceof Error ? error.message : String(error) };
        }
    }

    async state(workspaceId: string): Promise<FilesState | null> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws) return null;
        const events = this.#ports.agentsOf(workspaceId).flatMap((a) => this.#ports.eventsOf(a.id));
        const attribution = attributionFrom(events, ws.path);
        const unreported = unreportedChanges(attribution, [...(this.#changedOnDisk.get(workspaceId) ?? [])], ws.path);
        return {
            files: [...attribution.values()],
            activity: activityFrom(events, ws.path),
            unreported,
            changed: changedGroups(attribution, { mine: [], unreported }),
        };
    }

    /** Start recording what changes on disk in this workspace; idempotent. */
    async watch(workspaceId: string): Promise<void> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws || this.#watchers.has(workspaceId)) return;
        const watcher = watch(ws.path, { recursive: true }, (_type, filename) => {
            if (typeof filename !== 'string') return;
            const rel = confine(ws.path, filename);
            if (rel === null || rel === '' || rel.split('/').some((seg) => SKIP.has(seg))) return;
            const set = this.#changedOnDisk.get(workspaceId) ?? new Set<string>();
            set.add(rel);
            this.#changedOnDisk.set(workspaceId, set);
            for (const l of this.#listeners) l(workspaceId);
        });
        watcher.on('error', () => { /* a lost watcher means no new unreported marks; the tree still opens */ });
        this.#watchers.set(workspaceId, watcher);
    }

    onChange(listener: (workspaceId: string) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    async close(): Promise<void> {
        for (const w of this.#watchers.values()) w.close();
        this.#watchers.clear();
    }
}

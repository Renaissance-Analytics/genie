import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
    FILE_SIZE_CAP,
    activityFrom,
    attributionFrom,
    buildTree,
    changedGroups,
    confine,
    openRefusal,
    countsAsDiskChange,
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

export type OpenResult = { ok: true; path: string; text: string; sha: string } | { ok: false; path: string; error: string };

/** A write that landed answers the new sha; a refused one carries the conflict (what is on disk NOW) so nothing is discarded. */
export type WriteResult = { ok: true; sha: string } | { ok: false; reason: string; conflict?: { path: string; onDisk: string; sha: string } };

const shaOf = (text: string): string => createHash('sha256').update(text).digest('hex');

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
    /** Files YOU wrote through the panel, per workspace — yours in Changed, never `?`. */
    readonly #mine = new Map<string, Set<string>>();
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
            const text = await readFile(full, 'utf8');
            return { ok: true, path: rel, text, sha: shaOf(text) };
        } catch (error) {
            return { ok: false, path: rel, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /** Write only against what was read (§4.3): a changed file is a CONFLICT answered with the disk's text, never an overwrite. */
    async write(workspaceId: string, path: string, text: string, expectedSha: string | null): Promise<WriteResult> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws) return { ok: false, reason: 'no such workspace' };
        const rel = confine(ws.path, path);
        if (rel === null || rel === '') return { ok: false, reason: 'that path is outside the workspace; Genie writes nothing there' };
        const full = join(ws.path, ...rel.split('/'));
        let onDisk: string | null = null;
        try { onDisk = await readFile(full, 'utf8'); } catch { onDisk = null; }
        if (onDisk !== null && expectedSha !== null && shaOf(onDisk) !== expectedSha) {
            return { ok: false, reason: `${rel} changed on disk since you opened it; nothing was discarded — keep yours, take theirs, or merge`, conflict: { path: rel, onDisk, sha: shaOf(onDisk) } };
        }
        if (onDisk !== null && expectedSha === null) {
            return { ok: false, reason: `${rel} already exists; open it first so the write is against what is there`, conflict: { path: rel, onDisk, sha: shaOf(onDisk) } };
        }
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, text, 'utf8');
        const mine = this.#mine.get(workspaceId) ?? new Set<string>();
        mine.add(rel);
        this.#mine.set(workspaceId, mine);
        // Your own write is not an unreported change.
        this.#changedOnDisk.get(workspaceId)?.delete(rel);
        return { ok: true, sha: shaOf(text) };
    }

    async state(workspaceId: string): Promise<FilesState | null> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws) return null;
        const events = this.#ports.agentsOf(workspaceId).flatMap((a) => this.#ports.eventsOf(a.id));
        const attribution = attributionFrom(events, ws.path);
        const mine = [...(this.#mine.get(workspaceId) ?? [])];
        const unreported = unreportedChanges(attribution, [...(this.#changedOnDisk.get(workspaceId) ?? [])].filter((p) => !mine.includes(p)), ws.path);
        return {
            files: [...attribution.values()],
            activity: activityFrom(events, ws.path),
            unreported,
            changed: changedGroups(attribution, { mine, unreported }),
        };
    }

    /** Start recording what changes on disk in this workspace; idempotent. */
    async watch(workspaceId: string): Promise<void> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws || this.#watchers.has(workspaceId)) return;
        // Only what changes AFTER this moment is a change: macOS FSEvents replays writes made just before the
        // watcher attached (the v2.0.0-beta.5 release run saw a set-up write come back as "unreported").
        const since = Date.now();
        const watcher = watch(ws.path, { recursive: true }, (_type, filename) => {
            if (typeof filename !== 'string') return;
            const rel = confine(ws.path, filename);
            if (rel === null || rel === '' || rel.split('/').some((seg) => SKIP.has(seg))) return;
            // Windows reports the parent DIRECTORIES of a written file as changed too; only files are "changes" here.
            // A path that no longer exists is a deletion and still counts. countsAsDiskChange holds the rule.
            void stat(join(ws.path, ...rel.split('/'))).then(
                (info) => { if (countsAsDiskChange({ mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() }, since)) this.#recordChange(workspaceId, rel); },
                () => { if (countsAsDiskChange(null, since)) this.#recordChange(workspaceId, rel); },
            );
        });
        watcher.on('error', () => { /* a lost watcher means no new unreported marks; the tree still opens */ });
        this.#watchers.set(workspaceId, watcher);
    }

    #recordChange(workspaceId: string, rel: string): void {
        const set = this.#changedOnDisk.get(workspaceId) ?? new Set<string>();
        set.add(rel);
        this.#changedOnDisk.set(workspaceId, set);
        for (const l of this.#listeners) l(workspaceId);
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

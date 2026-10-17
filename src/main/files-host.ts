import type { GitFileState } from './git-ports.js';
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
    /** How many entries a listing may hold; absent = TREE_BUDGET (genie#921). Injected so a test proves the cap without 5,000 files. */
    readonly treeBudget?: number;
    /** Genie's clock, for when a disk change was seen; injected so a test can read the stamp. */
    readonly now?: () => number;
    /** A file's git state (`git-ports.ts` `gitFileStatus`); absent = opened files carry none. */
    readonly gitStatus?: (root: string, rel: string) => Promise<GitFileState | null>;
    /** A file's last committed text (`git-ports.ts` `gitShowHead`); absent = no `Show diff` baseline. */
    readonly gitShowHead?: (root: string, rel: string) => Promise<string | null>;
}

/** `git` — the file's state in its repository (`git-ports.ts`), present only when the host has a git port. */
export type OpenResult = { ok: true; path: string; text: string; sha: string; git?: GitFileState | null } | { ok: false; path: string; error: string };

/** A write that landed answers the new sha; a refused one carries the conflict (what is on disk NOW) so nothing is discarded. */
export type WriteResult = { ok: true; sha: string } | { ok: false; reason: string; conflict?: { path: string; onDisk: string; sha: string } };

const shaOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface FilesState {
    readonly files: readonly FileAttribution[];
    readonly activity: readonly Activity[];
    readonly unreported: readonly string[];
    readonly changed: readonly ChangedGroup[] | null;
    /**
     * Every change the watcher saw on disk this session, newest first, with WHEN Genie saw it — whoever made it. An
     * observed agent's Activity tab lists the ones since its window opened, saying they are not attributed.
     */
    readonly diskChanges: readonly { path: string; at: number }[];
}

/**
 * WHAT THE BROWSER NEVER WALKS OR WATCHES (genie#921; Genie 1's main/workspace/ignore.ts SKIP_NAMES + REGENERABLE_NAMES,
 * v0.7.0-beta.342): version control and editor metadata, and dependency and build output a toolchain regenerates. An
 * agent's build writes thousands of files in these; walking or watching them is what bogged the machine down.
 */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
    '.git', '.DS_Store', 'Thumbs.db', 'node_modules', '.idea', '.vscode',
    'vendor', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv', 'coverage',
]);
/** How many entries one listing may hold (Genie 1's DEFAULT_MAX_ENTRIES). */
export const TREE_BUDGET = 5000;
/** How deep a listing goes below the workspace (Genie 1's DEFAULT_MAX_DEPTH). */
export const TREE_MAX_DEPTH = 6;
/** The window changes are coalesced over before the panel is told (Genie 1's DEBOUNCE_MS). */
export const WATCH_BATCH_MS = 250;
const SKIP = IGNORED_NAMES;
const OUTSIDE = 'that path is outside the workspace; Genie opens nothing there';

export class FilesHost {
    readonly #ports: FilesHostPorts;
    readonly #cap: number;
    readonly #watchers = new Map<string, FSWatcher>();
    readonly #changedOnDisk = new Map<string, Map<string, number>>();
    /** Files YOU wrote through the panel, per workspace — yours in Changed, never `?`. */
    readonly #mine = new Map<string, Set<string>>();
    readonly #listeners = new Set<(workspaceId: string, paths: readonly string[]) => void>();
    /** Changes seen since the panel was last told, per workspace, and the timer that tells it (genie#921). */
    readonly #pending = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();

    constructor(ports: FilesHostPorts) {
        this.#ports = ports;
        this.#cap = ports.sizeCap ?? FILE_SIZE_CAP;
    }

    async tree(workspaceId: string): Promise<TreeNode[] | null> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws) return null;
        /*
         * BREADTH-FIRST, within a budget and a depth (genie#921; Genie 1's walkBreadthFirst). Every direct child of a
         * folder is listed before any folder's contents, so a huge early folder (a checkout under repos/) cannot starve
         * the root's other entries; the root always lists all of its own. Symlinks are leaves, never followed. Before
         * this, the WHOLE workspace was walked on every call — and the panel called it on every change on disk.
         */
        const entries: Entry[] = [];
        let budget = this.#ports.treeBudget ?? TREE_BUDGET;
        const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
        while (queue.length > 0) {
            const { rel, depth } = queue.shift()!;
            if (depth > TREE_MAX_DEPTH || (budget <= 0 && rel !== '')) continue;
            let dirents;
            try { dirents = await readdir(rel ? join(ws.path, rel) : ws.path, { withFileTypes: true }); } catch { continue; }
            for (const d of dirents) {
                if (SKIP.has(d.name)) continue;
                if (budget <= 0 && rel !== '') break;
                const path = rel ? `${rel}/${d.name}` : d.name;
                if (d.isDirectory()) { entries.push({ path, kind: 'dir' }); budget -= 1; queue.push({ rel: path, depth: depth + 1 }); }
                else if (d.isFile() || d.isSymbolicLink()) { entries.push({ path, kind: 'file' }); budget -= 1; }
            }
        }
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
            if (!this.#ports.gitStatus) return { ok: true, path: rel, text, sha: shaOf(text) };
            return { ok: true, path: rel, text, sha: shaOf(text), git: await this.#ports.gitStatus(ws.path, rel) };
        } catch (error) {
            return { ok: false, path: rel, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /** The file as of the last commit — the baseline for a change nobody reported. `null` outside the workspace or uncommitted. */
    async lastCommitted(workspaceId: string, path: string): Promise<string | null> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws || !this.#ports.gitShowHead) return null;
        const rel = confine(ws.path, path);
        if (rel === null || rel === '') return null;
        return this.#ports.gitShowHead(ws.path, rel);
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
        const disk = this.#changedOnDisk.get(workspaceId) ?? new Map<string, number>();
        const unreported = unreportedChanges(attribution, [...disk.keys()].filter((p) => !mine.includes(p)), ws.path);
        return {
            files: [...attribution.values()],
            activity: activityFrom(events, ws.path),
            unreported,
            changed: changedGroups(attribution, { mine, unreported }),
            diskChanges: [...disk].map(([path, at]) => ({ path, at })).sort((a, b) => b.at - a.at),
        };
    }

    /** Start recording what changes on disk in this workspace; idempotent. */
    async watch(workspaceId: string): Promise<void> {
        const ws = this.#ports.workspace(workspaceId);
        if (!ws || this.#watchers.has(workspaceId)) return;
        // Only what changes AFTER this moment is a change — on macOS, where FSEvents replays writes made just before
        // the watcher attached (the v2.0.0-beta.5 release run saw a set-up write come back as "unreported"). Nowhere
        // else: Linux stamps file times from a coarse clock that lags Date.now(), so a write made just after watch()
        // can carry an earlier time and was dropped (the WSL suite timed out on it 2 runs in 5). inotify and Windows
        // do not replay, so there is nothing for the filter to remove there.
        const since = process.platform === 'darwin' ? Date.now() : Number.NEGATIVE_INFINITY;
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
        const set = this.#changedOnDisk.get(workspaceId) ?? new Map<string, number>();
        set.set(rel, (this.#ports.now ?? Date.now)());
        this.#changedOnDisk.set(workspaceId, set);
        // COALESCED (genie#921; Genie 1's debounced files:tree-changed): one notification per window carrying every
        // path that changed in it — a build's thousand writes are one re-list, not a thousand. A fixed window, not a
        // sliding one, so steady churn still updates the panel every WATCH_BATCH_MS: live, and bounded.
        const pending = this.#pending.get(workspaceId);
        if (pending) { pending.paths.add(rel); return; }
        const paths = new Set([rel]);
        const timer = setTimeout(() => {
            this.#pending.delete(workspaceId);
            for (const l of this.#listeners) l(workspaceId, [...paths]);
        }, WATCH_BATCH_MS);
        this.#pending.set(workspaceId, { paths, timer });
    }

    /** Told once per batch of changes in a workspace, with the paths that changed (relative, forward-slashed). */
    onChange(listener: (workspaceId: string, paths: readonly string[]) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    async close(): Promise<void> {
        for (const w of this.#watchers.values()) w.close();
        this.#watchers.clear();
        for (const p of this.#pending.values()) clearTimeout(p.timer);
        this.#pending.clear();
    }
}

import { statSync, watch as fsWatch } from 'node:fs';
import type { FlowStore } from './flow-store.js';

/**
 * WHICH WORKSPACES ARE WATCHED FOR THE FILE TRIGGER (genie#1204 item 5): exactly those an ARMED flow with a
 * `genie/file_added` trigger names — one watcher per workspace however many flows share it, opened when the first such
 * flow is armed and closed when the last is disarmed, edited away or removed. A workspace nothing listens to is never
 * walked: a recursive watch on a large repository is not free.
 */

/** One fs.watch report, workspace-relative and forward-slashed. */
export interface WatchReport {
    readonly eventType: 'rename' | 'change';
    readonly relPath: string;
}

export interface FileTriggerWatchesDeps {
    readonly store: Pick<FlowStore, 'list' | 'fileTriggers' | 'onChange'>;
    readonly workspacePath: (workspaceId: string) => string | null;
    /** Watch a folder recursively; returns the close. */
    readonly watch: (path: string, listener: (report: WatchReport) => void) => () => void;
    readonly onEvent: (event: WatchReport & { readonly workspaceId: string; readonly workspacePath: string }) => void;
}

export class FileTriggerWatches {
    readonly #deps: FileTriggerWatchesDeps;
    /** Workspace id → its folder and the close of its watcher. */
    readonly #open = new Map<string, { path: string; close: () => void }>();
    readonly #unsubscribe: () => void;

    constructor(deps: FileTriggerWatchesDeps) {
        this.#deps = deps;
        this.#unsubscribe = deps.store.onChange(() => this.reconcile());
        this.reconcile();
    }

    /** The workspaces an armed file flow names, by id. */
    wanted(): Set<string> {
        const ids = new Set<string>();
        for (const flow of this.#deps.store.list()) {
            if (!flow.armed) continue;
            for (const t of this.#deps.store.fileTriggers(flow.id)) if (typeof t.config.workspace === 'string' && t.config.workspace !== '') ids.add(t.config.workspace);
        }
        return ids;
    }

    reconcile(): void {
        const wanted = this.wanted();
        for (const [id, open] of this.#open) {
            const path = this.#deps.workspacePath(id);
            if (!wanted.has(id) || path !== open.path) {
                open.close();
                this.#open.delete(id);
            }
        }
        for (const id of wanted) {
            if (this.#open.has(id)) continue;
            const path = this.#deps.workspacePath(id);
            if (path === null) continue;
            try {
                const close = this.#deps.watch(path, (report) => this.#deps.onEvent({ ...report, workspaceId: id, workspacePath: path }));
                this.#open.set(id, { path, close });
            } catch (error) {
                console.error(`[flows] cannot watch ${path} for added files: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    stop(): void {
        this.#unsubscribe();
        for (const open of this.#open.values()) open.close();
        this.#open.clear();
    }
}

/** The real ports: Node's recursive fs.watch, and a stat that never throws. */
export const nodeWatch = {
    watch(path: string, listener: (report: WatchReport) => void): () => void {
        const watcher = fsWatch(path, { recursive: true }, (eventType, filename) => {
            if (filename === null) return;
            listener({ eventType: eventType === 'change' ? 'change' : 'rename', relPath: String(filename).split('\\').join('/') });
        });
        // A watched folder removed underneath, or a platform limit: said, never thrown at the process.
        watcher.on('error', (error) => console.error(`[flows] watching ${path}: ${error.message}`));
        return () => watcher.close();
    },
    statFile(absPath: string): { isFile: boolean; size: number; mtimeMs: number } | null {
        try {
            const s = statSync(absPath);
            return { isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs };
        } catch {
            return null;
        }
    },
};

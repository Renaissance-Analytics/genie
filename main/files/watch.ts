import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { REGENERABLE_NAMES, SKIP_NAMES } from '../workspace/ignore';

/**
 * Live filesystem watching for the Code view. `files:list-tree` is pull-based,
 * so on-disk changes made OUTSIDE the renderer — an agent or MCP tool writing a
 * file, a `git checkout`, an `npm install` — never reach the tree until a manual
 * reload. This module watches each open workspace root recursively and
 * broadcasts a debounced `files:tree-changed` to every window; the Code panel
 * subscribes and re-lists its tree.
 *
 * One watcher per resolved workspace root, ref-counted across panels/windows.
 * Events inside ignored dirs (node_modules, .git, dist, and the rest of the
 * analyser's SKIP/REGENERABLE sets) are dropped so heavy churn can't spam
 * reloads; a real change coalesces into a single reload via the debounce.
 *
 * The watcher is a best-effort enhancement: if `fs.watch` can't watch
 * recursively on this platform, we swallow it and the tree simply stays
 * pull-based (its prior behaviour) rather than erroring.
 */

interface WatchEntry {
    watcher: fs.FSWatcher;
    /** Original workspacePath strings registered (echoed back on broadcast so
     *  the renderer can match its exact `workspacePath` without re-resolving). */
    paths: Set<string>;
    refs: number;
    timer: NodeJS.Timeout | null;
}

const watchers = new Map<string, WatchEntry>();
const DEBOUNCE_MS = 250;

/** True when a change at this workspace-relative path is tree-irrelevant noise. */
function isIgnoredPath(relPath: string): boolean {
    // Any path segment in the ignore sets → drop. Covers node_modules/.git/dist
    // at any depth, matching what the tree walk itself skips.
    for (const seg of relPath.split(/[\\/]/)) {
        if (!seg) continue;
        if (SKIP_NAMES.has(seg) || REGENERABLE_NAMES.has(seg.toLowerCase())) {
            return true;
        }
    }
    return false;
}

function broadcast(entry: WatchEntry): void {
    const wins = BrowserWindow.getAllWindows();
    for (const original of entry.paths) {
        for (const w of wins) {
            if (!w.isDestroyed()) {
                w.webContents.send('files:tree-changed', { workspacePath: original });
            }
        }
    }
}

/** Begin (or ref-count) live watching of `workspacePath`. Idempotent per path. */
export function watchWorkspace(workspacePath: string): void {
    if (!workspacePath) return;
    const root = path.resolve(workspacePath);

    const existing = watchers.get(root);
    if (existing) {
        existing.refs++;
        existing.paths.add(workspacePath);
        return;
    }

    let watcher: fs.FSWatcher;
    try {
        // recursive: Windows + macOS natively; Linux on modern Node (Electron
        // 42's runtime). A throw here (unsupported / permission) leaves the tree
        // pull-based — no worse than before.
        watcher = fs.watch(root, { recursive: true, persistent: false });
    } catch {
        return;
    }

    const entry: WatchEntry = {
        watcher,
        paths: new Set([workspacePath]),
        refs: 1,
        timer: null,
    };

    watcher.on('change', (_event, filename) => {
        // `filename` is workspace-relative (Buffer | string | null). Null means
        // the platform couldn't name it — treat as a real change and reload.
        const rel = filename == null ? '' : filename.toString();
        if (rel && isIgnoredPath(rel)) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.timer = null;
            broadcast(entry);
        }, DEBOUNCE_MS);
    });
    watcher.on('error', () => {
        // e.g. the root was removed — tear down; callers re-watch on next mount.
        stop(root);
    });

    watchers.set(root, entry);
}

/** Release one reference; the watcher closes when the last panel unwatches. */
export function unwatchWorkspace(workspacePath: string): void {
    if (!workspacePath) return;
    const root = path.resolve(workspacePath);
    const entry = watchers.get(root);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    stop(root);
}

function stop(root: string): void {
    const entry = watchers.get(root);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    try {
        entry.watcher.close();
    } catch {
        /* already closed */
    }
    watchers.delete(root);
}

/** Close every watcher — called on app teardown. */
export function stopAllWatchers(): void {
    for (const root of [...watchers.keys()]) stop(root);
}

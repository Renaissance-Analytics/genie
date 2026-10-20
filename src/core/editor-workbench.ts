import { tabsAfterDelete, tabsAfterRename } from './file-ops.js';
import type { ClaimingEditor } from './plugin-editors.js';

/**
 * THE FILE PANEL'S TABS — one buffer each (beta.33 items 14 + 15). Pure, so the rules are tested without a DOM.
 *
 * Genie 1's CodePanel kept a buffer PER TAB, so switching tabs never lost an edit; Genie 2 held one buffer and dropped it on
 * every open. Here every text tab keeps what was read (`texts`) and what you typed (`buffers`); a re-read of a dirty tab
 * keeps your text (a dirty buffer is never auto-reloaded, §4.3). A plugin-claimed file (item 14) is a tab whose model lives
 * in its editor: the panel holds only its dirty flag, and a disk change remounts a CLEAN one (`rev`), never a dirty one.
 */

/** A text tab's last read: the file, or why it could not be read. */
export type TabText = { ok: true; path: string; text: string; sha: string; git?: 'committed' | 'modified' | 'untracked' | null | undefined } | { ok: false; path: string; error: string };

export interface PluginTab {
    readonly editor: ClaimingEditor;
    readonly dirty: boolean;
    /** Bumped to remount the editor so it re-reads the file (the disk changed under a clean tab). */
    readonly rev: number;
}

export interface Workbench {
    readonly tabs: readonly string[];
    readonly active: string | null;
    readonly texts: Readonly<Record<string, TabText>>;
    /** What you typed, per text tab — present only while it differs from what was read. */
    readonly buffers: Readonly<Record<string, string>>;
    readonly plugins: Readonly<Record<string, PluginTab>>;
    /** The clean text tabs the last disk change touched: the container re-reads these. */
    readonly reread: readonly string[];
}

export const EMPTY_WORKBENCH: Workbench = { tabs: [], active: null, texts: {}, buffers: {}, plugins: {}, reread: [] };

export type WorkbenchAction =
    | { kind: 'open'; path: string; editor: ClaimingEditor | null }
    | { kind: 'loaded'; file: TabText }
    | { kind: 'edit'; path: string; text: string }
    | { kind: 'saved'; path: string; text: string; sha: string }
    | { kind: 'close'; path: string }
    | { kind: 'plugin-dirty'; path: string; dirty: boolean }
    | { kind: 'disk-changed'; paths: readonly string[] }
    | { kind: 'renamed'; from: string; to: string }
    | { kind: 'deleted'; path: string };

export interface TabState { readonly open: string[]; readonly active: string | null }

/** Open (or bring to the front) a path; an open tab is not duplicated (Genie 1 editor-tabs.ts). */
export function openTab(open: readonly string[], path: string): TabState {
    return { open: open.includes(path) ? [...open] : [...open, path], active: path };
}

/** Close a path: a closed front tab hands the front to the neighbour in its slot, or the new last; none when it was the last. */
export function closeTab(open: readonly string[], active: string | null, path: string): TabState {
    const at = open.indexOf(path);
    const next = open.filter((p) => p !== path);
    if (active !== path) return { open: next, active };
    return { open: next, active: next[Math.min(at, next.length - 1)] ?? null };
}

const without = <T,>(record: Readonly<Record<string, T>>, keep: (key: string) => boolean): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([k]) => keep(k)));
const moved = <T,>(record: Readonly<Record<string, T>>, map: (key: string) => string): Record<string, T> =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [map(k), v]));

export function workbench(w: Workbench, action: WorkbenchAction): Workbench {
    switch (action.kind) {
        case 'open': {
            const t = openTab(w.tabs, action.path);
            const plugins = action.editor && !w.plugins[action.path] ? { ...w.plugins, [action.path]: { editor: action.editor, dirty: false, rev: 0 } } : w.plugins;
            return { ...w, tabs: t.open, active: t.active, plugins };
        }
        case 'loaded': {
            const path = action.file.path;
            const reread = w.reread.filter((p) => p !== path);
            // A read that lands after its tab was closed opens nothing.
            if (!w.tabs.includes(path)) return { ...w, reread };
            // A DIRTY tab is never auto-reloaded (§4.3), and keeps the read your edit is BASED on: its sha is what a save is
            // checked against, so a change on disk meanwhile comes back as a conflict instead of being silently overwritten.
            if (w.buffers[path] !== undefined) return { ...w, reread };
            return { ...w, texts: { ...w.texts, [path]: action.file }, reread };
        }
        case 'edit': {
            const read = w.texts[action.path];
            if (read?.ok && read.text === action.text) return { ...w, buffers: without(w.buffers, (k) => k !== action.path) };
            return { ...w, buffers: { ...w.buffers, [action.path]: action.text } };
        }
        case 'saved': {
            const read = w.texts[action.path];
            const file: TabText = read?.ok ? { ...read, text: action.text, sha: action.sha } : { ok: true, path: action.path, text: action.text, sha: action.sha };
            return { ...w, texts: { ...w.texts, [action.path]: file }, buffers: without(w.buffers, (k) => k !== action.path) };
        }
        case 'close': {
            const t = closeTab(w.tabs, w.active, action.path);
            const keep = (k: string) => k !== action.path;
            return { tabs: t.open, active: t.active, texts: without(w.texts, keep), buffers: without(w.buffers, keep), plugins: without(w.plugins, keep), reread: w.reread.filter(keep) };
        }
        case 'plugin-dirty': {
            const p = w.plugins[action.path];
            if (!p || p.dirty === action.dirty) return w;
            return { ...w, plugins: { ...w.plugins, [action.path]: { ...p, dirty: action.dirty } } };
        }
        case 'disk-changed': {
            const changed = new Set(action.paths);
            const plugins = Object.fromEntries(Object.entries(w.plugins).map(([k, p]) => [k, changed.has(k) && !p.dirty ? { ...p, rev: p.rev + 1 } : p]));
            const reread = w.tabs.filter((t) => changed.has(t) && !w.plugins[t] && w.buffers[t] === undefined);
            return { ...w, plugins, reread: [...new Set([...w.reread, ...reread])] };
        }
        case 'renamed': {
            const map = (k: string) => tabsAfterRename([k], action.from, action.to)[0]!;
            const texts = Object.fromEntries(Object.entries(w.texts).map(([k, v]) => [map(k), { ...v, path: map(k) }]));
            return { tabs: tabsAfterRename(w.tabs, action.from, action.to), active: w.active === null ? null : map(w.active), texts, buffers: moved(w.buffers, map), plugins: moved(w.plugins, map), reread: w.reread.map(map) };
        }
        case 'deleted': {
            const kept = tabsAfterDelete(w.tabs, action.path);
            let next = w;
            for (const t of w.tabs) if (!kept.includes(t)) next = workbench(next, { kind: 'close', path: t });
            return next;
        }
    }
}

/** The front tab as text, your buffer over what was read — `null` when the front is a plugin tab or nothing. */
export function activeText(w: Workbench): TabText | null {
    if (w.active === null || w.plugins[w.active]) return null;
    const read = w.texts[w.active];
    if (!read) return null;
    const buffer = w.buffers[w.active];
    return read.ok && buffer !== undefined ? { ...read, text: buffer } : read;
}

/** Every tab with unsaved edits — text or plugin — in tab order. */
export function dirtyPaths(w: Workbench): string[] {
    return w.tabs.filter((t) => (w.plugins[t] ? w.plugins[t]!.dirty : w.buffers[t] !== undefined));
}

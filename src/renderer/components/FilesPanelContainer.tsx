import { useCallback, useEffect, useState } from 'react';
import { routeFileToOpen, type TreeNode } from '../../core/files-panel.js';
import { pauseRequests, resumed, type Pause } from '../../core/files-popout.js';
import { openOrError, settle } from '../../core/files-reads.js';
import type { GenieBridge } from '../bridge.js';
import { FilesPanel, type FilesEdit, type FilesPanelState, type OpenFile } from './FilesPanel.js';

/**
 * The file panel's WIRING (§4.3): loads the tree and the attribution state from the bridge, re-reads
 * them when the host says the workspace changed (push, never a poll), keeps the open tabs. The pure
 * rendering is `FilesPanel`, which is what the tests render. One container per workspace surface.
 */
export function FilesPanelContainer({ workspace, files, pinned, onPin, onClose, popped, onPopOut, onPause, onResume, single, onOpenInPane, onDirtyChange, routeFile, routeFilter, onRouteChange }: {
    workspace: { id: string; name?: string | undefined; path: string };
    files: GenieBridge['files'];
    pinned: boolean;
    onPin: () => void;
    onClose: () => void;
    popped?: boolean | undefined;
    onPopOut?: (() => void) | undefined;
    /**
     * An agent is writing a file you have dirty (§4.3): ask it to pause; lifted when the buffer is clean again.
     * `why === 'conflict'`: your save met its write — the notice says so (`conflictMessage`), and it stays paused.
     */
    onPause?: ((agent: string, path: string, why?: 'conflict') => void) | undefined;
    onResume?: ((agent: string, path: string) => void) | undefined;
    /** SINGLE mode (§4.6): this one file, opened on mount; no tree. */
    single?: string | undefined;
    /** Whether a buffer here differs from what was opened (§4.4: a panel with unsaved edits refuses to be replaced in the dock). */
    onDirtyChange?: ((dirty: boolean) => void) | undefined;
    onOpenInPane?: ((path: string) => void) | undefined;
    /**
     * THE PANEL IN THE URL (the board's `?files=<path>&filter=changed`): the route's file is opened, and opening a file
     * or flipping the filter here is written back, so a link can point at a file and a refresh keeps it. Absent = a
     * panel the route does not own (the dock, a code pane).
     */
    routeFile?: string | null | undefined;
    routeFilter?: 'changed' | null | undefined;
    onRouteChange?: ((file: string | null, filter: 'changed' | null) => void) | undefined;
}) {
    const [tree, setTree] = useState<readonly TreeNode[] | null>(null);
    // The tree's read failed: the reason, shown in the tree's place (never skeletons forever).
    const [treeError, setTreeError] = useState<string | null>(null);
    // Every open SETTLES into something the panel can say — the file, or why not. A rejected ask left `open` as it was.
    const read = useCallback((path: string) => openOrError(() => files.open(workspace.id, path), path), [files, workspace.id]);
    const [state, setState] = useState<FilesPanelState | null>(null);
    const [tabs, setTabs] = useState<readonly string[]>([]);
    const [open, setOpen] = useState<OpenFile | null>(null);
    // The board's `All | Changed N` filter (§4.3): Changed shows the files grouped by who changed them.
    const [filter, setFilter] = useState<'all' | 'changed'>(routeFilter === 'changed' ? 'changed' : 'all');
    // The path last asked for, before its read lands — so the route's echo of a click does not open it twice.
    const [requested, setRequested] = useState<string | null>(null);
    // The buffer you are typing into (§4.3): dirty while it differs from what was opened; never auto-reloaded.
    const [buffer, setBuffer] = useState<{ path: string; text: string } | null>(null);
    const [conflict, setConflict] = useState<{ path: string; onDisk: string; sha: string; baseline?: string | undefined } | null>(null);
    // Agents asked to pause (§4.3): one ask per (agent, file) while your buffer is dirty; lifted when it is clean.
    const [paused, setPaused] = useState<readonly Pause[]>([]);
    // The agent TOLD about the open conflict (the banner says so only then), and whether Compare is open.
    const [told, setTold] = useState<string | null>(null);
    const [comparing, setComparing] = useState(false);
    // `Show diff` on a change nobody reported: git's last commit for the open file, asked for on demand.
    const [blindDiff, setBlindDiff] = useState<{ path: string; before: string | null } | null>(null);
    useEffect(() => { if (conflict === null) { setTold(null); setComparing(false); } }, [conflict]);
    const dirtyPath = buffer !== null && open?.ok && buffer.path === open.path && buffer.text !== open.text ? buffer.path : null;
    // The dock's refusal rule needs to know (§4.4); reported on every change, and clean on unmount.
    useEffect(() => { onDirtyChange?.(dirtyPath !== null); return () => { onDirtyChange?.(false); }; }, [dirtyPath, onDirtyChange]);
    useEffect(() => {
        const dirty = dirtyPath ? [dirtyPath] : [];
        const adds = pauseRequests(state?.activity ?? [], dirty, paused);
        const lifted = resumed(paused, dirty);
        if (adds.length === 0 && lifted.length === 0) return;
        for (const p of adds) onPause?.(p.agent, p.path);
        for (const p of lifted) onResume?.(p.agent, p.path);
        setPaused([...paused.filter((p) => !lifted.includes(p)), ...adds]);
    }, [state, dirtyPath, paused, onPause, onResume]);

    // A code pane (§4.6) opens its one file on mount.
    useEffect(() => { if (single) { setTabs([single]); void read(single).then(setOpen); } }, [single, read]);

    const refresh = useCallback(() => {
        // Single mode draws no tree (§4.6), so it does not walk one: on a large workspace that walk is the whole disk
        // under the root, re-run on every change the watcher sees.
        if (!single) {
            void settle(() => files.tree(workspace.id)).then((r) => {
                if (r.ok) { setTree(r.value); setTreeError(null); } else setTreeError(r.error);
            });
        }
        void files.state(workspace.id).then((s) => setState(s));
    }, [files, workspace.id, single]);

    useEffect(() => {
        refresh();
        void files.watch(workspace.id);
        return files.onChange((id) => { if (id === workspace.id) refresh(); });
    }, [files, workspace.id, refresh]);

    // A dirty buffer is NEVER auto-reloaded (§4.3); a clean one follows the disk.
    useEffect(() => {
        if (!open || buffer !== null) return;
        return files.onChange((id) => { if (id === workspace.id) void read(open.path).then(setOpen); });
    }, [files, workspace.id, open, buffer, read]);

    const openPath = useCallback((path: string) => {
        setRequested(path);
        setTabs((t) => (t.includes(path) ? t : [...t, path]));
        setBuffer(null);
        setConflict(null);
        void read(path).then(setOpen);
    }, [read]);
    const select = useCallback((path: string) => {
        openPath(path);
        onRouteChange?.(path, filter === 'changed' ? 'changed' : null);
    }, [openPath, onRouteChange, filter]);
    // The route names a file: open it unless it is the one already open (or asked for).
    useEffect(() => {
        if (routeFile === undefined) return;
        const path = routeFileToOpen(routeFile, requested ?? open?.path ?? null);
        if (path) openPath(path);
    }, [routeFile]);
    useEffect(() => { if (routeFilter !== undefined) setFilter(routeFilter === 'changed' ? 'changed' : 'all'); }, [routeFilter]);
    const pickFilter = useCallback((f: 'all' | 'changed') => {
        setFilter(f);
        onRouteChange?.(requested ?? open?.path ?? null, f === 'changed' ? 'changed' : null);
    }, [onRouteChange, requested, open]);

    const closeTab = useCallback((path: string) => {
        setTabs((t) => {
            const next = t.filter((p) => p !== path);
            if (open?.path === path) {
                const fallback = next[next.length - 1];
                if (fallback) void read(fallback).then(setOpen);
                else setOpen(null);
                setRequested(fallback ?? null);
                onRouteChange?.(fallback ?? null, filter === 'changed' ? 'changed' : null);
            }
            return next;
        });
    }, [read, open, onRouteChange, filter]);

    const shown: OpenFile | null = open?.ok && buffer && buffer.path === open.path ? { ...open, text: buffer.text } : open;
    const save = (expected: string | null) => {
        if (!open?.ok || !buffer) return;
        void files.write(workspace.id, open.path, buffer.text, expected).then((r) => {
            if (r.ok) { setOpen({ ok: true, path: open.path, text: buffer.text, sha: r.sha }); setBuffer(null); setConflict(null); }
            else if (r.conflict) {
                setConflict({ ...r.conflict, baseline: open.text });
                // The known writer is TOLD, once, and held paused until your buffer is clean (then `resumeMessage`).
                // Without a known writer nobody is told, and the banner does not say anyone was.
                const writer = state?.activity.find((a) => a.verb === 'writing' && a.path === open.path)?.agent ?? null;
                if (writer !== null && onPause) {
                    onPause(writer, open.path, 'conflict');
                    setPaused((p) => (p.some((x) => x.agent === writer && x.path === open.path) ? p : [...p, { agent: writer, path: open.path }]));
                    setTold(writer);
                }
            }
        });
    };
    const edit: FilesEdit | undefined = open?.ok
        ? {
              dirty: buffer !== null && buffer.text !== open.text,
              conflict,
              onChange: (text) => setBuffer({ path: open.path, text }),
              onSave: () => save(open.sha),
              // keep mine: write against the CURRENT sha — an explicit choice, never implicit.
              onKeepMine: () => { if (conflict) save(conflict.sha); },
              onTakeTheirs: () => { if (conflict) { setOpen({ ok: true, path: open.path, text: conflict.onDisk, sha: conflict.sha }); setBuffer(null); setConflict(null); } },
              // Compare (the board's primary): your buffer against the disk, read-only. Nothing is written by looking.
              told,
              comparing,
              onCompare: () => setComparing((c) => !c),
          }
        : undefined;
    const lastCommitted = files.lastCommitted;
    const onShowDiff = lastCommitted && open?.ok ? () => { const path = open.path; void lastCommitted(workspace.id, path).then((before) => setBlindDiff({ path, before })); } : undefined;
    return <FilesPanel workspace={workspace} tree={tree} state={state} tabs={tabs} open={shown} pinned={pinned} onSelect={select} onCloseTab={closeTab} onPin={onPin} onClose={onClose} edit={edit} onShowDiff={onShowDiff} blindDiff={blindDiff} onPopOut={onPopOut} popped={popped} paused={paused} single={single} onOpenInPane={onOpenInPane} filter={filter} onFilter={pickFilter} treeError={treeError} />;
}

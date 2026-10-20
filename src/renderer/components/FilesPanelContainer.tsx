import type { FileMenuAction, FileMenuTarget } from '../../core/file-menu.js';
import { createIn, fileOpDialog, tabsAfterDelete, tabsAfterRename, targetOf, type FileOpAction, type FileOpDialog } from '../../core/file-ops.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_WORKBENCH, activeText, dirtyPaths, workbench, type Workbench, type WorkbenchAction } from '../../core/editor-workbench.js';
import { editorFor } from '../../core/plugin-editors.js';
import { usePluginEditors } from '../plugin-editors-context.js';
import { PluginEditorBody } from './PluginEditorBody.js';
import { routeFileToOpen, type TreeNode } from '../../core/files-panel.js';
import { pauseRequests, resumed, type Pause } from '../../core/files-popout.js';
import { openOrError, settle } from '../../core/files-reads.js';
import { ancestorsOf, revealFor, treeFromLoaded } from '../../core/files-tree-lazy.js';
import type { GenieBridge } from '../bridge.js';
import { FileOpModal } from './FileOpModal.js';
import { FilesPanel, type FilesEdit, type FilesPanelState, type OpenFile, type PluginTabView } from './FilesPanel.js';

/**
 * The file panel's WIRING (§4.3): loads the tree and the attribution state from the bridge, re-reads
 * them when the host says the workspace changed (push, never a poll), keeps the open tabs. The pure
 * rendering is `FilesPanel`, which is what the tests render. One container per workspace surface.
 */
export function FilesPanelContainer({ workspace, files, pinned, onPin, onClose, popped, onPopOut, onPause, onResume, single, onOpenInPane, onDirtyChange, routeFile, routeFilter, onRouteChange, routeLine = null }: {
    workspace: { id: string; name?: string | undefined; path: string };
    files: GenieBridge['files'];
    pinned: boolean;
    onPin?: (() => void) | undefined;
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
    /** The line the route's file opens at (openFileForUser, Tynn #804). */
    routeLine?: number | null | undefined;
    routeFilter?: 'changed' | null | undefined;
    onRouteChange?: ((file: string | null, filter: 'changed' | null) => void) | undefined;
}) {
    const [eagerTree, setTree] = useState<readonly TreeNode[] | null>(null);
    /*
     * THE TREE, A FOLDER AT A TIME (the owner, 2026-10-19: "I can't load files below the 3rd layer and when it opens all
     * folders are open at once"): the host lists a folder when it is opened (`files.children`), nothing is open at start,
     * and the route's file opens its folders (core/files-tree-lazy.ts). A host without `children` keeps its one walk.
     */
    const lazy = typeof files.children === 'function';
    const [loaded, setLoaded] = useState<ReadonlyMap<string, readonly TreeNode[]>>(() => new Map());
    const [expanded, setExpanded] = useState<readonly string[]>(() => revealFor(routeFile ?? null, []));
    const loadedRef = useRef(loaded);
    loadedRef.current = loaded;
    const loadDir = useCallback((dir: string) => {
        void settle(() => files.children!(workspace.id, dir)).then((r) => {
            if (!r.ok) { if (dir === '') setTreeError(r.error); return; }
            if (r.value === null) return;
            if (dir === '') setTreeError(null);
            setLoaded((m) => new Map(m).set(dir, r.value!));
        });
    }, [files, workspace.id]);
    const tree = lazy ? treeFromLoaded(loaded) : eagerTree;
    // The tree's read failed: the reason, shown in the tree's place (never skeletons forever).
    const [treeError, setTreeError] = useState<string | null>(null);
    // Every open SETTLES into something the panel can say — the file, or why not. A rejected ask left `open` as it was.
    const read = useCallback((path: string) => openOrError(() => files.open(workspace.id, path), path), [files, workspace.id]);
    const [state, setState] = useState<FilesPanelState | null>(null);
    /*
     * THE TABS, ONE BUFFER EACH (beta.33 items 14 + 15; core/editor-workbench.ts). Genie 1 kept a buffer per tab; this panel
     * kept ONE and dropped it on every open, so an edit was lost by clicking another tab. A file an ENABLED plugin's editor
     * claims opens as a plugin tab, in that editor (client-side routing, fail-closed: no claim = the code editor).
     */
    const editors = usePluginEditors();
    const [bench, setBench] = useState<Workbench>(EMPTY_WORKBENCH);
    const benchRef = useRef(bench);
    benchRef.current = bench;
    const act = useCallback((action: WorkbenchAction) => setBench((w) => workbench(w, action)), []);
    const tabs = bench.tabs;
    const open: OpenFile | null = activeText(bench);
    // The board's `All | Changed N` filter (§4.3): Changed shows the files grouped by who changed them.
    const [filter, setFilter] = useState<'all' | 'changed'>(routeFilter === 'changed' ? 'changed' : 'all');
    // The path last asked for, before its read lands — so the route's echo of a click does not open it twice.
    const [requested, setRequested] = useState<string | null>(null);
    const [conflict, setConflict] = useState<{ path: string; onDisk: string; sha: string; baseline?: string | undefined } | null>(null);
    // Agents asked to pause (§4.3): one ask per (agent, file) while your buffer is dirty; lifted when it is clean.
    const [paused, setPaused] = useState<readonly Pause[]>([]);
    // The agent TOLD about the open conflict (the banner says so only then), and whether Compare is open.
    const [told, setTold] = useState<string | null>(null);
    const [comparing, setComparing] = useState(false);
    // `Show diff` on a change nobody reported: git's last commit for the open file, asked for on demand.
    const [blindDiff, setBlindDiff] = useState<{ path: string; before: string | null } | null>(null);
    useEffect(() => { if (conflict === null) { setTold(null); setComparing(false); } }, [conflict]);
    const dirty = useMemo(() => dirtyPaths(bench), [bench]);
    const dirtyKey = dirty.join('\n');
    // The dock's refusal rule needs to know (§4.4); reported on every change, and clean on unmount.
    useEffect(() => { onDirtyChange?.(dirty.length > 0); return () => { onDirtyChange?.(false); }; }, [dirtyKey, onDirtyChange]);
    useEffect(() => {
        const adds = pauseRequests(state?.activity ?? [], dirty, paused);
        const lifted = resumed(paused, dirty);
        if (adds.length === 0 && lifted.length === 0) return;
        for (const p of adds) onPause?.(p.agent, p.path);
        for (const p of lifted) onResume?.(p.agent, p.path);
        setPaused([...paused.filter((p) => !lifted.includes(p)), ...adds]);
    }, [state, dirtyKey, paused, onPause, onResume]);

    // Read a text tab (never a plugin tab: its editor reads the bytes itself). A dirty tab's read is kept out by the workbench.
    // One read per path at a time: a click and a disk change landing together read once.
    const inflight = useRef(new Set<string>());
    const load = useCallback((path: string) => {
        if (inflight.current.has(path)) return;
        inflight.current.add(path);
        void read(path).then((file) => { inflight.current.delete(path); act({ kind: 'loaded', file }); });
    }, [read, act]);

    const refresh = useCallback(() => {
        // Single mode draws no tree (§4.6), so it does not walk one: on a large workspace that walk is the whole disk
        // under the root, re-run on every change the watcher sees.
        if (!single && lazy) {
            // The root, and every folder already open, listed again — never a walk of the whole workspace.
            for (const dir of new Set(['', ...loadedRef.current.keys()])) loadDir(dir);
        } else if (!single) {
            void settle(() => files.tree(workspace.id)).then((r) => {
                if (r.ok) { setTree(r.value); setTreeError(null); } else setTreeError(r.error);
            });
        }
        void files.state(workspace.id).then((s) => setState(s));
    }, [files, workspace.id, single, lazy, loadDir]);

    useEffect(() => {
        refresh();
        void files.watch(workspace.id);
        return files.onChange((id, paths) => {
            if (id !== workspace.id) return;
            if (!lazy || !paths || paths.length === 0) { refresh(); return; }
            // Only the folders the changes are in, and only those already listed; the attribution state as before.
            const dirs = new Set(paths.map((p) => ancestorsOf(p).at(-1) ?? ''));
            for (const dir of dirs) if (loadedRef.current.has(dir)) loadDir(dir);
            void files.state(workspace.id).then((s) => setState(s));
        });
    }, [files, workspace.id, refresh, lazy, loadDir]);

    // Every folder that is open is listed (opening one is what loads it).
    useEffect(() => {
        if (!lazy || single) return;
        for (const dir of expanded) if (!loadedRef.current.has(dir)) loadDir(dir);
    }, [expanded, lazy, single, loadDir]);
    // The route's file is shown in its place: its folders open, what was open stays open.
    useEffect(() => {
        if (routeFile === undefined || routeFile === null) return;
        setExpanded((e) => revealFor(routeFile, e));
    }, [routeFile]);

    // A dirty tab is NEVER auto-reloaded (§4.3); a clean one follows the disk — text re-read, a plugin editor remounted.
    // Only the tabs among the changes (genie#921): a build elsewhere in the workspace re-reads nothing.
    useEffect(() => files.onChange((id, paths) => {
        if (id !== workspace.id) return;
        act({ kind: 'disk-changed', paths: paths ?? benchRef.current.tabs });
    }), [files, workspace.id, act]);
    const rereadKey = bench.reread.join('\n');
    useEffect(() => { for (const path of benchRef.current.reread) load(path); }, [rereadKey, load]);

    const openPath = useCallback((path: string) => {
        setRequested(path);
        const editor = editorFor(editors, path);
        const w = benchRef.current;
        act({ kind: 'open', path, editor });
        // A text tab is (re-)read unless it holds your edits — clicking a dirty tab brings it forward as you left it.
        if (!editor && !w.plugins[path] && w.buffers[path] === undefined) load(path);
    }, [editors, act, load]);
    // A code pane (§4.6) opens its one file on mount.
    useEffect(() => { if (single) openPath(single); }, [single]);
    const select = useCallback((path: string) => {
        openPath(path);
        onRouteChange?.(path, filter === 'changed' ? 'changed' : null);
    }, [openPath, onRouteChange, filter]);
    // The route names a file: open it unless it is the one already open (or asked for).
    useEffect(() => {
        if (routeFile === undefined) return;
        const path = routeFileToOpen(routeFile, requested ?? bench.active);
        if (path) openPath(path);
    }, [routeFile]);
    useEffect(() => { if (routeFilter !== undefined) setFilter(routeFilter === 'changed' ? 'changed' : 'all'); }, [routeFilter]);
    const pickFilter = useCallback((f: 'all' | 'changed') => {
        setFilter(f);
        onRouteChange?.(requested ?? bench.active, f === 'changed' ? 'changed' : null);
    }, [onRouteChange, requested, bench.active]);

    // Each plugin tab hands its save over (PluginEditorBody registerSave): the Save button and Ctrl/Cmd+S drive it.
    const pluginSaves = useRef(new Map<string, () => Promise<void>>());
    const closeTab = useCallback((path: string) => {
        const before = benchRef.current;
        const after = workbench(before, { kind: 'close', path });
        // The ref moves now, so "Close all" closing several in one go each closes from what the last one left.
        benchRef.current = after;
        setBench(after);
        pluginSaves.current.delete(path);
        if (before.active === path) {
            setRequested(after.active);
            onRouteChange?.(after.active, filter === 'changed' ? 'changed' : null);
        }
    }, [onRouteChange, filter]);

    const shown: OpenFile | null = open;
    // A save that fails without a conflict is SAID (Tynn #840): it used to vanish, leaving a dirty buffer and no reason.
    const [saveError, setSaveError] = useState<string | null>(null);
    const save = (expected: string | null) => {
        const buffer = open?.ok ? bench.buffers[open.path] : undefined;
        if (!open?.ok || buffer === undefined) return;
        setSaveError(null);
        void files.write(workspace.id, open.path, buffer, expected).then((r) => {
            if (r.ok) { act({ kind: 'saved', path: open.path, text: buffer, sha: r.sha }); setConflict(null); }
            else if (!r.conflict) setSaveError(r.reason);
            else if (r.conflict) {
                const based = bench.texts[open.path];
                setConflict({ ...r.conflict, baseline: based?.ok ? based.text : open.text });
                // The known writer is TOLD, once, and held paused until your buffer is clean (then `resumeMessage`).
                // Without a known writer nobody is told, and the banner does not say anyone was.
                const writer = state?.activity.find((a) => a.verb === 'writing' && a.path === open.path)?.agent ?? null;
                if (writer !== null && onPause) {
                    onPause(writer, open.path, 'conflict');
                    setPaused((p) => (p.some((x) => x.agent === writer && x.path === open.path) ? p : [...p, { agent: writer, path: open.path }]));
                    setTold(writer);
                }
            }
        }, (error: unknown) => setSaveError(error instanceof Error ? error.message : String(error)));
    };
    const edit: FilesEdit | undefined = open?.ok
        ? {
              dirty: bench.buffers[open.path] !== undefined,
              // A conflict belongs to the file it was met on: another tab in front does not show it.
              conflict: conflict && conflict.path === open.path ? conflict : null,
              onChange: (text) => act({ kind: 'edit', path: open.path, text }),
              onSave: () => save(open.sha),
              // keep mine: write against the CURRENT sha — an explicit choice, never implicit.
              onKeepMine: () => { if (conflict) save(conflict.sha); },
              onTakeTheirs: () => { if (conflict) { act({ kind: 'saved', path: open.path, text: conflict.onDisk, sha: conflict.sha }); setConflict(null); } },
              // Compare (the board's primary): your buffer against the disk, read-only. Nothing is written by looking.
              told,
              comparing,
              onCompare: () => setComparing((c) => !c),
              saveError,
          }
        : undefined;
    // RIGHT-CLICK A FILE (Tynn #841): the host's own app / file manager where this window is the host; copy and close anywhere.
    // The host's own separator: a Windows workspace copies C:\…\src\a.ts, not a mix.
    const absolutePath = (rel: string) => { const sep = workspace.path.includes('\\') ? '\\' : '/'; return `${workspace.path.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`; };
    const say = (r: { ok: true } | { ok: false; reason: string }) => { if (!r.ok) setSaveError(r.reason); };
    /*
     * THE TREE'S FILE OPERATIONS (Tynn #844): the dialog, then the host does it (confined, never overwriting, Delete to the
     * trash). The tree is listed again, a new file opens, and open tabs follow a rename or close with a delete. A refusal
     * stays in the dialog so it can be fixed.
     */
    const ops = files.create && files.rename && files.duplicate && files.trash ? { create: files.create, rename: files.rename, duplicate: files.duplicate, trash: files.trash } : null;
    const [fileOp, setFileOp] = useState<{ dialog: FileOpDialog; error: string | null; busy: boolean } | null>(null);
    // Where an operation landed is shown: its folders open (a new folder itself too), and the tree listed again.
    const landed = (path: string, expand: boolean) => {
        setExpanded((e) => { const out = revealFor(path, e); return expand && !out.includes(path) ? [...out, path] : out; });
        refresh();
    };
    const runFileOp = (dialog: FileOpDialog, name: string) => {
        if (!ops) return;
        const target = targetOf(dialog, name);
        const call = dialog.action === 'new-file' ? ops.create(workspace.id, target, 'file')
            : dialog.action === 'new-folder' ? ops.create(workspace.id, target, 'folder')
            : dialog.action === 'rename' ? ops.rename(workspace.id, dialog.node.path, target)
            : dialog.action === 'duplicate' ? ops.duplicate(workspace.id, dialog.node.path)
            : ops.trash(workspace.id, dialog.node.path);
        setFileOp((f) => (f ? { ...f, busy: true, error: null } : f));
        void call.then((r) => {
            // Duplicate has no dialog to keep open: its refusal is said where a failed save is.
            if (!r.ok) { if (dialog.action === 'duplicate') { setFileOp(null); setSaveError(r.reason); } else setFileOp({ dialog, error: r.reason, busy: false }); return; }
            setFileOp(null);
            if (dialog.action === 'rename') {
                const from = dialog.node.path;
                const active = benchRef.current.active;
                act({ kind: 'renamed', from, to: r.path });
                const moved = active === null ? null : tabsAfterRename([active], from, r.path)[0] ?? null;
                if (moved !== null && moved !== active) setRequested(moved);
            } else if (dialog.action === 'delete') {
                const gone = dialog.node.path;
                const kept = tabsAfterDelete(tabs, gone);
                for (const t of tabs) if (!kept.includes(t)) closeTab(t);
            }
            if (dialog.action !== 'delete') landed(r.path, dialog.action === 'new-folder');
            else refresh();
            if (dialog.action === 'new-file' || dialog.action === 'duplicate') select(r.path);
        }, (error: unknown) => setFileOp({ dialog, error: error instanceof Error ? error.message : String(error), busy: false }));
    };
    const startFileOp = (action: FileOpAction, path: string, target: FileMenuTarget) => {
        const creating = action === 'new-file' || action === 'new-folder';
        const at = creating ? createIn(path, target === 'tree-folder' ? 'tree-folder' : target === 'tree-root' ? 'tree-root' : 'tree-file') : path;
        const dialog = fileOpDialog(action, { path: at, type: creating ? (at === '' ? 'root' : 'folder') : target === 'tree-folder' ? 'folder' : 'file' });
        // Duplicate needs no answer (Genie 1): it just happens, beside the file.
        if (action === 'duplicate') runFileOp(dialog, '');
        else setFileOp({ dialog, error: null, busy: false });
    };
    const fileActions = {
        external: files.openExternal !== undefined,
        reveal: files.reveal !== undefined,
        edit: ops !== null && !single,
        onAction: (action: FileMenuAction, path: string, target: FileMenuTarget = 'tree-file') => {
            switch (action) {
                case 'new-file': case 'new-folder': case 'rename': case 'duplicate': case 'delete': startFileOp(action, path, target); break;
                case 'open-external': void files.openExternal?.(workspace.id, path).then(say); break;
                case 'reveal': void files.reveal?.(workspace.id, path).then(say); break;
                case 'copy-path': void navigator.clipboard?.writeText(absolutePath(path)); break;
                case 'copy-relative-path': void navigator.clipboard?.writeText(path); break;
                case 'close': closeTab(path); break;
                case 'close-others': for (const t of tabs) if (t !== path) closeTab(t); break;
                case 'close-all': for (const t of tabs) closeTab(t); break;
            }
        },
    };
    const lastCommitted = files.lastCommitted;
    const onShowDiff = lastCommitted && open?.ok ? () => { const path = open.path; void lastCommitted(workspace.id, path).then((before) => setBlindDiff({ path, before })); } : undefined;
    // PLUGIN TABS (item 14): each in its plugin's editor, keyed by its rev so a disk change under a clean one re-reads it.
    const pluginTabs: PluginTabView[] = tabs.flatMap((t) => {
        const p = bench.plugins[t];
        if (!p) return [];
        return [{
            path: t,
            pluginName: p.editor.pluginName,
            dirty: p.dirty,
            onSave: () => { void pluginSaves.current.get(t)?.(); },
            node: <PluginEditorBody key={`${t}:${p.rev}`} pluginId={p.editor.pluginId} fancyExport={p.editor.fancyEditor.export} workspaceId={workspace.id} path={t} files={files} onDirtyChange={(d) => act({ kind: 'plugin-dirty', path: t, dirty: d })} registerSave={(fn) => { pluginSaves.current.set(t, fn); }} />,
        }];
    });
    const panel = <FilesPanel active={bench.active} pluginTabs={pluginTabs} workspace={workspace} tree={tree} state={state} tabs={tabs} open={shown} pinned={pinned} onSelect={select} onCloseTab={closeTab} onPin={onPin} onClose={onClose} edit={edit} onShowDiff={onShowDiff} blindDiff={blindDiff} onPopOut={onPopOut} popped={popped} paused={paused} single={single} onOpenInPane={onOpenInPane} fileActions={fileActions} filter={filter} onFilter={pickFilter} treeError={treeError} {...(lazy ? { expanded, onExpandedChange: (ids: readonly string[]) => setExpanded(ids) } : {})} line={shown?.ok && shown.path === routeFile ? routeLine : null} />;
    return (
        <>
            {panel}
            {fileOp && fileOp.dialog.action !== 'duplicate' ? <FileOpModal key={`${fileOp.dialog.action}:${fileOp.dialog.node.path}`} dialog={fileOp.dialog} error={fileOp.error} busy={fileOp.busy} onConfirm={(name) => runFileOp(fileOp.dialog, name)} onCancel={() => setFileOp(null)} /> : null}
        </>
    );
}

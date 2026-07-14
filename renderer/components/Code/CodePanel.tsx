import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CodeEditor } from '@particle-academy/fancy-code';
import FileTree from './FileTree';
import EditorWand from './EditorWand';
import WordWrapSync from './WordWrapSync';
import {
    IconCheck,
    IconCode,
    IconLock,
    IconMaximize,
    IconMinimize,
    IconPin,
    IconUnlock,
    IconWrap,
    IconX,
} from '../Master/icons';
import { showPrompt } from '../Master/Prompt';
import { closeTab as closeTabState, openTab as openTabState, reconcileTabs } from '../../lib/editor-tabs';
import { onOpenInPanel, resolveCursorLine, type RevealTarget } from '../../lib/editor-open';
import PluginEditorBody from '../Plugins/PluginEditorBody';
import {
    api,
    isSystemWorkspace,
    type TerminalSpec,
    type TreeNodeData,
    type ViewMeta,
    type WorkspaceRow,
} from '../../lib/genie';

interface Props {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
    onClose: () => void;
    onMaximize?: () => void;
    onMinimize?: () => void;
    focused?: boolean;
    /** Agent-integration MCP: pulse the panel border (imDone) until focused. */
    attention?: boolean;
    maximized?: boolean;
    style?: CSSProperties;
}

/** Per-tab editor state: the file's text, its language, and unsaved flag.
 *  A PLUGIN tab (kind 'plugin') is rendered by the claiming plugin's Fancy
 *  editor instead of the text editor — it carries no text content here (the
 *  body owns its model); dirty mirrors the body's flag. */
interface FileState {
    content: string;
    /** Last saved/loaded on-disk content — the diff-gutter baseline the live
     *  `content` is compared against (fancy-code `diffBase`). Text tabs only;
     *  plugin tabs own their model and don't render <CodeEditor>. */
    baseline?: string;
    language: string;
    dirty: boolean;
    kind?: 'text' | 'plugin';
    plugin?: { pluginId: string; fancyExport: string };
    /** Bumped when the file is reloaded from disk after an EXTERNAL change, to
     *  force the editor (text or plugin body) to remount with the fresh content. */
    rev?: number;
}

/**
 * Map a file extension to a fancy-code language name. fancy-code ships
 * tokenizers for JS/TS/HTML/PHP/Python/Go; everything else falls back to
 * 'plaintext' (no highlighting, still fully editable).
 */
function languageFor(relPath: string): string {
    const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
        case 'js':
        case 'jsx':
        case 'mjs':
        case 'cjs':
            return 'javascript';
        case 'ts':
        case 'tsx':
            return 'typescript';
        case 'html':
        case 'htm':
            return 'html';
        case 'php':
            return 'php';
        case 'py':
            return 'python';
        case 'go':
            return 'go';
        default:
            return 'plaintext';
    }
}

/** Last path segment — the tab label. */
function baseName(relPath: string): string {
    return relPath.split('/').pop() || relPath;
}

/** Normalise a user-typed root: forward-slashed, no leading/trailing slash, no `..`. */
function normaliseRoot(input: string): string {
    return input
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter((seg) => seg && seg !== '.' && seg !== '..')
        .join('/');
}

/**
 * A Code view tile. Mirrors TerminalPanel's chrome but its body is a
 * collapsible file tree beside a fancy-code editor.
 *
 * Multiple files open at once as tabs (a `.code-tabs` strip under the head);
 * each tab keeps its own text + dirty state, so switching tabs never
 * discards edits. Open files + the active tab persist in meta and reopen on
 * relaunch. The tree can be PINNED open (otherwise it auto-hides on open),
 * and its expanded folders are remembered across restarts.
 *
 * Tree-toggle + pin live at the LEFT of the head (the tree opens on the left
 * edge). Save/Lock/Maximize/Close stay on the right.
 *
 * Lock (Item 5): a locked view pins the tree to a workspace-relative `root`
 * folder. Persisted in the spec's `meta_json`. Reads/writes still path-guard
 * against the WORKSPACE root in main — the locked root is only the tree's
 * starting folder, never a security boundary.
 */
export default function CodePanel({
    spec,
    workspace,
    onClose,
    onMaximize,
    onMinimize,
    focused,
    attention,
    maximized,
    style,
}: Props) {
    const workspacePath = workspace?.path ?? spec.cwd;
    // The System workspace (desktop only) browses the WHOLE machine — its file
    // ops resolve any absolute path, unconfined. Every real workspace stays
    // strictly confined. `system` rides along on each files.* call; main
    // additionally requires the desktop runtime (headless can never full-FS).
    const system = !!workspace && isSystemWorkspace(workspace);

    const [nodes, setNodes] = useState<TreeNodeData[]>([]);
    const [treeVisible, setTreeVisible] = useState(true);

    // Multi-file tab model: the open tabs (in order), the active one, and a
    // per-file state map. Seeded from persisted meta on mount.
    const [openFiles, setOpenFiles] = useState<string[]>([]);
    const [activeFile, setActiveFile] = useState<string | null>(null);
    const [files, setFiles] = useState<Record<string, FileState>>({});
    const [loadError, setLoadError] = useState<string | null>(null);

    // openFileForUser line-reveal: the line to scroll to, scoped to the file it
    // targets so switching tabs doesn't jump the other file to this line. Drives
    // the editor's declarative `cursorLine` (fancy-code reveals on mount AND on
    // change, so re-opening the same file at a new line re-reveals).
    const [reveal, setReveal] = useState<RevealTarget | null>(null);

    // Tree pinned open (stays after opening a file) + remembered expansion.
    const [treePinned, setTreePinned] = useState<boolean>(!!spec.meta?.tree_pinned);
    // Editor word-wrap toggle (persisted per view).
    const [wordWrap, setWordWrap] = useState<boolean>(!!spec.meta?.word_wrap);
    const [expandedIds, setExpandedIds] = useState<string[]>(
        spec.meta?.expanded_tree_ids ?? [],
    );

    // Lock state seeded from persisted meta; pins the tree root.
    const [locked, setLocked] = useState<boolean>(!!spec.meta?.locked);
    const [lockedRoot, setLockedRoot] = useState<string>(spec.meta?.root ?? '');

    // Bumped after a save so the FileTree refetches git status.
    const [gitRefreshKey, setGitRefreshKey] = useState(0);

    // Live refs for the keydown handler + async ops without re-binding.
    const activeFileRef = useRef(activeFile);
    activeFileRef.current = activeFile;
    const openFilesRef = useRef(openFiles);
    openFilesRef.current = openFiles;
    const filesRef = useRef(files);
    filesRef.current = files;
    const treePinnedRef = useRef(treePinned);
    treePinnedRef.current = treePinned;

    const active = activeFile ? files[activeFile] : undefined;

    /** Paths of open tabs with unsaved edits — the tree marks these with `*`. */
    const dirtyPaths = useMemo(() => {
        const s = new Set<string>();
        for (const [p, st] of Object.entries(files)) if (st.dirty) s.add(p);
        return s;
    }, [files]);

    /** Persist a patch into the spec's meta (merging over current meta). */
    const persistMeta = useCallback(
        (patch: Partial<ViewMeta>) => {
            const nextMeta: ViewMeta = { ...spec.meta, ...patch };
            void api()
                .terminalSpec.update(spec.id, { meta: nextMeta })
                .catch(() => {});
        },
        [spec.id, spec.meta],
    );

    /** Persist the open-tabs list + active tab (keeps legacy file_path in sync). */
    const persistTabs = useCallback(
        (nextOpen: string[], nextActive: string | null) => {
            persistMeta({
                open_files: nextOpen,
                active_file: nextActive ?? undefined,
                file_path: nextActive ?? undefined,
            });
        },
        [persistMeta],
    );

    // Debounced persist of the remembered tree expansion (skip the first run
    // so we don't immediately rewrite the value we just seeded from).
    const expandFirstRun = useRef(true);
    useEffect(() => {
        if (expandFirstRun.current) {
            expandFirstRun.current = false;
            return;
        }
        const t = setTimeout(() => persistMeta({ expanded_tree_ids: expandedIds }), 400);
        return () => clearTimeout(t);
    }, [expandedIds, persistMeta]);

    /** (Re)load the tree, rooting at the locked subfolder when locked. */
    const reloadTree = useCallback(() => {
        const opts = { system, ...(locked && lockedRoot ? { root: lockedRoot } : {}) };
        return api()
            .files.listTree(workspacePath, opts)
            .then((t) => setNodes(t))
            .catch(() => setNodes([]));
    }, [workspacePath, locked, lockedRoot, system]);

    // Latest reloadTree for the fs-watch subscription, so a lock/root change
    // doesn't churn (unwatch/rewatch) the watcher.
    const reloadTreeRef = useRef(reloadTree);
    reloadTreeRef.current = reloadTree;

    // Load the tree on mount and whenever the root (workspace or lock) shifts.
    useEffect(() => {
        let alive = true;
        const opts = { system, ...(locked && lockedRoot ? { root: lockedRoot } : {}) };
        void api()
            .files.listTree(workspacePath, opts)
            .then((t) => alive && setNodes(t))
            .catch(() => alive && setNodes([]));
        return () => {
            alive = false;
        };
    }, [workspacePath, locked, lockedRoot, system]);

    // Paths THIS panel just wrote (Ctrl+S), so the fs-watch echo of our own save
    // doesn't reload the tab out from under the user (losing cursor/scroll on a
    // text tab, remounting a plugin editor). rel → timestamp; entries expire.
    const justWrote = useRef(new Map<string, number>());
    const SELF_WRITE_MS = 1500;

    /**
     * Reconcile OPEN tabs against disk after an external change — the core
     * auto-refresh (an agent, a git op, a tool, or a plugin wrote the file).
     * `changed` names the rel paths that changed (null = reconcile every open
     * tab). A CLEAN tab reloads silently; a DIRTY tab is LEFT ALONE so unsaved
     * edits are never clobbered. Works for text tabs (re-read + diff) and plugin
     * tabs (bump `rev` → the body re-reads through the guarded bridge on remount)
     * alike, so plugins get live-refresh for free.
     */
    const reconcileOpenTabs = useCallback(
        async (changed: string[] | null) => {
            const open = openFilesRef.current;
            if (!open.length) return;
            // ONLY reload a tab whose OWN file changed. An unnamed change
            // (`changed === null` — the platform couldn't name it) reloads the
            // TREE only, never the open viewers: reloading the file you're
            // looking at just because a DIFFERENT file changed is exactly the
            // spurious-reload we must not do.
            if (changed === null) return;
            const targets = open.filter((p) => changed.includes(p));
            for (const rel of targets) {
                const st = filesRef.current[rel];
                if (!st || st.dirty) continue; // never clobber unsaved edits
                const wroteAt = justWrote.current.get(rel);
                if (wroteAt && Date.now() - wroteAt < SELF_WRITE_MS) continue; // our own save
                if (st.kind === 'plugin') {
                    // Remount the plugin body → it re-reads the file from disk.
                    setFiles((m) =>
                        m[rel] ? { ...m, [rel]: { ...m[rel], rev: (m[rel].rev ?? 0) + 1 } } : m,
                    );
                } else {
                    try {
                        const { content: text } = await api().files.read(workspacePath, rel, system);
                        const now = filesRef.current[rel];
                        // Re-check AFTER the await: the user may have started typing
                        // during the read (now dirty) — never clobber that. Only
                        // apply a real change, avoiding a needless remount (cursor
                        // reset) when disk already matches.
                        if (now && !now.dirty && text !== now.content) {
                            setFiles((m) =>
                                m[rel]
                                    ? {
                                          ...m,
                                          [rel]: {
                                              ...m[rel],
                                              content: text,
                                              // Absorbed external change → advance the
                                              // baseline too, so it shows no false diff.
                                              baseline: text,
                                              dirty: false,
                                              rev: (m[rel].rev ?? 0) + 1,
                                          },
                                      }
                                    : m,
                            );
                        }
                    } catch {
                        /* file vanished — the tree reload drops its tree node; the
                           tab stays until the user closes it (its content is the
                           last-read copy) */
                    }
                }
            }
        },
        [workspacePath, system],
    );
    const reconcileRef = useRef(reconcileOpenTabs);
    reconcileRef.current = reconcileOpenTabs;

    // Live-refresh: watch the workspace on disk so files created, renamed, or
    // deleted OUTSIDE the editor (an agent, a git checkout, an MCP tool) appear
    // without a manual reload — the tree re-lists AND open tabs reload (see
    // reconcileOpenTabs). Debounced in main. Keyed on workspacePath only —
    // reloadTree/reconcile read via refs so a lock/root change never churns it.
    useEffect(() => {
        void api().files.watch(workspacePath);
        let t: ReturnType<typeof setTimeout> | null = null;
        const off = api().on.treeChanged(({ workspacePath: changedWs, changed }) => {
            if (changedWs !== workspacePath) return;
            void reconcileRef.current(changed);
            if (t) clearTimeout(t);
            t = setTimeout(() => void reloadTreeRef.current(), 120);
        });
        return () => {
            if (t) clearTimeout(t);
            off();
            void api().files.unwatch(workspacePath);
        };
    }, [workspacePath]);

    // Per-plugin-tab save handlers, registered by each PluginEditorBody so the
    // panel's save button / Ctrl+S can drive the ACTIVE plugin tab's save.
    const pluginSaves = useRef(new Map<string, () => Promise<void>>());

    const setFileDirty = useCallback((rel: string, dirty: boolean) => {
        setFiles((m) => (m[rel] ? { ...m, [rel]: { ...m[rel], dirty } } : m));
    }, []);

    /** Open (or focus) a file as a tab. A plugin-claimed extension opens as a
     *  PLUGIN TAB in THIS panel (rendered by the plugin's Fancy editor — §6.1);
     *  everything else reads from disk as text. Returns whether the file
     *  actually opened — a failed read sets loadError instead, and the caller
     *  must NOT act as if a tab appeared (hiding the tree on a failed open left
     *  the user staring at an empty panel). */
    const openTab = useCallback(
        async (relPath: string): Promise<boolean> => {
            setLoadError(null);
            try {
                if (!filesRef.current[relPath]) {
                    const plugin = await api()
                        .plugins.editorFor(relPath)
                        .catch(() => null);
                    if (plugin) {
                        setFiles((m) => ({
                            ...m,
                            [relPath]: {
                                content: '',
                                language: '',
                                dirty: false,
                                kind: 'plugin',
                                plugin: {
                                    pluginId: plugin.pluginId,
                                    fancyExport: plugin.fancyExport,
                                },
                            },
                        }));
                    } else {
                        const { content: text } = await api().files.read(
                            workspacePath,
                            relPath,
                            system,
                        );
                        setFiles((m) => ({
                            ...m,
                            [relPath]: {
                                content: text,
                                baseline: text,
                                language: languageFor(relPath),
                                dirty: false,
                                kind: 'text',
                            },
                        }));
                    }
                }
                const next = openTabState(openFilesRef.current, relPath);
                setOpenFiles(next.open);
                setActiveFile(next.active);
                persistTabs(next.open, next.active);
                return true;
            } catch (e) {
                setLoadError(e instanceof Error ? e.message : String(e));
                return false;
            }
        },
        [workspacePath, persistTabs, system],
    );

    // External "open this file" requests targeting THIS live panel (the
    // openFileForUser MCP tool reusing an already-open editor): open the path as
    // a tab + focus it. The mount-seed below only runs once, so a live panel
    // needs this side channel.
    useEffect(() => {
        return onOpenInPanel(spec.id, (relPath, line) => {
            void openTab(relPath).then((opened) => {
                if (opened && !treePinnedRef.current) setTreeVisible(false);
            });
            if (typeof line === 'number') setReveal({ file: relPath, line });
        });
    }, [spec.id, openTab]);

    // Seed the editor from persisted open tabs once the panel mounts. Falls
    // back to the legacy single `file_path`. Tabs whose file no longer exists
    // are silently dropped.
    useEffect(() => {
        const seedOpen =
            spec.meta?.open_files && spec.meta.open_files.length
                ? spec.meta.open_files
                : spec.meta?.file_path
                  ? [spec.meta.file_path]
                  : [];
        if (!seedOpen.length) return;
        const seedActive =
            spec.meta?.active_file ?? spec.meta?.file_path ?? seedOpen[0];
        let alive = true;
        void (async () => {
            const loaded: Record<string, FileState> = {};
            const ok: string[] = [];
            for (const rel of seedOpen) {
                try {
                    // Plugin-claimed tabs re-resolve on reopen (the body reads
                    // the file itself through the guarded bridge).
                    const plugin = await api()
                        .plugins.editorFor(rel)
                        .catch(() => null);
                    if (plugin) {
                        loaded[rel] = {
                            content: '',
                            language: '',
                            dirty: false,
                            kind: 'plugin',
                            plugin: {
                                pluginId: plugin.pluginId,
                                fancyExport: plugin.fancyExport,
                            },
                        };
                        ok.push(rel);
                        continue;
                    }
                    const { content: text } = await api().files.read(
                        workspacePath,
                        rel,
                        system,
                    );
                    loaded[rel] = {
                        content: text,
                        baseline: text,
                        language: languageFor(rel),
                        dirty: false,
                        kind: 'text',
                    };
                    ok.push(rel);
                } catch {
                    /* file gone since last session — drop the tab */
                }
            }
            if (!alive || !ok.length) return;
            const recon = reconcileTabs(seedOpen, ok, seedActive);
            setFiles(loaded);
            setOpenFiles(recon.open);
            setActiveFile(recon.active);
            // Consume a transient reveal line (a new panel opened by
            // openFileForUser at a line): reveal it on the active seed tab, then
            // clear it from persisted meta so it never re-reveals on relaunch.
            if (
                typeof spec.meta?.reveal_line === 'number' &&
                recon.active &&
                ok.includes(recon.active)
            ) {
                setReveal({ file: recon.active, line: spec.meta.reveal_line });
                persistMeta({ reveal_line: undefined });
            }
            // Persist the pruned set so vanished tabs don't keep reappearing.
            if (recon.open.length !== seedOpen.length)
                persistTabs(recon.open, recon.active);
            // A file is open → auto-hide the tree unless pinned.
            if (!treePinnedRef.current) setTreeVisible(false);
        })();
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const save = useCallback(async () => {
        const file = activeFileRef.current;
        if (!file) return;
        const st = filesRef.current[file];
        if (!st) return;
        // A plugin tab saves through ITS body (the model lives there); the
        // body clears the dirty flag via onDirtyChange. Mark it self-written so
        // the fs-watch echo doesn't remount the body we just saved from.
        if (st.kind === 'plugin') {
            justWrote.current.set(file, Date.now());
            await pluginSaves.current.get(file)?.();
            setGitRefreshKey((k) => k + 1);
            return;
        }
        try {
            justWrote.current.set(file, Date.now());
            await api().files.write(workspacePath, file, st.content, system);
            setFiles((m) =>
                m[file]
                    ? { ...m, [file]: { ...m[file], dirty: false, baseline: st.content } }
                    : m,
            );
            // The file changed on disk — refresh git colours in the tree.
            setGitRefreshKey((k) => k + 1);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : String(e));
        }
    }, [workspacePath, system]);

    // Ctrl/Cmd+S → save active tab. Bound once; reads live refs.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                if (!activeFileRef.current) return;
                e.preventDefault();
                void save();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [save]);

    /** Switch the active tab (no disk read — each tab keeps its own state). */
    const activateTab = useCallback(
        (relPath: string) => {
            setActiveFile(relPath);
            persistTabs(openFilesRef.current, relPath);
        },
        [persistTabs],
    );

    /** Close a tab; confirm if it has unsaved edits. Re-activates a neighbour. */
    const closeTab = useCallback(
        async (relPath: string) => {
            if (filesRef.current[relPath]?.dirty) {
                const ok = await showPrompt({
                    title: 'Unsaved changes',
                    body: `"${baseName(relPath)}" has unsaved edits. Discard them?`,
                    confirmLabel: 'Discard',
                    destructive: true,
                });
                if (ok === null) return;
            }
            const next = closeTabState(
                openFilesRef.current,
                activeFileRef.current,
                relPath,
            );
            setOpenFiles(next.open);
            pluginSaves.current.delete(relPath);
            setFiles((m) => {
                const c = { ...m };
                delete c[relPath];
                return c;
            });
            if (next.active !== activeFileRef.current) setActiveFile(next.active);
            persistTabs(next.open, next.active);
        },
        [persistTabs],
    );

    const selectFile = useCallback(
        async (relPath: string) => {
            // openTab routes plugin-claimed files to a PLUGIN TAB in this panel
            // (§6.1) — the file always opens exactly where the user clicked it.
            const opened = await openTab(relPath);
            // A failed open keeps the tree up so the error stays visible.
            if (opened && !treePinnedRef.current) setTreeVisible(false);
        },
        [openTab],
    );

    const handleClose = useCallback(async () => {
        const anyDirty = Object.values(filesRef.current).some((s) => s.dirty);
        if (anyDirty) {
            const ok = await showPrompt({
                title: 'Unsaved changes',
                body: 'Some open files have unsaved edits. Discard them all?',
                confirmLabel: 'Discard',
                destructive: true,
            });
            if (ok === null) return;
        }
        onClose();
    }, [onClose]);

    /** Toggle the tree-pinned-open flag (persisted); pinning also reveals it. */
    const toggleTreePinned = useCallback(() => {
        setTreePinned((v) => {
            const next = !v;
            persistMeta({ tree_pinned: next });
            if (next) setTreeVisible(true);
            return next;
        });
    }, [persistMeta]);

    /**
     * Lock the Editor to a folder node (the PRIMARY affordance — invoked from
     * the file-tree right-click menu). Pins the tree root to the folder's
     * workspace-relative path and persists meta so the Editor reopens rooted
     * there across restarts.
     */
    const lockToFolder = useCallback(
        (node: TreeNodeData) => {
            const root = normaliseRoot(node.id);
            setLocked(true);
            setLockedRoot(root);
            persistMeta({ locked: true, root });
        },
        [persistMeta],
    );

    /** Clear the lock and restore the whole-workspace tree root. */
    const unlock = useCallback(() => {
        setLocked(false);
        setLockedRoot('');
        persistMeta({ locked: false, root: '' });
    }, [persistMeta]);

    /**
     * Head lock button: a quick toggle. Unlock when locked; when unlocked,
     * lock to the CURRENT tree root (the workspace root here — right-click a
     * folder for a sub-root).
     */
    const toggleLock = useCallback(() => {
        if (locked) {
            unlock();
            return;
        }
        setLocked(true);
        setLockedRoot('');
        persistMeta({ locked: true, root: '' });
    }, [locked, unlock, persistMeta]);

    return (
        <section
            className={`tpanel${focused ? ' focus' : ''}${attention ? ' attention' : ''}`}
            style={style}
        >
            <div className="tpanel-head">
                {/* LEFT cluster: tree-toggle + pin sit where the tree opens. */}
                <span className="pa pa-left">
                    <button
                        type="button"
                        className={`pctl${treeVisible ? ' is-on' : ''}`}
                        onClick={() => setTreeVisible((v) => !v)}
                        title={treeVisible ? 'Hide file tree' : 'Show file tree'}
                    >
                        <IconCode size={14} />
                    </button>
                    <button
                        type="button"
                        className={`pctl${treePinned ? ' is-pinned' : ''}`}
                        onClick={toggleTreePinned}
                        title={
                            treePinned
                                ? 'Unpin file tree (auto-hide on open)'
                                : 'Pin file tree open'
                        }
                    >
                        <IconPin size={13} />
                    </button>
                </span>
                <span className="pdot" style={{ background: '#8b5cf6' }} />
                <span className="pn">
                    <span className="nm">{spec.label}</span>
                    {active?.dirty && (
                        <span className="dirty-dot" title="Unsaved changes" />
                    )}
                    {locked && (
                        <span
                            className="lock-badge"
                            title={
                                lockedRoot
                                    ? `Locked to ${lockedRoot}`
                                    : 'Locked to workspace root'
                            }
                        >
                            <IconLock size={11} />
                        </span>
                    )}
                </span>
                {!activeFile && workspace ? (
                    <span className="ploc">
                        {workspace.project_name} · {workspace.backend}
                    </span>
                ) : null}
                <span className="grow" />
                <span className="pa">
                    <button
                        type="button"
                        className="pctl save-btn"
                        onClick={() => void save()}
                        disabled={!active?.dirty}
                        title={active?.dirty ? 'Save (Ctrl/Cmd+S)' : 'Saved'}
                    >
                        <IconCheck size={13} />
                    </button>
                    <button
                        type="button"
                        className={`pctl${wordWrap ? ' is-on' : ''}`}
                        onClick={() =>
                            setWordWrap((w) => {
                                const next = !w;
                                persistMeta({ word_wrap: next });
                                return next;
                            })
                        }
                        title={wordWrap ? 'Word wrap: on' : 'Word wrap: off'}
                    >
                        <IconWrap size={14} />
                    </button>
                    <button
                        type="button"
                        className={`pctl${locked ? ' is-on' : ''}`}
                        onClick={() => void toggleLock()}
                        title={
                            locked
                                ? 'Unlock — restore workspace root'
                                : 'Lock to a repo folder'
                        }
                    >
                        {locked ? <IconLock size={13} /> : <IconUnlock size={13} />}
                    </button>
                    {onMinimize && !maximized && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={onMinimize}
                            title="Send to side stack"
                        >
                            <IconMinimize />
                        </button>
                    )}
                    {onMaximize && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={onMaximize}
                            title={maximized ? 'Restore tiled view' : 'Maximize panel'}
                        >
                            {maximized ? <IconMinimize /> : <IconMaximize size={13} />}
                        </button>
                    )}
                    <button
                        type="button"
                        className="pctl"
                        onClick={() => void handleClose()}
                        title="Close panel"
                    >
                        <IconX />
                    </button>
                </span>
            </div>
            {openFiles.length > 0 && (
                <div className="code-tabs" role="tablist">
                    {openFiles.map((p) => (
                        <div
                            key={p}
                            role="tab"
                            aria-selected={p === activeFile}
                            className={`code-tab${p === activeFile ? ' active' : ''}`}
                            title={p}
                            onMouseDown={() => activateTab(p)}
                        >
                            <span className="code-tab-name">{baseName(p)}</span>
                            {files[p]?.dirty && (
                                <span className="code-tab-dot" aria-hidden />
                            )}
                            <button
                                type="button"
                                className="code-tab-close"
                                title="Close tab"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void closeTab(p);
                                }}
                            >
                                <IconX size={11} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <div className={`code-host${treeVisible ? '' : ' tree-hidden'}`}>
                {treeVisible && (
                    <div className="code-tree">
                        <FileTree
                            nodes={nodes}
                            selectedId={activeFile ?? undefined}
                            workspacePath={workspacePath}
                            system={system}
                            expandedIds={expandedIds}
                            onExpandedChange={setExpandedIds}
                            onSelectFile={(rel) => void selectFile(rel)}
                            onTreeChanged={reloadTree}
                            onOpenCreatedFile={(rel) => void selectFile(rel)}
                            onLockToFolder={lockToFolder}
                            onUnlock={unlock}
                            locked={locked}
                            lockedRoot={lockedRoot}
                            dirtyPaths={dirtyPaths}
                            gitRefreshKey={gitRefreshKey}
                        />
                    </div>
                )}
                <div className="code-editor-col">
                    {/* Plugin tabs stay MOUNTED while other tabs are active —
                        their editor model (unsaved edits included) lives inside
                        the body, so unmounting on a tab switch would discard it. */}
                    {openFiles
                        .filter((p) => files[p]?.kind === 'plugin' && files[p]?.plugin)
                        .map((p) => (
                            <div
                                key={p}
                                className="code-plugin-tab"
                                style={{
                                    display: p === activeFile ? 'flex' : 'none',
                                    flexDirection: 'column',
                                    flex: 1,
                                    minHeight: 0,
                                }}
                            >
                                <PluginEditorBody
                                    // rev in the key: an external change bumps it,
                                    // remounting the body so it re-reads from disk.
                                    key={`${p}:${files[p]?.rev ?? 0}`}
                                    pluginId={files[p]!.plugin!.pluginId}
                                    fancyExport={files[p]!.plugin!.fancyExport}
                                    root={workspacePath}
                                    file={p}
                                    onDirtyChange={(d) => setFileDirty(p, d)}
                                    registerSave={(fn) => pluginSaves.current.set(p, fn)}
                                />
                            </div>
                        ))}
                    {activeFile && active && active.kind !== 'plugin' ? (
                        <CodeEditor
                            // rev in the key: an external change re-reads the file
                            // and bumps rev, remounting with the fresh disk content.
                            key={`${activeFile}:${active.rev ?? 0}`}
                            className="cv-editor"
                            value={active.content}
                            // Inline diff gutter: mark lines changed since the file
                            // was last saved/loaded. baseline advances on save and on
                            // absorbed external reloads, so a clean tab shows no diff.
                            diffBase={active.baseline}
                            language={active.language}
                            theme="dark"
                            wordWrap={wordWrap}
                            cursorLine={resolveCursorLine(reveal, activeFile)}
                            onChange={(v) => {
                                setFiles((m) =>
                                    m[activeFile]
                                        ? {
                                              ...m,
                                              [activeFile]: {
                                                  ...m[activeFile],
                                                  content: v,
                                                  dirty: true,
                                              },
                                          }
                                        : m,
                                );
                            }}
                        >
                            <CodeEditor.Panel className="cv-panel" />
                            <CodeEditor.StatusBar />
                            <EditorWand />
                            <WordWrapSync wrap={wordWrap} />
                        </CodeEditor>
                    ) : activeFile && active?.kind === 'plugin' ? null : (
                        <div className="code-empty">
                            {loadError ? (
                                <span className="code-empty-err">{loadError}</span>
                            ) : (
                                <span>Pick a file from the tree to start editing.</span>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}

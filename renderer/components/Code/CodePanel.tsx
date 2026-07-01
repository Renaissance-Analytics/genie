import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CodeEditor } from '@particle-academy/fancy-code';
import FileTree from './FileTree';
import EditorWand from './EditorWand';
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
import {
    api,
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

/** Per-tab editor state: the file's text, its language, and unsaved flag. */
interface FileState {
    content: string;
    language: string;
    dirty: boolean;
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
        const opts = locked && lockedRoot ? { root: lockedRoot } : undefined;
        return api()
            .files.listTree(workspacePath, opts)
            .then((t) => setNodes(t))
            .catch(() => setNodes([]));
    }, [workspacePath, locked, lockedRoot]);

    // Latest reloadTree for the fs-watch subscription, so a lock/root change
    // doesn't churn (unwatch/rewatch) the watcher.
    const reloadTreeRef = useRef(reloadTree);
    reloadTreeRef.current = reloadTree;

    // Load the tree on mount and whenever the root (workspace or lock) shifts.
    useEffect(() => {
        let alive = true;
        const opts = locked && lockedRoot ? { root: lockedRoot } : undefined;
        void api()
            .files.listTree(workspacePath, opts)
            .then((t) => alive && setNodes(t))
            .catch(() => alive && setNodes([]));
        return () => {
            alive = false;
        };
    }, [workspacePath, locked, lockedRoot]);

    // Live-refresh: watch the workspace on disk so files created, renamed, or
    // deleted OUTSIDE the editor (an agent, a git checkout, an MCP tool) appear
    // without a manual reload. Debounced in main; here we just re-list on the
    // push. Keyed on workspacePath only — reloadTree is read via a ref so a
    // lock/root change never churns the watcher.
    useEffect(() => {
        void api().files.watch(workspacePath);
        let t: ReturnType<typeof setTimeout> | null = null;
        const off = api().on.treeChanged(({ workspacePath: changed }) => {
            if (changed !== workspacePath) return;
            if (t) clearTimeout(t);
            t = setTimeout(() => void reloadTreeRef.current(), 120);
        });
        return () => {
            if (t) clearTimeout(t);
            off();
            void api().files.unwatch(workspacePath);
        };
    }, [workspacePath]);

    /** Open (or focus) a file as a tab. Reads from disk only if not already open. */
    const openTab = useCallback(
        async (relPath: string) => {
            setLoadError(null);
            try {
                if (!filesRef.current[relPath]) {
                    const { content: text } = await api().files.read(
                        workspacePath,
                        relPath,
                    );
                    setFiles((m) => ({
                        ...m,
                        [relPath]: {
                            content: text,
                            language: languageFor(relPath),
                            dirty: false,
                        },
                    }));
                }
                const next = openTabState(openFilesRef.current, relPath);
                setOpenFiles(next.open);
                setActiveFile(next.active);
                persistTabs(next.open, next.active);
            } catch (e) {
                setLoadError(e instanceof Error ? e.message : String(e));
            }
        },
        [workspacePath, persistTabs],
    );

    // External "open this file" requests targeting THIS live panel (the
    // openFileForUser MCP tool reusing an already-open editor): open the path as
    // a tab + focus it. The mount-seed below only runs once, so a live panel
    // needs this side channel.
    useEffect(() => {
        return onOpenInPanel(spec.id, (relPath, line) => {
            void openTab(relPath);
            if (typeof line === 'number') setReveal({ file: relPath, line });
            if (!treePinnedRef.current) setTreeVisible(false);
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
                    const { content: text } = await api().files.read(
                        workspacePath,
                        rel,
                    );
                    loaded[rel] = {
                        content: text,
                        language: languageFor(rel),
                        dirty: false,
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
        try {
            await api().files.write(workspacePath, file, st.content);
            setFiles((m) =>
                m[file] ? { ...m, [file]: { ...m[file], dirty: false } } : m,
            );
            // The file changed on disk — refresh git colours in the tree.
            setGitRefreshKey((k) => k + 1);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : String(e));
        }
    }, [workspacePath]);

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
            await openTab(relPath);
            if (!treePinnedRef.current) setTreeVisible(false);
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
                    {activeFile && active ? (
                        <CodeEditor
                            key={activeFile}
                            className="cv-editor"
                            value={active.content}
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
                        </CodeEditor>
                    ) : (
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

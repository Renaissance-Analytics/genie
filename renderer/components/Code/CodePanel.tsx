import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CodeEditor } from '@particle-academy/fancy-code';
import FileTree from './FileTree';
import {
    IconCode,
    IconLock,
    IconMaximize,
    IconMinimize,
    IconUnlock,
    IconX,
} from '../Master/icons';
import { showPrompt } from '../Master/Prompt';
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
    maximized?: boolean;
    style?: CSSProperties;
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
 * Tree-toggle lives at the LEFT of the head (the tree opens on the left
 * edge, so the re-open icon sits where the tree appears). Maximize/Close
 * stay on the right.
 *
 * Lock (Item 5): a locked view pins the tree to a workspace-relative
 * `root` folder and reopens the same `file_path` on relaunch. Persisted in
 * the spec's `meta_json` ({ locked, root, file_path }). Reads/writes still
 * path-guard against the WORKSPACE root in main — the locked root is only
 * the tree's starting folder, never a security boundary.
 */
export default function CodePanel({
    spec,
    workspace,
    onClose,
    onMaximize,
    onMinimize,
    focused,
    maximized,
    style,
}: Props) {
    const workspacePath = workspace?.path ?? spec.cwd;

    const [nodes, setNodes] = useState<TreeNodeData[]>([]);
    const [treeVisible, setTreeVisible] = useState(true);
    const [openFile, setOpenFile] = useState<string | null>(
        spec.meta?.file_path ?? null,
    );
    const [content, setContent] = useState('');
    const [language, setLanguage] = useState('plaintext');
    const [dirty, setDirty] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    // Lock state seeded from persisted meta; pins the tree root + reopens
    // the same file on relaunch / workspace switch.
    const [locked, setLocked] = useState<boolean>(!!spec.meta?.locked);
    const [lockedRoot, setLockedRoot] = useState<string>(spec.meta?.root ?? '');

    // Latest dirty/content for the keydown handler without re-binding it.
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    const contentRef = useRef(content);
    contentRef.current = content;
    const openFileRef = useRef(openFile);
    openFileRef.current = openFile;

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

    /** (Re)load the tree, rooting at the locked subfolder when locked. */
    const reloadTree = useCallback(() => {
        const opts = locked && lockedRoot ? { root: lockedRoot } : undefined;
        return api()
            .files.listTree(workspacePath, opts)
            .then((t) => setNodes(t))
            .catch(() => setNodes([]));
    }, [workspacePath, locked, lockedRoot]);

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

    const loadFile = useCallback(
        async (relPath: string) => {
            setLoadError(null);
            try {
                const { content: text } = await api().files.read(
                    workspacePath,
                    relPath,
                );
                setContent(text);
                setOpenFile(relPath);
                setLanguage(languageFor(relPath));
                setDirty(false);
                setTreeVisible(false); // auto-hide tree on open
                persistMeta({ file_path: relPath });
            } catch (e) {
                setLoadError(e instanceof Error ? e.message : String(e));
            }
        },
        [workspacePath, persistMeta],
    );

    // Seed the editor from a persisted open file once the panel mounts.
    useEffect(() => {
        if (spec.meta?.file_path) void loadFile(spec.meta.file_path);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const save = useCallback(async () => {
        const file = openFileRef.current;
        if (!file) return;
        try {
            await api().files.write(workspacePath, file, contentRef.current);
            setDirty(false);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : String(e));
        }
    }, [workspacePath]);

    // Ctrl/Cmd+S → save. Bound once; reads live refs so it doesn't churn.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                if (!openFileRef.current) return;
                e.preventDefault();
                void save();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [save]);

    const guardUnsaved = useCallback(async (): Promise<boolean> => {
        if (!dirtyRef.current) return true;
        const ok = await showPrompt({
            title: 'Unsaved changes',
            body: 'This file has unsaved edits. Discard them?',
            confirmLabel: 'Discard',
            destructive: true,
        });
        return ok !== null;
    }, []);

    const selectFile = useCallback(
        async (relPath: string) => {
            if (relPath === openFileRef.current) {
                setTreeVisible(false);
                return;
            }
            if (!(await guardUnsaved())) return;
            void loadFile(relPath);
        },
        [guardUnsaved, loadFile],
    );

    const handleClose = useCallback(async () => {
        if (!(await guardUnsaved())) return;
        onClose();
    }, [guardUnsaved, onClose]);

    /**
     * Toggle the lock. Locking prompts for a workspace-relative root folder
     * (prefilled with the current locked root; blank = whole workspace),
     * then persists meta.locked + meta.root and re-roots the tree. Unlocking
     * clears both and restores the workspace root.
     */
    const toggleLock = useCallback(async () => {
        if (locked) {
            setLocked(false);
            setLockedRoot('');
            persistMeta({ locked: false, root: '' });
            return;
        }
        const picked = await showPrompt({
            title: 'Lock this code view',
            label: 'Root folder (workspace-relative)',
            body: 'The view will reopen pinned to this folder and the current file. Leave blank to lock to the whole workspace. e.g. repos/genie',
            initial: lockedRoot,
            placeholder: 'repos/genie',
            confirmLabel: 'Lock',
        });
        // showPrompt returns null on cancel; a submitted blank is impossible
        // (input mode rejects empty), so an empty root is opted into by
        // confirming with the seed cleared — treat null as cancel only.
        if (picked === null) return;
        const root = normaliseRoot(picked);
        setLocked(true);
        setLockedRoot(root);
        persistMeta({ locked: true, root, file_path: openFileRef.current ?? undefined });
    }, [locked, lockedRoot, persistMeta]);

    return (
        <section className={`tpanel${focused ? ' focus' : ''}`} style={style}>
            <div className="tpanel-head">
                {/* LEFT cluster: tree-toggle sits where the tree opens. */}
                <span className="pa pa-left">
                    <button
                        type="button"
                        className={`pctl${treeVisible ? ' is-on' : ''}`}
                        onClick={() => setTreeVisible((v) => !v)}
                        title={treeVisible ? 'Hide file tree' : 'Show file tree'}
                    >
                        <IconCode size={14} />
                    </button>
                </span>
                <span className="pdot" style={{ background: '#8b5cf6' }} />
                <span className="pn">
                    <span className="nm">{spec.label}</span>
                    {dirty && <span className="dirty-dot" title="Unsaved changes" />}
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
                {openFile ? (
                    <span className="ploc">{openFile}</span>
                ) : workspace ? (
                    <span className="ploc">
                        {workspace.project_name} · {workspace.backend}
                    </span>
                ) : null}
                <span className="grow" />
                <span className="pa">
                    <button
                        type="button"
                        className={`pctl${locked ? ' is-on' : ''}`}
                        onClick={() => void toggleLock()}
                        title={
                            locked
                                ? 'Unlock — restore workspace root'
                                : 'Lock to a repo folder + current file'
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
            <div className={`code-host${treeVisible ? '' : ' tree-hidden'}`}>
                {treeVisible && (
                    <div className="code-tree">
                        <FileTree
                            nodes={nodes}
                            selectedId={openFile ?? undefined}
                            workspacePath={workspacePath}
                            onSelectFile={(rel) => void selectFile(rel)}
                            onTreeChanged={reloadTree}
                            onOpenCreatedFile={(rel) => void selectFile(rel)}
                        />
                    </div>
                )}
                <div className="code-editor-col">
                    {openFile ? (
                        <CodeEditor
                            key={openFile}
                            value={content}
                            language={language}
                            theme="dark"
                            onChange={(v) => {
                                setContent(v);
                                setDirty(true);
                            }}
                        >
                            <CodeEditor.Panel />
                            <CodeEditor.StatusBar />
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

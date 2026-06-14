import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CodeEditor } from '@particle-academy/fancy-code';
import FileTree from './FileTree';
import { IconCode, IconMaximize, IconMinimize, IconX } from '../Master/icons';
import { showPrompt } from '../Master/Prompt';
import {
    api,
    type TerminalSpec,
    type TreeNodeData,
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
 * 'plaintext' (no highlighting, still fully editable). Driving the
 * `language` prop is purely cosmetic — the editor never refuses a file.
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

/**
 * A Code view tile. Mirrors TerminalPanel's chrome (`.tpanel` head with
 * label/loc/controls) but its body is `.code-host`: a collapsible file
 * tree column beside a fancy-code editor.
 *
 * Tree visibility rules (locked by the plan):
 *   - starts visible,
 *   - auto-hides the moment a file is selected,
 *   - re-opens ONLY via the head tree-toggle icon — there are deliberately
 *     NO hover handlers, so the tree never flickers in/out as the pointer
 *     crosses the panel.
 *
 * Editing: the editor is controlled (`value`/`onChange`). Edits set the
 * dirty flag; Ctrl/Cmd+S writes via `files:write` and clears it. Switching
 * files or closing with unsaved changes prompts first.
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

    // Latest dirty/content for the keydown handler without re-binding it.
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    const contentRef = useRef(content);
    contentRef.current = content;
    const openFileRef = useRef(openFile);
    openFileRef.current = openFile;

    // Load the tree on mount (and if the workspace path changes).
    useEffect(() => {
        let alive = true;
        void api()
            .files.listTree(workspacePath)
            .then((t) => alive && setNodes(t))
            .catch(() => alive && setNodes([]));
        return () => {
            alive = false;
        };
    }, [workspacePath]);

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
                void api()
                    .terminalSpec.update(spec.id, {
                        meta: { ...spec.meta, file_path: relPath },
                    })
                    .catch(() => {});
            } catch (e) {
                setLoadError(e instanceof Error ? e.message : String(e));
            }
        },
        [workspacePath, spec.id, spec.meta],
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

    return (
        <section className={`tpanel${focused ? ' focus' : ''}`} style={style}>
            <div className="tpanel-head">
                <span className="pdot" style={{ background: '#8b5cf6' }} />
                <span className="pn">
                    <span className="nm">{spec.label}</span>
                    {dirty && <span className="dirty-dot" title="Unsaved changes" />}
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
                        className={`pctl${treeVisible ? ' is-on' : ''}`}
                        onClick={() => setTreeVisible((v) => !v)}
                        title={treeVisible ? 'Hide file tree' : 'Show file tree'}
                    >
                        <IconCode size={14} />
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
                            onSelectFile={(rel) => void selectFile(rel)}
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

import {
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
} from 'react';
import type { Deck } from '@particle-academy/fancy-slides';
import type { WorkbookData } from '@particle-academy/fancy-sheets';
import { IconCheck, IconMaximize, IconMinimize, IconX } from '../Master/icons';
import {
    base64ToBytes,
    bytesToBase64,
    deckFromBytes,
    deckToBytes,
    holyBytesFromWorkbook,
    workbookFromHolyBytes,
} from '../../lib/plugin-editor-models';
import { api, type TerminalSpec, type WorkspaceRow } from '../../lib/genie';

/**
 * Host for a first-party Fancy editor a plugin declared for a file type
 * (design §6.1/§6.2, §12.2). The plugin ships NO editor code — Genie loads the
 * vetted, bundled Fancy component named by the spec's `fancy_export` and wires it
 * to the file via the capability-scoped BINARY bridge (`plugins:editor-read` /
 * `-write` -> the Phase-1 guarded, extension-limited fs gate).
 *
 * Data flow (open):  guarded binary read -> dark-slide/holy-sheet reader -> model
 *                    -> DeckEditor / SheetWorkbook.
 * Data flow (save):  model -> dark-slide/holy-sheet writer -> bytes -> guarded
 *                    binary write.
 *
 * Present (§6.3): the presentation editor's Present action switches to a
 * full-viewport `SlideViewer` (read-only, keyboard nav) until dismissed (Esc).
 *
 * The heavy Fancy editors are code-split via `lazy` so opening a plugin editor
 * (not the common case) is what pulls them in.
 */

const DeckEditorLazy = lazy(() =>
    import('@particle-academy/fancy-slides').then((m) => ({ default: m.DeckEditor })),
);
const SlideViewerLazy = lazy(() =>
    import('@particle-academy/fancy-slides').then((m) => ({ default: m.SlideViewer })),
);
const SheetWorkbookLazy = lazy(() =>
    import('@particle-academy/fancy-sheets').then((m) => ({ default: m.SheetWorkbook })),
);
const DocumentEditorLazy = lazy(() => import('./DocumentEditor'));

interface Props {
    spec: TerminalSpec;
    workspace?: WorkspaceRow;
    onClose: () => void;
    onMaximize?: () => void;
    onMinimize?: () => void;
    focused?: boolean;
    attention?: boolean;
    maximized?: boolean;
    style?: CSSProperties;
}

/** 'sheet' = spreadsheet, 'doc' = markdown/word document, 'deck' = presentation. */
type EditorKind = 'deck' | 'sheet' | 'doc';

function kindFor(fancyExport: string): EditorKind {
    if (fancyExport === 'SheetWorkbook') return 'sheet';
    if (fancyExport === 'Editor') return 'doc';
    return 'deck';
}

function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function baseName(p: string): string {
    return p.split(/[\\/]/).pop() || p;
}

export default function PluginEditorHost({
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
    const root = workspace?.path ?? spec.cwd;
    const file = String(spec.meta?.file ?? spec.meta?.file_path ?? '');
    const pluginId = String(spec.meta?.plugin_id ?? '');
    const fancyExport = String(spec.meta?.fancy_export ?? 'DeckEditor');
    const kind = kindFor(fancyExport);

    const [deck, setDeck] = useState<Deck | null>(null);
    const [workbook, setWorkbook] = useState<WorkbookData | null>(null);
    const [docText, setDocText] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [presenting, setPresenting] = useState(false);

    const deckRef = useRef<Deck | null>(null);
    deckRef.current = deck;
    const workbookRef = useRef<WorkbookData | null>(null);
    workbookRef.current = workbook;
    const docTextRef = useRef<string | null>(null);
    docTextRef.current = docText;

    // The Document editor's model is a MARKDOWN string for both file types;
    // .docx converts at the main-side seam (plugins:document-convert).
    const isDocx = /\.docx$/i.test(file);

    // Open: guarded binary read -> reader -> model.
    useEffect(() => {
        let alive = true;
        setLoading(true);
        setError(null);
        void (async () => {
            try {
                const res = await api().plugins.editorRead(pluginId, root, file);
                if (!res.ok || !res.value) throw new Error(res.error || 'Could not read the file.');
                if (kind === 'doc') {
                    let md: string;
                    if (isDocx) {
                        const conv = await api().plugins.convertDocument({
                            to: 'markdown',
                            base64: res.value.base64,
                        });
                        if (!conv.ok || conv.markdown === undefined) {
                            throw new Error(conv.error || 'Could not convert the document.');
                        }
                        md = conv.markdown;
                    } else {
                        md = new TextDecoder('utf-8').decode(base64ToBytes(res.value.base64));
                    }
                    if (alive) setDocText(md);
                    return;
                }
                const bytes = base64ToBytes(res.value.base64);
                if (!alive) return;
                if (kind === 'sheet') setWorkbook(workbookFromHolyBytes(bytes));
                else setDeck(deckFromBytes(bytes));
            } catch (e) {
                if (alive) setError(msg(e));
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [pluginId, root, file, kind, isDocx]);

    // Save: model -> writer -> bytes -> guarded binary write.
    const save = useCallback(async () => {
        try {
            let base64: string;
            if (kind === 'doc') {
                if (docTextRef.current === null) return;
                if (isDocx) {
                    const conv = await api().plugins.convertDocument({
                        to: 'docx',
                        markdown: docTextRef.current,
                    });
                    if (!conv.ok || !conv.base64) {
                        throw new Error(conv.error || 'Could not convert the document.');
                    }
                    base64 = conv.base64;
                } else {
                    base64 = bytesToBase64(new TextEncoder().encode(docTextRef.current));
                }
            } else if (kind === 'sheet') {
                if (!workbookRef.current) return;
                base64 = bytesToBase64(holyBytesFromWorkbook(workbookRef.current));
            } else {
                if (!deckRef.current) return;
                base64 = bytesToBase64(deckToBytes(deckRef.current));
            }
            const res = await api().plugins.editorWrite(pluginId, root, file, base64);
            if (!res.ok) throw new Error(res.error || 'Could not save the file.');
            setDirty(false);
            setError(null);
        } catch (e) {
            setError(msg(e));
        }
    }, [kind, pluginId, root, file, isDocx]);

    // Ctrl/Cmd+S -> save (bound once; reads live refs).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                void save();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [save]);

    const body = (() => {
        if (error) {
            return (
                <div className="code-empty">
                    <span className="code-empty-err">{error}</span>
                </div>
            );
        }
        if (loading) {
            return (
                <div className="code-empty">
                    <span>Opening {baseName(file)}…</span>
                </div>
            );
        }
        if (kind === 'doc') {
            return docText !== null ? (
                <Suspense fallback={<div className="code-empty"><span>Loading editor…</span></div>}>
                    <DocumentEditorLazy
                        value={docText}
                        onChange={(v) => {
                            setDocText(v);
                            setDirty(true);
                        }}
                    />
                </Suspense>
            ) : null;
        }
        if (kind === 'sheet') {
            return workbook ? (
                <Suspense fallback={<div className="code-empty"><span>Loading editor…</span></div>}>
                    <SheetWorkbookLazy
                        data={workbook}
                        onChange={(w) => {
                            setWorkbook(w);
                            setDirty(true);
                        }}
                    />
                </Suspense>
            ) : null;
        }
        return deck ? (
            <Suspense fallback={<div className="code-empty"><span>Loading editor…</span></div>}>
                <DeckEditorLazy
                    value={deck}
                    onChange={(d) => {
                        setDeck(d);
                        setDirty(true);
                    }}
                    onPresent={() => setPresenting(true)}
                />
            </Suspense>
        ) : null;
    })();

    return (
        <section
            className={`tpanel${focused ? ' focus' : ''}${attention ? ' attention' : ''}`}
            style={style}
        >
            <div className="tpanel-head">
                <span className="pdot" style={{ background: '#8b5cf6' }} />
                <span className="pn">
                    <span className="nm">{spec.label}</span>
                    {dirty && <span className="dirty-dot" title="Unsaved changes" />}
                </span>
                <span className="grow" />
                <span className="pa">
                    <button
                        type="button"
                        className="pctl save-btn"
                        onClick={() => void save()}
                        disabled={!dirty}
                        title={dirty ? 'Save (Ctrl/Cmd+S)' : 'Saved'}
                    >
                        <IconCheck size={13} />
                    </button>
                    {kind === 'deck' && deck && (
                        <button
                            type="button"
                            className="pctl"
                            onClick={() => setPresenting(true)}
                            title="Present (full screen)"
                        >
                            Present
                        </button>
                    )}
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
                    <button type="button" className="pctl" onClick={onClose} title="Close panel">
                        <IconX />
                    </button>
                </span>
            </div>
            <div className="plugin-editor-host-body">{body}</div>
            {presenting && deck && (
                <div
                    className="plugin-editor-present"
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 9999,
                        background: '#000',
                    }}
                >
                    <Suspense fallback={null}>
                        <SlideViewerLazy deck={deck} onExit={() => setPresenting(false)} />
                    </Suspense>
                    <button
                        type="button"
                        className="pctl"
                        onClick={() => setPresenting(false)}
                        title="Exit present (Esc)"
                        style={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}
                    >
                        <IconX />
                    </button>
                </div>
            )}
        </section>
    );
}

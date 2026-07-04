import {
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import type { Deck } from '@particle-academy/fancy-slides';
import type { WorkbookData } from '@particle-academy/fancy-sheets';
import { IconX } from '../Master/icons';
import {
    base64ToBytes,
    bytesToBase64,
    deckFromBytes,
    deckToBytes,
    holyBytesFromWorkbook,
    workbookFromHolyBytes,
} from '../../lib/plugin-editor-models';
import { api } from '../../lib/genie';

/**
 * The chrome-free BODY of a plugin-declared Fancy editor: open the file
 * through the capability-scoped binary bridge, hold the editor model, render
 * the vetted first-party Fancy component, and save the model back. Hosted in
 * TWO places:
 *   - as a TAB inside a Code panel (the normal open path — a plugin-claimed
 *     file opens in the SAME editor panel the user clicked in), and
 *   - by PluginEditorHost, the standalone panel kept for previously-created
 *     'plugin' specs.
 *
 * Data flow (open):  guarded binary read -> model reader -> editor.
 * Data flow (save):  model -> writer -> bytes -> guarded binary write.
 * The parent drives save (its save button / Ctrl+S) via `registerSave`, and
 * mirrors the dirty flag via `onDirtyChange`.
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

/** 'sheet' = spreadsheet, 'doc' = markdown/word document, 'deck' = presentation. */
export type PluginEditorKind = 'deck' | 'sheet' | 'doc';

export function pluginEditorKind(fancyExport: string): PluginEditorKind {
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

export interface PluginEditorBodyProps {
    pluginId: string;
    fancyExport: string;
    /** The workspace root the file path is relative to. */
    root: string;
    /** Workspace-relative file path. */
    file: string;
    /** Mirrors the unsaved-changes flag to the hosting tab/panel. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Hands the parent this body's save() so its button / Ctrl+S can drive it. */
    registerSave?: (save: () => Promise<void>) => void;
}

export default function PluginEditorBody({
    pluginId,
    fancyExport,
    root,
    file,
    onDirtyChange,
    registerSave,
}: PluginEditorBodyProps) {
    const kind = pluginEditorKind(fancyExport);

    const [deck, setDeck] = useState<Deck | null>(null);
    const [workbook, setWorkbook] = useState<WorkbookData | null>(null);
    const [docText, setDocText] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [presenting, setPresenting] = useState(false);

    const deckRef = useRef<Deck | null>(null);
    deckRef.current = deck;
    const workbookRef = useRef<WorkbookData | null>(null);
    workbookRef.current = workbook;
    const docTextRef = useRef<string | null>(null);
    docTextRef.current = docText;
    const onDirtyRef = useRef(onDirtyChange);
    onDirtyRef.current = onDirtyChange;

    const markDirty = useCallback(() => onDirtyRef.current?.(true), []);

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
            onDirtyRef.current?.(false);
            setError(null);
        } catch (e) {
            setError(msg(e));
        }
    }, [kind, pluginId, root, file, isDocx]);

    // Hand the parent this body's save whenever it changes.
    useEffect(() => {
        registerSave?.(save);
    }, [registerSave, save]);

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

    const fallback = (
        <div className="code-empty">
            <span>Loading editor…</span>
        </div>
    );

    if (kind === 'doc') {
        return docText !== null ? (
            <Suspense fallback={fallback}>
                <DocumentEditorLazy
                    value={docText}
                    onChange={(v) => {
                        setDocText(v);
                        markDirty();
                    }}
                />
            </Suspense>
        ) : null;
    }
    if (kind === 'sheet') {
        return workbook ? (
            <Suspense fallback={fallback}>
                <SheetWorkbookLazy
                    data={workbook}
                    onChange={(w) => {
                        setWorkbook(w);
                        markDirty();
                    }}
                />
            </Suspense>
        ) : null;
    }
    return deck ? (
        <>
            <Suspense fallback={fallback}>
                <DeckEditorLazy
                    value={deck}
                    onChange={(d) => {
                        setDeck(d);
                        markDirty();
                    }}
                    onPresent={() => setPresenting(true)}
                />
            </Suspense>
            {presenting && (
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
        </>
    ) : null;
}

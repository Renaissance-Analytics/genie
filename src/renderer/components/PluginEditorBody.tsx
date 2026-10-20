import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Callout } from '@particle-academy/react-fancy';
import type { Deck } from '@particle-academy/fancy-slides';
import type { WorkbookData } from '@particle-academy/fancy-sheets';
import { joinFrontMatter, parseFrontMatter, supportsFrontMatter, type ParsedFrontMatter } from '../../core/front-matter.js';
import { VETTED_FANCY_EDITORS } from '../../core/plugin-editors.js';
import type { GenieBridge } from '../bridge.js';
import type { WorkbookSource } from '../plugin-documents.js';

/**
 * THE BODY OF A PLUGIN EDITOR TAB (beta.33 item 14; Genie 1 renderer/components/Plugins/PluginEditorBody.tsx).
 *
 * Open:  the file's BYTES through the plugin gate (`files.readBytes`, naming the plugin) → the model reader → the editor.
 * Save:  the model → the writer → bytes → `files.writeBytes` against the sha that was read. A file that changed underneath is
 *        a CONFLICT, said here with the two choices (reload it, or keep yours) — never an overwrite.
 *
 * The parent drives Save (its button, Ctrl/Cmd+S) through `registerSave`, and mirrors the dirty flag via `onDirtyChange`.
 * A markdown file's front matter is split off between the read and the editor and put back on save — byte for byte when
 * nobody touched it (core/front-matter.ts). The editors and the format libraries load only when a plugin tab opens.
 */

const DocumentEditorLazy = lazy(() => import('./DocumentEditor.js').then((m) => ({ default: m.DocumentEditor })));
const SheetWorkbookLazy = lazy(() => import('@particle-academy/fancy-sheets').then((m) => ({ default: m.SheetWorkbook })));
const DeckEditorLazy = lazy(() => import('@particle-academy/fancy-slides').then((m) => ({ default: m.DeckEditor })));
const SlideViewerLazy = lazy(() => import('@particle-academy/fancy-slides').then((m) => ({ default: m.SlideViewer })));
const documents = () => import('../plugin-documents.js');

export interface PluginEditorBodyProps {
    readonly pluginId: string;
    readonly fancyExport: string;
    readonly workspaceId: string;
    /** Workspace-relative. */
    readonly path: string;
    readonly files: GenieBridge['files'];
    readonly onDirtyChange: (dirty: boolean) => void;
    /** Hands the parent this body's save, so its Save button and Ctrl/Cmd+S drive it. */
    readonly registerSave: (save: () => Promise<void>) => void;
}

type Model =
    | { kind: 'doc'; body: string; split: ParsedFrontMatter | null; frontMatter: string | null }
    | { kind: 'sheet'; workbook: WorkbookData; source: WorkbookSource; readOnly: string | null }
    | { kind: 'deck'; deck: Deck };

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PluginEditorBody({ pluginId, fancyExport, workspaceId, path, files, onDirtyChange, registerSave }: PluginEditorBodyProps) {
    const vetted = (VETTED_FANCY_EDITORS as readonly string[]).includes(fancyExport);
    const [model, setModel] = useState<Model | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [conflict, setConflict] = useState<{ sha: string } | null>(null);
    const [presenting, setPresenting] = useState(false);
    // A reload (Take theirs, or the disk changed under a clean tab) re-reads by bumping this.
    const [rev, setRev] = useState(0);
    const sha = useRef<string | null>(null);
    const modelRef = useRef<Model | null>(null);
    modelRef.current = model;
    const dirtyRef = useRef(onDirtyChange);
    dirtyRef.current = onDirtyChange;

    useEffect(() => {
        if (!vetted) return;
        let alive = true;
        setError(null);
        void (async () => {
            if (!files.readBytes) throw new Error('this window cannot open plugin files (no host files)');
            const read = await files.readBytes(workspaceId, pluginId, path);
            if (!read.ok) throw new Error(read.error);
            const docs = await documents();
            const bytes = docs.base64ToBytes(read.base64);
            const kind = docs.editorKindOf(fancyExport);
            let next: Model;
            if (kind === 'doc') {
                const markdown = docs.markdownFromBytes(path, bytes);
                const split = supportsFrontMatter(path) ? parseFrontMatter(markdown) : null;
                next = { kind: 'doc', body: split ? split.body : markdown, split, frontMatter: split ? split.frontMatter : null };
            } else if (kind === 'sheet') {
                next = { kind: 'sheet', ...docs.workbookFromBytes(path, bytes) };
            } else {
                next = { kind: 'deck', deck: docs.deckFromBytes(bytes) };
            }
            if (!alive) return;
            sha.current = read.sha;
            setConflict(null);
            setModel(next);
            dirtyRef.current(false);
        })().catch((e: unknown) => { if (alive) setError(words(e)); });
        return () => { alive = false; };
    }, [vetted, files, workspaceId, pluginId, path, fancyExport, rev]);

    const write = useCallback(async (expected: string | null) => {
        const m = modelRef.current;
        if (!m || !files.writeBytes) return;
        try {
            const docs = await documents();
            let bytes: Uint8Array;
            let written: string | null = null;
            if (m.kind === 'doc') {
                written = m.split ? joinFrontMatter(m.split, m.frontMatter, m.body) : m.body;
                bytes = docs.bytesFromMarkdown(path, written);
            } else if (m.kind === 'sheet') {
                bytes = docs.bytesFromWorkbook(path, m.workbook, m.source);
            } else {
                bytes = docs.bytesFromDeck(m.deck);
            }
            const r = await files.writeBytes(workspaceId, pluginId, path, docs.bytesToBase64(bytes), expected);
            if (!r.ok) {
                if (r.conflict) setConflict({ sha: r.conflict.sha });
                setError(r.reason);
                return;
            }
            sha.current = r.sha;
            setConflict(null);
            setError(null);
            // Re-anchor the front-matter split on what is now on disk, so the next untouched save stays byte-exact.
            if (m.kind === 'doc' && m.split && written !== null) { const split = parseFrontMatter(written); setModel({ ...m, split, frontMatter: split.frontMatter, body: split.body }); }
            dirtyRef.current(false);
        } catch (e) {
            setError(words(e));
        }
    }, [files, workspaceId, pluginId, path]);

    useEffect(() => { registerSave(() => write(sha.current)); }, [registerSave, write]);

    const change = (next: Model) => { setModel(next); dirtyRef.current(true); };

    if (!vetted) {
        return <p data-plugin-refused={path} className="m-4 text-sm text-[var(--fg-3)]">{pluginId} asked for {fancyExport}, which is not a Fancy editor Genie bundles; this file is not opened.</p>;
    }
    const opening = <p data-plugin-opening={path} className="p-4 text-sm text-[var(--fg-3)]">Opening {baseName(path)}…</p>;
    const banner = error ? (
        <div data-plugin-error={path} className="m-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--danger)] p-2 text-xs">
            <span className="min-w-0 flex-1">{conflict ? error : model ? `Not saved: ${error}` : `${baseName(path)} could not be opened: ${error}`}</span>
            {conflict ? (
                <>
                    <Button size="sm" onClick={() => setRev((r) => r + 1)}>Reload from disk</Button>
                    <Button size="sm" variant="ghost" onClick={() => void write(conflict.sha)}>Keep mine</Button>
                </>
            ) : null}
        </div>
    ) : null;
    if (!model) return error ? banner : opening;

    return (
        <div data-plugin-editor={fancyExport} className="flex h-full min-h-0 flex-1 flex-col">
            {banner}
            <Suspense fallback={opening}>
                {model.kind === 'doc' ? (
                    <DocumentEditorLazy
                        value={model.body}
                        onChange={(body) => change({ ...model, body })}
                        // Both absent for a type that carries no front matter (.docx): that keeps the fm pill off it.
                        {...(model.split ? { frontMatter: model.frontMatter, onFrontMatterChange: (frontMatter: string | null) => change({ ...model, frontMatter }) } : {})}
                    />
                ) : model.kind === 'sheet' ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        {model.readOnly ? <Callout color="amber" className="m-2 shrink-0 text-xs">{model.readOnly}</Callout> : null}
                        <SheetWorkbookLazy className="min-h-0 flex-1" data={model.workbook} readOnly={model.readOnly !== null} hideTabs={model.source.kind === 'csv'} onChange={(workbook) => change({ ...model, workbook })} />
                    </div>
                ) : (
                    <DeckEditorLazy className="min-h-0 flex-1" value={model.deck} onChange={(deck) => change({ ...model, deck })} onPresent={() => setPresenting(true)} />
                )}
            </Suspense>
            {model.kind === 'deck' && presenting ? (
                <div data-presenting={path} className="fixed inset-0 z-[9999] bg-black">
                    <Suspense fallback={null}>
                        <SlideViewerLazy deck={model.deck} onExit={() => setPresenting(false)} />
                    </Suspense>
                </div>
            ) : null}
        </div>
    );
}

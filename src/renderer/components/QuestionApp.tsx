import { useEffect, useState, type CSSProperties } from 'react';
import { ContentRenderer } from '@particle-academy/react-fancy';
import { genieClipboardWriter } from '../clipboard.js';
import { FileViewer } from '@particle-academy/fancy-code';
import { extractFileRefs, splitByExistence, type AskFileRef } from '../../core/ask-file-refs.js';
import { questionWindowAction } from '../../core/keys.js';
import { ageLabel, type DeckItem } from '../../core/deck.js';
import { activeQuestion, type QuestionDraft, type QuestionDrafts } from '../../core/question-drafts.js';
import { QuestionForm } from './QuestionForm.js';

/**
 * THE FORCETHEQUESTION WINDOW'S CONTENT: who asks (and from which workspace — its NAME, as the rail says it, never its id),
 * how long ago, how many more wait, the questions each with its own note, Answer, Later or Dismiss (put aside without an
 * answer; the agent is told — the Deck offers the same). Frameless, so the header is the handle the window is dragged by. A refused answer is said
 * BESIDE the Answer button, where it was given — not at the top of a window the person has scrolled away from (the owner,
 * 2026-10-14: "I click the answer button but nothing happens"), and never only in a log.
 *
 * ## Its own queue
 *
 * The owner, 2026-10-15: "The FTQ window should have its own queue so I can answer any and all questions of all agents
 * just like genie 1 had." With more than one question asked, the window lists every one — the agent, its workspace, how
 * long ago, what it asks — and the person picks which to answer, in any order (Genie 1's queue strip, genie
 * renderer/pages/ask.tsx). One put off with Later is still listed, marked. Each question's form starts from the draft
 * kept for it, so moving between them, or another agent asking meanwhile, loses nothing typed.
 */
export interface QuestionAppView {
    readonly item: DeckItem;
    readonly waiting: number;
    /** Every live question the window holds, oldest first (absent = just `item`). */
    readonly queue?: readonly DeckItem[];
    /** Which of the queue were put off with Later or a closed window. */
    readonly parked?: readonly string[];
    /** Main's kept drafts, by question id. */
    readonly drafts?: QuestionDrafts;
}

export interface QuestionAppProps {
    readonly view: QuestionAppView | null;
    readonly sending: boolean;
    readonly refusal: string | null;
    /** The answer to the question shown, with its id — any question in the queue can be the one answered. */
    readonly onAnswer: (selections: string[][], notes: string[], id: string) => void;
    readonly onLater: () => void;
    /** Dismiss without an answer, with the notes written in the form (one per question) — they reach the agent. */
    readonly onDismiss: (notes: string[], id: string) => void;
    /** The question the person picked from the queue (null = none picked: main's choice is shown). */
    readonly picked?: string | null;
    /** The person picks another question from the queue. */
    readonly onPick?: (id: string) => void;
    /** The drafts the window holds, by question id — what the person typed; they win over main's. */
    readonly drafts?: QuestionDrafts;
    /** Every change to a question's draft. */
    readonly onDraft?: (id: string, draft: QuestionDraft) => void;
    /** The clock the age is read against; now by default (tests pass a fixed one). */
    readonly now?: number;
    /**
     * GENIE 1'S FILE DRAWER (the owner, 2026-10-19). Which of the files the question names are there in its workspace —
     * `null` = it could not be established, and every named file is offered (Genie 1 failed open the same way).
     */
    readonly existing?: ReadonlySet<string> | null;
    /** The file open beside the question, or why it cannot be shown. Absent/`null` = closed. */
    readonly drawer?: { readonly path: string; readonly text?: string; readonly line?: number | null; readonly error?: string } | null;
    readonly onOpenFile?: (ref: AskFileRef) => void;
    readonly onCloseFile?: () => void;
}

/** The extensions the drawer shows as prose (Genie 1's: what its Document plugin claimed, minus binary .docx). */
const PROSE = /\.(md|markdown)$/i;

/** The drawer's body: Markdown as prose (with Source to see the lines), anything else as code at the named line. */
function DrawerBody({ path, text, line }: { path: string; text: string; line: number | null }) {
    const [source, setSource] = useState(false);
    const prose = PROSE.test(path) && !source;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {PROSE.test(path) ? (
                <div className="flex shrink-0 justify-end px-3 py-1">
                    <button type="button" data-action="question-drawer-source" onClick={() => setSource((v) => !v)} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 text-[11px]">{source ? 'Read' : 'Source'}</button>
                </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
                {prose ? <ContentRenderer clipboardWriter={genieClipboardWriter} value={text} format="markdown" lineSpacing={1.6} className="text-[13px]" /> : <FileViewer filename={path} value={text} readOnly {...(line ? { line } : {})} theme="auto" />}
            </div>
        </div>
    );
}

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export function QuestionApp({ view, sending, refusal, onAnswer, onLater, onDismiss, picked = null, onPick, drafts, onDraft, now = Date.now(), existing = null, drawer = null, onOpenFile, onCloseFile }: QuestionAppProps) {
    // ESC IS LATER (Tynn #759; Genie 1's "PARK, never kill"): the question stays in Pending Questions with its draft;
    // Dismiss, which tells the agent, is never a key. Re-bound every render so it acts on the question now shown.
    useEffect(() => {
        if (!view) return;
        const onKey = (e: KeyboardEvent): void => {
            // Esc closes the file drawer first (Genie 1's), then is Later.
            const action = questionWindowAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: false }, { drawerOpen: drawer !== null });
            if (action === 'close-drawer') {
                e.preventDefault();
                onCloseFile?.();
            } else if (action === 'later') {
                e.preventDefault();
                onLater();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });
    if (!view) return <div data-question-window="empty" className="h-screen bg-[var(--bg-0)]" />;
    const queue = view.queue && view.queue.length > 0 ? view.queue : [view.item];
    const activeId = activeQuestion({ picked, shown: view.item.id, queue: queue.map((q) => q.id) });
    const item = queue.find((q) => q.id === activeId) ?? view.item;
    const parked = new Set(view.parked ?? []);
    // A draft written for an earlier revision of the question is not this form's: an updated question starts clean.
    const kept = drafts?.[item.id] ?? view.drafts?.[item.id];
    const draft = kept && (kept.revision ?? 0) === (item.revision ?? 0) ? kept : undefined;
    return (
        <div data-question-window={item.id} className="flex h-screen flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header style={DRAG} className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-4 py-3">
                <span className="text-[14px] font-semibold">{item.agentName ?? 'An agent'} asks you</span>
                {item.workspaceName ? <span data-question-workspace={item.workspaceId ?? ''} className="text-[12px] text-[var(--fg-3)]">{item.workspaceName}</span> : null}
                {item.at > 0 ? <time data-question-age="" dateTime={new Date(item.at).toISOString()} className="text-[12px] text-[var(--fg-4)]">{ageLabel(item.at, now)}</time> : null}
                {view.waiting > 0 ? <span data-question-waiting={view.waiting} className="ml-auto text-[11px] text-[var(--fg-3)]">{view.waiting} more after this</span> : null}
            </header>
            {queue.length > 1 ? (
                // THE QUEUE: every question asked, from every agent — pick any. Not draggable: these are buttons.
                <nav style={NO_DRAG} data-question-queue={queue.length} aria-label="Questions waiting for you" className="flex max-h-[30%] shrink-0 flex-col gap-1 overflow-y-auto border-b border-[var(--border-1)] px-3 py-2">
                    {queue.map((q) => {
                        const on = q.id === item.id;
                        return (
                            <button
                                key={q.id}
                                type="button"
                                data-question-queue-item={q.id}
                                aria-current={on ? 'true' : undefined}
                                onClick={() => onPick?.(q.id)}
                                className={`flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-[12px] ${on ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}
                            >
                                <span className="shrink-0 font-semibold">{q.agentName ?? 'An agent'}</span>
                                {q.workspaceName ? <span className="shrink-0 text-[var(--fg-3)]">{q.workspaceName}</span> : null}
                                <span className="min-w-0 flex-1 truncate">{q.title}</span>
                                {parked.has(q.id) ? <span data-question-parked="" className="shrink-0 text-[11px] text-[var(--fg-4)]">later</span> : null}
                                {q.at > 0 ? <time dateTime={new Date(q.at).toISOString()} className="shrink-0 text-[11px] text-[var(--fg-4)]">{ageLabel(q.at, now)}</time> : null}
                            </button>
                        );
                    })}
                </nav>
            ) : null}
            <div className="flex min-h-0 flex-1">
            <main style={NO_DRAG} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3">
                <QuestionFiles item={item} existing={existing} open={drawer?.path ?? null} {...(onOpenFile ? { onOpen: onOpenFile } : {})} />
                {/* Keyed by the question AND its revision: another question, or this one updated by its agent, is another form.
                    Its draft comes back from the window's drafts (by question id), so returning to it loses nothing. */}
                <QuestionForm
                    key={`${item.id}:${item.revision ?? 0}`}
                    item={item}
                    answering={sending ? item.id : null}
                    refusal={refusal}
                    cancelLabel="Later"
                    cancelKey="Esc"
                    onCancel={onLater}
                    onDismiss={(notes) => onDismiss(notes, item.id)}
                    onSubmit={(selections, notes) => onAnswer(selections, notes, item.id)}
                    {...(draft ? { initial: draft } : {})}
                    onDraft={(d) => onDraft?.(item.id, { ...d, revision: item.revision ?? 0 })}
                />
            </main>
            {/* GENIE 1'S FILE DRAWER: the file the question names, beside it (the window widens for it, question-drawer.ts). */}
            {drawer ? (
                <aside data-question-drawer={drawer.path} style={NO_DRAG} className="flex min-h-0 w-[520px] max-w-[60%] shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--bg-1)]">
                    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3 py-2 text-[12px]">
                        <span className="min-w-0 flex-1 truncate font-mono" title={drawer.path}>{drawer.path}</span>
                        <button type="button" data-action="question-drawer-close" onClick={() => onCloseFile?.()} title="Close (Esc)" className="rounded-md border border-[var(--border-1)] px-2 py-0.5">Close</button>
                    </div>
                    {drawer.error !== undefined ? (
                        <p data-question-drawer-error="" className="px-3 py-2 text-[12px] text-[var(--danger)]">{drawer.error}</p>
                    ) : drawer.text !== undefined ? (
                        <DrawerBody key={drawer.path} path={drawer.path} text={drawer.text} line={drawer.line ?? null} />
                    ) : (
                        <p className="px-3 py-2 text-[12px] text-[var(--fg-3)]">Opening…</p>
                    )}
                </aside>
            ) : null}
            </div>
        </div>
    );
}

/**
 * The files the question names (core/ask-file-refs.ts, Genie 1's): a chip for each one that is in its workspace, with the
 * line or section it pointed at; a file it names that is NOT there is said, never offered (a chip that opens nothing is
 * worse than none).
 */
function QuestionFiles({ item, existing, open, onOpen }: { item: DeckItem; existing: ReadonlySet<string> | null; open: string | null; onOpen?: (ref: AskFileRef) => void }) {
    const questions = item.answer.kind === 'form' ? item.answer.questions ?? [] : [];
    const refs = extractFileRefs(questions.map((q) => q.question).join('\n\n'));
    if (refs.length === 0) return null;
    const { present, missing } = splitByExistence(refs, existing);
    return (
        <div data-question-files="" className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
            {present.map((ref) => (
                <button key={ref.path} type="button" data-question-file={ref.path} aria-pressed={open === ref.path} onClick={() => onOpen?.(ref)} title={ref.path}
                    className={`rounded-md border px-2 py-0.5 font-mono ${open === ref.path ? 'border-[var(--primary)] text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}>
                    {ref.name}{ref.line ? `:${ref.line}` : ''}{ref.section ? ` ${ref.section}` : ''}
                </button>
            ))}
            {missing.map((ref) => (
                <span key={ref.path} data-question-file-missing={ref.path} className="text-[var(--fg-4)]">not found: <span className="font-mono">{ref.path}</span></span>
            ))}
        </div>
    );
}

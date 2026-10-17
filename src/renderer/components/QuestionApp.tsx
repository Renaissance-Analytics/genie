import { useEffect, type CSSProperties } from 'react';
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
}

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export function QuestionApp({ view, sending, refusal, onAnswer, onLater, onDismiss, picked = null, onPick, drafts, onDraft, now = Date.now() }: QuestionAppProps) {
    // ESC IS LATER (Tynn #759; Genie 1's "PARK, never kill"): the question stays in Pending Questions with its draft;
    // Dismiss, which tells the agent, is never a key. Re-bound every render so it acts on the question now shown.
    useEffect(() => {
        if (!view) return;
        const onKey = (e: KeyboardEvent): void => {
            const action = questionWindowAction({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: false }, { drawerOpen: false });
            if (action === 'later') {
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
            <main style={NO_DRAG} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
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
        </div>
    );
}

import type { CSSProperties } from 'react';
import { ageLabel, type DeckItem } from '../../core/deck.js';
import { QuestionForm } from './QuestionForm.js';

/**
 * THE FORCETHEQUESTION WINDOW'S CONTENT: who asks (and from which workspace — its NAME, as the rail says it, never its id),
 * how long ago, how many more wait, the questions each with its own note, Answer, Later or Dismiss (put aside without an
 * answer; the agent is told — the Deck offers the same). Frameless, so the header is the handle the window is dragged by. A refused answer is said
 * BESIDE the Answer button, where it was given — not at the top of a window the person has scrolled away from (the owner,
 * 2026-10-14: "I click the answer button but nothing happens"), and never only in a log.
 */
export interface QuestionAppProps {
    readonly view: { item: DeckItem; waiting: number } | null;
    readonly sending: boolean;
    readonly refusal: string | null;
    readonly onAnswer: (selections: string[][], notes: string[]) => void;
    readonly onLater: () => void;
    /** Dismiss without an answer, with the notes written in the form (one per question) — they reach the agent. */
    readonly onDismiss: (notes: string[]) => void;
    /** The clock the age is read against; now by default (tests pass a fixed one). */
    readonly now?: number;
}

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export function QuestionApp({ view, sending, refusal, onAnswer, onLater, onDismiss, now = Date.now() }: QuestionAppProps) {
    if (!view) return <div data-question-window="empty" className="h-screen bg-[var(--bg-0)]" />;
    const { item, waiting } = view;
    return (
        <div data-question-window={item.id} className="flex h-screen flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header style={DRAG} className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-4 py-3">
                <span className="text-[14px] font-semibold">{item.agentName ?? 'An agent'} asks you</span>
                {item.workspaceName ? <span data-question-workspace={item.workspaceId ?? ''} className="text-[12px] text-[var(--fg-3)]">{item.workspaceName}</span> : null}
                {item.at > 0 ? <time data-question-age="" dateTime={new Date(item.at).toISOString()} className="text-[12px] text-[var(--fg-4)]">{ageLabel(item.at, now)}</time> : null}
                {waiting > 0 ? <span data-question-waiting={waiting} className="ml-auto text-[11px] text-[var(--fg-3)]">{waiting} more after this</span> : null}
            </header>
            <main style={NO_DRAG} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {/* Keyed by the question AND its revision: the next question, or this one updated by its agent, starts a clean draft. */}
                <QuestionForm key={`${item.id}:${item.revision ?? 0}`} item={item} answering={sending ? item.id : null} refusal={refusal} cancelLabel="Later" onCancel={onLater} onDismiss={onDismiss} onSubmit={onAnswer} />
            </main>
        </div>
    );
}

import type { CSSProperties } from 'react';
import type { DeckItem } from '../../core/deck.js';
import { QuestionForm } from './QuestionForm.js';

/**
 * THE FORCETHEQUESTION WINDOW'S CONTENT: who asks (and from which workspace), how many more wait, the questions each with
 * its own note, Answer or Later. Frameless, so the header is the handle the window is dragged by. A refused answer is said
 * BESIDE the Answer button, where it was given — not at the top of a window the person has scrolled away from (the owner,
 * 2026-10-14: "I click the answer button but nothing happens"), and never only in a log.
 */
export interface QuestionAppProps {
    readonly view: { item: DeckItem; waiting: number } | null;
    readonly sending: boolean;
    readonly refusal: string | null;
    readonly onAnswer: (selections: string[][], notes: string[]) => void;
    readonly onLater: () => void;
}

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

export function QuestionApp({ view, sending, refusal, onAnswer, onLater }: QuestionAppProps) {
    if (!view) return <div data-question-window="empty" className="h-screen bg-[var(--bg-0)]" />;
    const { item, waiting } = view;
    return (
        <div data-question-window={item.id} className="flex h-screen flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header style={DRAG} className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-4 py-3">
                <span className="text-[14px] font-semibold">{item.agentName ?? 'An agent'} asks you</span>
                {item.workspaceId ? <span data-question-workspace={item.workspaceId} className="font-mono text-[11px] text-[var(--fg-4)]">{item.workspaceId}</span> : null}
                {waiting > 0 ? <span data-question-waiting={waiting} className="ml-auto text-[11px] text-[var(--fg-3)]">{waiting} more after this</span> : null}
            </header>
            <main style={NO_DRAG} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {/* Keyed by the question, so the next question starts with a clean draft. */}
                <QuestionForm key={item.id} item={item} answering={sending ? item.id : null} refusal={refusal} cancelLabel="Later" onCancel={onLater} onSubmit={onAnswer} />
            </main>
        </div>
    );
}

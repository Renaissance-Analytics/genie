import type { DeckItem } from '../core/deck.js';
import { nextQuestion, waitingBehind } from '../core/question-queue.js';

/**
 * THE FORCETHEQUESTION WINDOW — the logic (the Electron window is `question-window-electron.ts`, behind a port so this is
 * tested without one). The owner, 2026-10-14: "the FTQ window is a window that opens on top of all other windows to
 * ForceTheQuestion". Genie 1's rules, carried over:
 *
 * - ONE shared window. A question arriving opens it; while it is open, it shows the oldest question still asked and
 *   never swaps one under the person answering it.
 * - Answering sends the answer and shows the next; with none left the window closes.
 * - Later, or closing the window, PARKS the question: it stays pending in Pending Questions (the Deck) and the agent
 *   keeps waiting; the window does not reopen for it this session.
 * - Every change to the questions (asked, answered elsewhere) re-checks: a question answered in Pending Questions
 *   leaves the window too — the two are one workflow.
 * - Dismiss (beside Later) puts the question aside for good, WITHOUT an answer: it leaves Pending Questions too, its
 *   agent is told, and the next is shown. A question its agent withdrew leaves the same way; one its agent updated stays
 *   on screen with the new content (the view carries its revision, so the form starts a clean draft).
 */
export interface QuestionView {
    readonly item: DeckItem;
    /** How many more wait behind it. */
    readonly waiting: number;
}

export interface QuestionWindowPort {
    show(view: QuestionView): void;
    close(): void;
}

export interface QuestionWindowDeps {
    /** The Deck's items — the same list Pending Questions shows. */
    readonly items: () => readonly DeckItem[];
    /** Opens the window; the controller calls `show` on it right after. `onClosed` fires on ANY close (ours or the person's). */
    readonly open: (onClosed: () => void) => QuestionWindowPort;
    /** Sends an answer the way Pending Questions does (`deck.answerForm`): labels and one note per question. A refusal throws, with the reason. */
    readonly answer: (item: DeckItem, selections: string[][], notes: string[]) => Promise<void>;
    /** Dismisses it the way Pending Questions does (`deck.dismiss`): removed, and its agent mailed. A refusal throws. */
    readonly dismiss: (item: DeckItem) => Promise<void>;
}

export class QuestionWindow {
    readonly #deps: QuestionWindowDeps;
    readonly #dismissed = new Set<string>();
    #window: QuestionWindowPort | null = null;
    #current: string | null = null;
    #closingOurselves = false;

    constructor(deps: QuestionWindowDeps) {
        this.#deps = deps;
    }

    /** Call on every change to the questions, and once at boot. */
    changed(): void {
        const items = this.#deps.items();
        const next = nextQuestion(items, this.#dismissed, this.#current);
        if (next === null) {
            this.#current = null;
            if (this.#window) {
                this.#closingOurselves = true;
                this.#window.close();
            }
            return;
        }
        const view: QuestionView = { item: next, waiting: waitingBehind(items, this.#dismissed, next.id) };
        if (!this.#window) this.#window = this.#deps.open(() => this.#closed());
        this.#current = next.id;
        this.#window.show(view);
    }

    /** The person answered the shown question. A refusal comes back as the reason; the question stays shown. */
    async answer(selections: string[][], notes: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
        const item = this.#deps.items().find((i) => i.id === this.#current);
        if (!item) { this.changed(); return { ok: false, reason: 'that question was already answered' }; }
        try {
            await this.#deps.answer(item, selections, notes);
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        this.#current = null;
        this.changed();
        return { ok: true };
    }

    /** Dismiss: the shown question is removed WITHOUT an answer (its agent is told) and the next is shown, or the window closes. */
    async dismiss(): Promise<{ ok: true } | { ok: false; reason: string }> {
        const item = this.#deps.items().find((i) => i.id === this.#current);
        if (!item) { this.changed(); return { ok: false, reason: 'that question was already answered' }; }
        try {
            await this.#deps.dismiss(item);
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        this.#current = null;
        this.changed();
        return { ok: true };
    }

    /** Later: park the shown question (it stays in Pending Questions) and show the next, or close. */
    later(): void {
        if (this.#current !== null) this.#dismissed.add(this.#current);
        this.#current = null;
        this.changed();
    }

    /** Is a question on screen now — for tests and the tray. */
    get showing(): string | null {
        return this.#window ? this.#current : null;
    }

    #closed(): void {
        const ours = this.#closingOurselves;
        this.#closingOurselves = false;
        this.#window = null;
        // The person closed it: the widest Later — every question shown or waiting is parked for this session.
        if (!ours) for (const item of this.#deps.items()) this.#dismissed.add(item.id);
        this.#current = null;
    }
}

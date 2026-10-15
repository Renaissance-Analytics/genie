import type { DeckItem } from '../core/deck.js';
import { nextQuestion, waitingBehind } from '../core/question-queue.js';

/**
 * THE FORCETHEQUESTION WINDOW — the logic (the Electron window is `question-window-electron.ts`, behind a port so this is
 * tested without one). The owner, 2026-10-14: "the FTQ window is a window that opens on top of all other windows to
 * ForceTheQuestion". Genie 1's rules, carried over:
 *
 * - Only LIVE questions take the window (core/question-queue.ts): a stale one stays in the Deck, marked, with Dismiss.
 * - ONE shared window. A question arriving opens it; while it is open, it shows the oldest question still asked and
 *   never swaps one under the person answering it.
 * - Answering sends the answer and shows the next; with none left the window closes.
 * - Later, or closing the window, PARKS the question THAT WAS SHOWN: it stays pending in Pending Questions (the Deck)
 *   and the agent keeps waiting; the window does not reopen for it this session. Only that one: a question queued
 *   behind it, which the person never saw, still gets the window — it reopens for the next one at once. A question the
 *   person has not seen is never only in the Deck (the owner, 2026-10-15: "I got a toast but no FTQ popup; I see the
 *   question in the Deck" — closing had parked every question the window held, seen or not).
 * - A question arriving at ANY moment ends up shown, including while a window is closing: a window we are closing is
 *   let go at once, and its late `closed` is not taken as the person closing the window that replaced it.
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
    /** Dismisses it the way Pending Questions does (`deck.dismiss`): removed, and its agent mailed with the notes. A refusal throws. */
    readonly dismiss: (item: DeckItem, notes: string[]) => Promise<void>;
}

export class QuestionWindow {
    readonly #deps: QuestionWindowDeps;
    readonly #dismissed = new Set<string>();
    /** The window on screen. One WE are closing is not it any more: it is let go the moment we ask it to close. */
    #window: QuestionWindowPort | null = null;
    #current: string | null = null;

    constructor(deps: QuestionWindowDeps) {
        this.#deps = deps;
    }

    /** Call on every change to the questions, and once at boot. */
    changed(): void {
        const items = this.#deps.items();
        const next = nextQuestion(items, this.#dismissed, this.#current);
        if (next === null) {
            this.#current = null;
            const closing = this.#window;
            // Let go FIRST: a question arriving before this window's `closed` opens a new one instead of being shown in
            // the dying one (and then forgotten when `closed` cleared what was "current").
            this.#window = null;
            closing?.close();
            return;
        }
        const view: QuestionView = { item: next, waiting: waitingBehind(items, this.#dismissed, next.id) };
        if (!this.#window) {
            let port: QuestionWindowPort | null = null;
            port = this.#deps.open(() => this.#closed(port));
            this.#window = port;
        }
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

    /**
     * Dismiss: the shown question is removed WITHOUT an answer (its agent is told, with the person's notes — one per
     * question) and the next is shown, or the window closes.
     */
    async dismiss(notes: string[] = []): Promise<{ ok: true } | { ok: false; reason: string }> {
        const item = this.#deps.items().find((i) => i.id === this.#current);
        if (!item) { this.changed(); return { ok: false, reason: 'that question was already answered' }; }
        try {
            await this.#deps.dismiss(item, notes);
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

    #closed(port: QuestionWindowPort | null): void {
        // A window we closed was let go already: its `closed` says nothing about the window on screen now.
        if (port === null || port !== this.#window) return;
        // The PERSON closed it: Later for the question they were shown — that one only. The ones queued behind it were
        // never seen, so the window comes back for the next at once.
        this.#window = null;
        if (this.#current !== null) this.#dismissed.add(this.#current);
        this.#current = null;
        this.changed();
    }
}

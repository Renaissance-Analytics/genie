import type { DeckItem } from '../core/deck.js';
import { dropDraft, pruneDrafts, putDraft, type QuestionDraft, type QuestionDrafts } from '../core/question-drafts.js';
import { isWindowQuestion, nextQuestion, waitingBehind, windowQueue } from '../core/question-queue.js';

/**
 * THE FORCETHEQUESTION WINDOW — the logic (the Electron window is `question-window-electron.ts`, behind a port so this is
 * tested without one). The owner, 2026-10-14: "the FTQ window is a window that opens on top of all other windows to
 * ForceTheQuestion". And 2026-10-15: "The FTQ window should have its own queue so I can answer any and all questions of
 * all agents just like genie 1 had … FTQ does not care what screen or app I have open. If DnD is not turned on then FTQ
 * always opens for every agent." Genie 1's rules (genie main/ask/force-question.ts, renderer/pages/ask.tsx), carried over:
 *
 * - Only LIVE questions take the window (core/question-queue.ts): a stale one stays in the Deck, marked, with Dismiss.
 * - ONE shared window holding ITS OWN QUEUE: every live question from every agent, in every workspace — the view
 *   carries all of them, so a second agent's question is in front of the person, not a count in a corner while the
 *   question is only in the Deck. The person answers any of them, in any order (`select`, and an id on answer/dismiss).
 * - A question arriving opens the window — whichever agent asked, whatever screen or app the person has open. Nothing
 *   here knows which agent is on screen, and nothing may. Unless DO NOT DISTURB is on: then no window opens, the question
 *   waits in Pending Questions (the Deck), and turning DND off does not throw the backlog at the person (Genie 1's DND
 *   parked to the inbox the same way).
 * - An arrival while the window is up is LISTED in its queue; the question the person is answering stays where it is,
 *   and what they typed stays with the question it was typed for (drafts, keyed by question id — kept here as well, so a
 *   window closed and reopened loses nothing). The window is shown without taking focus (question-window-electron.ts).
 * - Answering sends the answer; with none left the window closes.
 * - Later, or closing the window, PARKS the question THAT WAS SHOWN: it stays in Pending Questions and in the queue (the
 *   person can still pick it), the agent keeps waiting, and it does not bring the window back on its own. Only that one:
 *   a question queued behind it, which the person never saw, still gets the window — it reopens for the next at once.
 * - Its agent ASKING IT AGAIN is a new ask (the item's `asks` count goes up — attention-store.ts): the park is lifted and
 *   the window opens for it — unless Do Not Disturb is on — with the draft the person had started still in it. A park
 *   holds for the ask it was made on, never for the agent's later asks.
 * - A question arriving at ANY moment ends up shown, including while a window is closing: a window we are closing is
 *   let go at once, and its late `closed` is not taken as the person closing the window that replaced it.
 * - Every change to the questions (asked, answered elsewhere) re-checks: a question answered in Pending Questions
 *   leaves the window too — the two are one workflow.
 * - Dismiss (beside Later) puts the question aside for good, WITHOUT an answer: it leaves Pending Questions too, its
 *   agent is told, and the next is shown. A question its agent withdrew leaves the same way; one its agent updated stays
 *   on screen with the new content (the view carries its revision, so the form starts a clean draft).
 */
export interface QuestionView {
    /** The question selected: the one the window shows the form of. */
    readonly item: DeckItem;
    /** How many more wait behind it (not counting ones put off). */
    readonly waiting: number;
    /** THE WINDOW'S QUEUE: every live question from every agent, oldest first, the selected one included. */
    readonly queue: readonly DeckItem[];
    /** Which of the queue were put off (Later, or a closed window): still listed, still answerable. */
    readonly parked: readonly string[];
    /** The part-written answers main keeps, by question id (only questions still in the queue). */
    readonly drafts: QuestionDrafts;
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
    /** Do Not Disturb (Settings → General, `do_not_disturb`), read at every change. Absent = off. */
    readonly dnd?: () => boolean;
}

type Outcome = { ok: true } | { ok: false; reason: string };

export class QuestionWindow {
    readonly #deps: QuestionWindowDeps;
    /**
     * Put off this session — Later, a closed window, or asked while Do Not Disturb was on — by question id, with the
     * item's `asks` count at the time: the park holds only while that count is unchanged (a re-ask lifts it).
     */
    readonly #parkedAt = new Map<string, number>();
    /** The window on screen. One WE are closing is not it any more: it is let go the moment we ask it to close. */
    #window: QuestionWindowPort | null = null;
    #current: string | null = null;
    #drafts: QuestionDrafts = {};

    constructor(deps: QuestionWindowDeps) {
        this.#deps = deps;
    }

    /** Call on every change to the questions, and once at boot. */
    changed(): void {
        const items = this.#deps.items();
        const queue = windowQueue(items);
        this.#drafts = pruneDrafts(this.#drafts, queue.map((i) => i.id));
        // A park made on an earlier ask is lifted: its agent asked again (or the question is gone).
        for (const [id, asks] of this.#parkedAt) {
            const item = queue.find((i) => i.id === id);
            if (!item || (item.asks ?? 0) !== asks) this.#parkedAt.delete(id);
        }
        // DO NOT DISTURB: no window opens. What arrives meanwhile is put off — it waits in Pending Questions and does not
        // come at the person when DND is turned off. A window the person already has open keeps working.
        if (!this.#window && this.#deps.dnd?.() === true) {
            for (const item of queue) this.#park(item);
            this.#current = null;
            return;
        }
        const parked = new Set(this.#parkedAt.keys());
        const next = nextQuestion(items, parked, this.#current);
        if (next === null) {
            this.#current = null;
            const closing = this.#window;
            // Let go FIRST: a question arriving before this window's `closed` opens a new one instead of being shown in
            // the dying one (and then forgotten when `closed` cleared what was "current").
            this.#window = null;
            closing?.close();
            return;
        }
        const view: QuestionView = {
            item: next,
            waiting: waitingBehind(items, parked, next.id),
            queue,
            parked: queue.filter((i) => parked.has(i.id)).map((i) => i.id),
            drafts: this.#drafts,
        };
        if (!this.#window) {
            let port: QuestionWindowPort | null = null;
            port = this.#deps.open(() => this.#closed(port));
            this.#window = port;
        }
        this.#current = next.id;
        this.#window.show(view);
    }

    /** The person picked a question from the window's queue — any of them, parked ones included. */
    select(id: string): void {
        if (!this.#deps.items().some((i) => i.id === id && isWindowQuestion(i))) { this.changed(); return; }
        this.#current = id;
        this.changed();
    }

    /**
     * What the person has written so far in one question's form. Kept here so a window closed (or a question parked)
     * loses nothing; never pushed back while they type — the window's own copy is what they are typing into.
     */
    draft(id: string, draft: QuestionDraft): void {
        if (!this.#deps.items().some((i) => i.id === id && isWindowQuestion(i))) return;
        this.#drafts = putDraft(this.#drafts, id, draft);
    }

    /** The person answered a question — the one named, or the one shown. A refusal comes back as the reason; it stays. */
    async answer(selections: string[][], notes: string[], id?: string): Promise<Outcome> {
        return this.#settle(id, (item) => this.#deps.answer(item, selections, notes));
    }

    /**
     * Dismiss: the question (named, or shown) is removed WITHOUT an answer (its agent is told, with the person's notes —
     * one per question) and the next is shown, or the window closes.
     */
    async dismiss(notes: string[] = [], id?: string): Promise<Outcome> {
        return this.#settle(id, (item) => this.#deps.dismiss(item, notes));
    }

    /** Later: park the shown question (it stays in Pending Questions and in the queue) and show the next, or close. */
    later(): void {
        this.#parkCurrent();
        this.#current = null;
        this.changed();
    }

    /** Is a question on screen now — for tests and the tray. */
    get showing(): string | null {
        return this.#window ? this.#current : null;
    }

    async #settle(id: string | undefined, act: (item: DeckItem) => Promise<void>): Promise<Outcome> {
        const target = id ?? this.#current;
        const item = this.#deps.items().find((i) => i.id === target);
        if (!item) { this.changed(); return { ok: false, reason: 'that question was already answered' }; }
        try {
            await act(item);
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        this.#drafts = dropDraft(this.#drafts, item.id);
        // Answering ANOTHER question in the queue leaves the one the person is on where it is.
        if (this.#current === item.id) this.#current = null;
        this.changed();
        return { ok: true };
    }

    #closed(port: QuestionWindowPort | null): void {
        // A window we closed was let go already: its `closed` says nothing about the window on screen now.
        if (port === null || port !== this.#window) return;
        // The PERSON closed it: Later for the question they were shown — that one only. The ones queued behind it were
        // never seen, so the window comes back for the next at once.
        this.#window = null;
        this.#parkCurrent();
        this.#current = null;
        this.changed();
    }

    #parkCurrent(): void {
        const item = this.#current === null ? undefined : this.#deps.items().find((i) => i.id === this.#current);
        if (item) this.#park(item);
    }

    #park(item: DeckItem): void {
        this.#parkedAt.set(item.id, item.asks ?? 0);
    }
}

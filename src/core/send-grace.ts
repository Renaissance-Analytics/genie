import type { ChatDraft } from './chat-drafts.js';
import type { DraftHandle } from './plan-pill.js';

/**
 * UNDO SEND (Tynn #745, client onboarding call 00:31: "Once it's sent, it's sent. I don't have a way to back out").
 *
 * A Claude run takes a message mid-turn at once (`AgentSession.deliver` hands it to the provider, which reads it at its
 * next step), so once the host has it there is nothing left to take back. The window therefore holds a message typed to
 * a BUSY agent for `UNDO_SEND_MS` before it sends it, with Undo (the words go back into the composer) and Send now. An
 * idle agent's message starts a turn the person is waiting for, and goes at once.
 *
 * ESC UNSENDS (Tynn #1029; the owner: "the esc key should unsend while it's in the buffer time"). A bare Esc in the chat
 * takes back that chat's newest held message (`unsendOnEscape`). The window is the ONLY hold: nothing reaches the host
 * until it ends, so unsending cancels delivery at its source and no other window or client ever saw the message. A
 * message with files is held too, with the composer's whole draft (`HeldSend.draft`) and its picks (`attachments`), so it
 * comes back files and all; its stored files are released only once it really goes.
 *
 * PURE: timers and the clock are injected.
 */
export const UNDO_SEND_MS = 5_000;

export interface HeldSend {
    readonly id: string;
    /** The chat it was typed in: the agent it goes to. */
    readonly chat: string;
    readonly text: string;
    /** When it goes on its own (epoch ms). */
    readonly until: number;
    /** It has gone to the host and the answer is not back: drawn, with nothing left to undo. */
    readonly sending: boolean;
    /** The composer's draft as it was sent (text, pills, attachments): what an unsend puts back. Absent: the text alone. */
    readonly draft?: ChatDraft | null | undefined;
    /** The files picked with it (react-fancy `PromptAttachment`s): what goes when the window ends. */
    readonly attachments?: readonly HeldFile[] | undefined;
}

/** One file held with a message: react-fancy's `PromptAttachment`, by shape. */
export interface HeldFile {
    readonly id: string;
    readonly name: string;
    readonly bytes?: number;
    readonly type?: string;
    readonly file?: File;
    readonly ref?: string;
}

/** Whether this send is held for the grace window: a busy agent's, files and all (Tynn #1029). */
export function holdsSend(o: { busy: boolean; files: number }): boolean {
    return o.busy;
}

export interface SendGraceOptions {
    ms?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
}

export class SendGrace {
    readonly #send: (h: HeldSend) => void | Promise<unknown>;
    readonly #ms: number;
    readonly #now: () => number;
    readonly #setTimer: (fn: () => void, ms: number) => unknown;
    readonly #clearTimer: (t: unknown) => void;
    #items: HeldSend[] = [];
    readonly #timers = new Map<string, unknown>();
    readonly #listeners = new Set<() => void>();
    #seq = 0;

    constructor(send: (h: HeldSend) => void | Promise<unknown>, options: SendGraceOptions = {}) {
        this.#send = send;
        this.#ms = options.ms ?? UNDO_SEND_MS;
        this.#now = options.now ?? Date.now;
        this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.#clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    }

    hold(chat: string, text: string, more: { draft?: ChatDraft | null; attachments?: readonly HeldFile[] } = {}): HeldSend {
        const h: HeldSend = {
            id: `held-${++this.#seq}`, chat, text, until: this.#now() + this.#ms, sending: false,
            ...(more.draft ? { draft: more.draft } : {}),
            ...(more.attachments && more.attachments.length > 0 ? { attachments: more.attachments } : {}),
        };
        this.#items = [...this.#items, h];
        this.#timers.set(h.id, this.#setTimer(() => this.#go(h.id), this.#ms));
        this.#changed();
        return h;
    }

    /** Take it back before it went: answers what was held, or `null` when it has already gone. */
    undo(id: string): HeldSend | null {
        const h = this.#items.find((x) => x.id === id && !x.sending);
        if (!h) return null;
        this.#stopTimer(id);
        this.#items = this.#items.filter((x) => x.id !== id);
        this.#changed();
        return h;
    }

    /** Esc (Tynn #1029): take back the NEWEST message of this chat still waiting, or `null` when none is. */
    unsendLatest(chat: string): HeldSend | null {
        const h = this.#items.filter((x) => x.chat === chat && !x.sending).at(-1);
        return h ? this.undo(h.id) : null;
    }

    /** Send it now, without waiting out the window. `false` when it is not held. */
    sendNow(id: string): boolean {
        if (!this.#items.some((x) => x.id === id && !x.sending)) return false;
        this.#go(id);
        return true;
    }

    /** Send everything still held, in order (the chat is going away: nothing typed is lost). */
    flush(): void {
        for (const h of this.#items.filter((x) => !x.sending)) this.#go(h.id);
    }

    held(chat?: string): readonly HeldSend[] {
        return chat === undefined ? this.#items : this.#items.filter((x) => x.chat === chat);
    }

    subscribe(fn: () => void): () => void {
        this.#listeners.add(fn);
        return () => { this.#listeners.delete(fn); };
    }

    #go(id: string): void {
        const h = this.#items.find((x) => x.id === id && !x.sending);
        if (!h) return;
        this.#stopTimer(id);
        const going: HeldSend = { ...h, sending: true };
        this.#items = this.#items.map((x) => (x.id === id ? going : x));
        this.#changed();
        // Drawn as Sending until the host answers, so the thread's own copy of the message replaces it, with no gap.
        const done = (): void => {
            this.#items = this.#items.filter((x) => x.id !== id);
            this.#changed();
        };
        let result: void | Promise<unknown>;
        try {
            result = this.#send(going);
        } catch {
            done();
            return;
        }
        if (result && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(done, done);
        else done();
    }

    #stopTimer(id: string): void {
        const t = this.#timers.get(id);
        if (t !== undefined) this.#clearTimer(t);
        this.#timers.delete(id);
    }

    #changed(): void {
        for (const fn of this.#listeners) fn();
    }
}

/** A key press, as React or the DOM hands it over. */
export interface UnsendKey {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
    readonly defaultPrevented: boolean;
    readonly isComposing?: boolean | undefined;
    /** React keeps the IME state on the native event. */
    readonly nativeEvent?: { readonly isComposing?: boolean } | undefined;
    preventDefault(): void;
    stopPropagation(): void;
}

/**
 * ESC UNSENDS (Tynn #1029). A bare Esc in a chat holding a message still in its window takes the newest one back, hands
 * it to `putBack`, and consumes the key. Anything else (a modifier, an IME composition, an Esc something inside already
 * handled, such as the composer closing its command menu, a chat with nothing waiting, a message already Sending) is
 * left alone, so Esc keeps its normal meaning: in the Agent view, blur the field, then the Inspector, then the Dashboard.
 */
export function unsendOnEscape(e: UnsendKey, grace: Pick<SendGrace, 'unsendLatest'>, chat: string | null, putBack: (h: HeldSend) => void): boolean {
    if (e.key !== 'Escape' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || e.isComposing === true || e.nativeEvent?.isComposing === true || chat === null) return false;
    const h = grace.unsendLatest(chat);
    if (!h) return false;
    e.preventDefault();
    e.stopPropagation();
    putBack(h);
    return true;
}

/**
 * The composer's draft with the undone message back in it, ahead of anything typed since: its words, and (a whole draft,
 * Tynn #1029) its pills and attachments before the ones added since.
 */
export function draftWithUndone(current: ChatDraft | null, undone: string | ChatDraft): ChatDraft {
    const base = current ?? { v: 1 as const, text: '', pills: [], attachments: [] };
    const back: Pick<ChatDraft, 'text' | 'pills' | 'attachments'> = typeof undone === 'string' ? { text: undone, pills: [], attachments: [] } : undone;
    return {
        ...base,
        text: base.text.trim() === '' ? back.text : back.text.trim() === '' ? base.text : `${back.text}\n${base.text}`,
        pills: [...back.pills, ...base.pills.filter((p) => !back.pills.some((q) => q.id === p.id))],
        attachments: [...back.attachments, ...base.attachments.filter((a) => !back.attachments.some((b) => b.id === a.id))],
    };
}

/**
 * Put an undone (or refused) message back in its chat's composer (its words, or its whole draft), ahead of what was typed since, and in its kept draft. The
 * caret moves only when `focus` — the person's own Undo click; a send refused after the window never takes it (genie#1235).
 */
export function putBackUndone(
    handles: ReadonlyMap<string, DraftHandle>,
    chat: string,
    undone: string | ChatDraft,
    focus: boolean,
    keep: { initial: (chat: string) => ChatDraft | null; change: (chat: string, draft: ChatDraft) => void } | null,
): ChatDraft {
    const handle = handles.get(chat);
    const next = draftWithUndone(handle?.getDraft() ?? keep?.initial(chat) ?? null, undone);
    handle?.setDraft(next, { focus });
    keep?.change(chat, next);
    return next;
}

import type { ChatDraft } from './chat-drafts.js';
import type { DraftHandle } from './plan-pill.js';

/**
 * UNDO SEND (Tynn #745, LiftPoint onboarding 00:31: "Once it's sent, it's sent. I don't have a way to back out").
 *
 * A Claude run takes a message mid-turn at once (`AgentSession.deliver` hands it to the provider, which reads it at its
 * next step), so once the host has it there is nothing left to take back. The window therefore holds a message typed to
 * a BUSY agent for `UNDO_SEND_MS` before it sends it, with Undo (the words go back into the composer) and Send now. An
 * idle agent's message starts a turn the person is waiting for, and goes at once; so does one with files, whose bytes
 * the composer's kept draft owns until the send.
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
}

/** Whether this send is held for the grace window: a busy agent, and text only. */
export function holdsSend(o: { busy: boolean; files: number }): boolean {
    return o.busy && o.files === 0;
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

    hold(chat: string, text: string): HeldSend {
        const h: HeldSend = { id: `held-${++this.#seq}`, chat, text, until: this.#now() + this.#ms, sending: false };
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

/** The composer's draft with the undone words back in it, ahead of anything typed since. */
export function draftWithUndone(current: ChatDraft | null, text: string): ChatDraft {
    const base = current ?? { v: 1 as const, text: '', pills: [], attachments: [] };
    return { ...base, text: base.text.trim() === '' ? text : `${text}\n${base.text}` };
}

/**
 * Put undone (or refused) words back in their chat's composer, ahead of what was typed since, and in its kept draft. The
 * caret moves only when `focus` — the person's own Undo click; a send refused after the window never takes it (genie#1235).
 */
export function putBackUndone(
    handles: ReadonlyMap<string, DraftHandle>,
    chat: string,
    text: string,
    focus: boolean,
    keep: { initial: (chat: string) => ChatDraft | null; change: (chat: string, draft: ChatDraft) => void } | null,
): ChatDraft {
    const handle = handles.get(chat);
    const next = draftWithUndone(handle?.getDraft() ?? keep?.initial(chat) ?? null, text);
    handle?.setDraft(next, { focus });
    keep?.change(chat, next);
    return next;
}

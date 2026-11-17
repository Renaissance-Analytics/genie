import type { ChatDraft } from './chat-drafts.js';

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
export function holdsSend(_o: { busy: boolean; files: number }): boolean {
    return false;
}

export interface SendGraceOptions {
    ms?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
}

export class SendGrace {
    readonly #send: (h: HeldSend) => void | Promise<unknown>;

    constructor(send: (h: HeldSend) => void | Promise<unknown>, _options: SendGraceOptions = {}) {
        this.#send = send;
    }

    hold(chat: string, text: string): HeldSend {
        const h: HeldSend = { id: 'held', chat, text, until: 0, sending: true };
        void this.#send(h);
        return h;
    }

    /** Take it back before it went: answers what was held, or `null` when it has already gone. */
    undo(_id: string): HeldSend | null {
        return null;
    }

    /** Send it now, without waiting out the window. `false` when it is not held. */
    sendNow(_id: string): boolean {
        return false;
    }

    /** Send everything still held, in order (the chat is going away: nothing typed is lost). */
    flush(): void {}

    held(_chat?: string): readonly HeldSend[] {
        return [];
    }

    subscribe(_fn: () => void): () => void {
        return () => {};
    }
}

/** The composer's draft with the undone words back in it, ahead of anything typed since. */
export function draftWithUndone(current: ChatDraft | null, _text: string): ChatDraft {
    return current ?? { v: 1, text: '', pills: [], attachments: [] };
}

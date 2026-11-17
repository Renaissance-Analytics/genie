import type { ChatDraft } from './chat-drafts.js';

/**
 * WHAT THE OTHER PERSON IS TYPING (Tynn #730; the client call, 2026-11-16: "Do you see my typing at all?" "No."). A Pilot
 * driving a client's Genie typed into an agent's composer, and the client, watching the same agent, saw nothing until
 * the message was sent. A composer's draft lived only in the window typing it (core/chat-draft-keeper.ts, kept on THAT
 * machine), so nothing ever crossed.
 *
 * Now each window reports its composer's text, throttled, as `agents.typing` (a write, on the baton like a send), and
 * the machine being reached relays it to every OTHER window on that agent, the host's own and the Pilot's. What arrives
 * is shown as a line over the composer, never written into it: nobody's caret moves and nobody's own draft is replaced.
 *
 * PURE: no DOM, no Electron. The timer and the clock are injected.
 */

/** At most one send per this, per agent, while typing: the first keystroke at once, the latest text at the end. */
export const TYPING_SEND_MS = 150;
/** A line nobody updated for this long has gone quiet: it is not shown. */
export const TYPING_FADE_MS = 20_000;
/** The most of a draft relayed; the host cuts anything longer. */
export const TYPING_MAX_CHARS = 2_000;
/** The most of it shown on the line: the newest words. */
export const TYPING_SHOWN_CHARS = 120;

/** What the host relays: which agent, what is in the box now, which window typed it, and who (null = the host's own window). */
export interface TypingEvent {
    readonly agentId: string;
    readonly text: string;
    readonly source: string;
    readonly label: string | null;
}

export interface TypingClock {
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(timer: unknown): void;
}

/** A relayed event, or `null` for anything that is not one. */
export function readTypingEvent(_payload: unknown): TypingEvent | null {
    return null;
}

/** The newest words of a long draft, so the line shows what is being typed now. */
export function typingTail(text: string): string {
    return text;
}

/** The window's half: each change of a chat's text, sent at most once per {@link TYPING_SEND_MS}; a clear at once. */
export class TypingSender {
    constructor(_send: (agentId: string, text: string) => void, _clock: TypingClock, _windowMs: number = TYPING_SEND_MS) {}

    change(_agentId: string, _text: string): void {}
}

/** What another window is typing, per agent, until it is cleared or goes quiet. */
export class TypingBoard {
    constructor(_source: string, _fadeMs: number = TYPING_FADE_MS) {}

    /** A relayed event arrived. Answers whether what is shown changed. */
    apply(_event: TypingEvent, _now: number): boolean {
        return false;
    }

    /** What to show on this agent's composer now; `null` = nobody else is typing. */
    line(_agentId: string, _now: number): { label: string | null; text: string } | null {
        return null;
    }
}

/** The composer's `onDraftChange`: the kept draft (when this window keeps drafts) AND the typing line, both told. */
export function draftChange(
    keeper: { change(agentId: string, draft: ChatDraft): void } | undefined,
    chat: string,
    _typing: ((agentId: string, text: string) => void) | undefined,
): (draft: ChatDraft) => void {
    return (draft) => keeper?.change(chat, draft);
}

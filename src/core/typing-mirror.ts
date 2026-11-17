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
export function readTypingEvent(payload: unknown): TypingEvent | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;
    if (typeof p.agentId !== 'string' || p.agentId === '' || typeof p.text !== 'string' || typeof p.source !== 'string') return null;
    if (p.label !== null && typeof p.label !== 'string') return null;
    return { agentId: p.agentId, text: p.text, source: p.source, label: p.label };
}

/** The newest words of a long draft, on one line, so the line shows what is being typed now. */
export function typingTail(text: string): string {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length <= TYPING_SHOWN_CHARS ? flat : `…${flat.slice(-TYPING_SHOWN_CHARS)}`;
}

/** The window's half: each change of a chat's text, sent at most once per {@link TYPING_SEND_MS}; a clear at once. */
export class TypingSender {
    readonly #send: (agentId: string, text: string) => void;
    readonly #clock: TypingClock;
    readonly #windowMs: number;
    /** Per agent: the window still open after a send, and the text waiting for its end (`null` = nothing waiting). */
    readonly #open = new Map<string, { timer: unknown; waiting: string | null }>();
    /** The last text sent per agent: the same text is not sent twice. */
    readonly #sent = new Map<string, string>();

    constructor(send: (agentId: string, text: string) => void, clock: TypingClock, windowMs: number = TYPING_SEND_MS) {
        this.#send = send;
        this.#clock = clock;
        this.#windowMs = windowMs;
    }

    change(agentId: string, text: string): void {
        if (text.trim() === '') {
            const open = this.#open.get(agentId);
            if (open) { this.#clock.clearTimer(open.timer); this.#open.delete(agentId); }
            if ((this.#sent.get(agentId) ?? '') !== '') this.#emit(agentId, '');
            return;
        }
        const open = this.#open.get(agentId);
        if (open) { open.waiting = text; return; }
        if (text === this.#sent.get(agentId)) return;
        this.#emit(agentId, text);
        this.#arm(agentId);
    }

    #arm(agentId: string): void {
        const entry: { timer: unknown; waiting: string | null } = { timer: null, waiting: null };
        entry.timer = this.#clock.setTimer(() => {
            this.#open.delete(agentId);
            if (entry.waiting !== null && entry.waiting !== this.#sent.get(agentId)) {
                this.#emit(agentId, entry.waiting);
                this.#arm(agentId);
            }
        }, this.#windowMs);
        this.#open.set(agentId, entry);
    }

    #emit(agentId: string, text: string): void {
        this.#sent.set(agentId, text);
        this.#send(agentId, text);
    }
}

/** What another window is typing, per agent, until it is cleared or goes quiet. */
export class TypingBoard {
    readonly #source: string;
    readonly #fadeMs: number;
    readonly #lines = new Map<string, { label: string | null; text: string; at: number }>();

    constructor(source: string, fadeMs: number = TYPING_FADE_MS) {
        this.#source = source;
        this.#fadeMs = fadeMs;
    }

    /** A relayed event arrived. Answers whether what is shown changed. */
    apply(event: TypingEvent, now: number): boolean {
        if (event.source === this.#source) return false;
        if (event.text.trim() === '') return this.#lines.delete(event.agentId);
        this.#lines.set(event.agentId, { label: event.label, text: event.text, at: now });
        return true;
    }

    /** What to show on this agent's composer now; `null` = nobody else is typing. */
    line(agentId: string, now: number): { label: string | null; text: string } | null {
        const line = this.#lines.get(agentId);
        if (!line) return null;
        if (now - line.at >= this.#fadeMs) { this.#lines.delete(agentId); return null; }
        return { label: line.label, text: line.text };
    }

    /** When the soonest line fades, so a window can redraw then; `null` = nothing shown. */
    nextFade(): number | null {
        let soonest: number | null = null;
        for (const line of this.#lines.values()) {
            const at = line.at + this.#fadeMs;
            if (soonest === null || at < soonest) soonest = at;
        }
        return soonest;
    }
}

/** The composer's `onDraftChange`: the kept draft (when this window keeps drafts) AND the typing line, both told. */
export function draftChange(
    keeper: { change(agentId: string, draft: ChatDraft): void } | undefined,
    chat: string,
    typing: ((agentId: string, text: string) => void) | undefined,
): (draft: ChatDraft) => void {
    return (draft) => {
        keeper?.change(chat, draft);
        typing?.(chat, draft.text);
    };
}

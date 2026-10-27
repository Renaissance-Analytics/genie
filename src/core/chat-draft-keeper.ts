import { isDraftRef, isEmptyDraft, parseChatDrafts, type ChatDraft, type ChatDraftFile, type ChatDrafts } from './chat-drafts.js';

/**
 * THE WINDOW'S HALF OF A KEPT DRAFT (genie#1261). The chat's composers mount with `initial(chat)` as react-fancy's
 * `defaultDraft`, report each change through `change`, and keep attachments through `persistFile` / `restoreFile`; main
 * holds the drafts on disk (main/chat-draft-store.ts).
 *
 * Genie 1's renderer did the same for its question drafts: the window's copy is what the person types into, mirrored to
 * main, and main's copy is what a destroyed window or a restart comes back to (v0.7.0-beta.342 `renderer/pages/ask.tsx`,
 * `renderer/lib/ask-state.ts:14-16`).
 *
 * - **Writes are debounced** per chat: a pause in typing is one write, not one per keystroke.
 * - **A send clears at once.** react-fancy empties the composer after a send, and an empty draft is written as "none"
 *   immediately, cancelling the chat's pending write — a quit a moment after sending must never bring the sent message
 *   back. Only that chat's.
 * - **Nothing here focuses anything.** A restore is `defaultDraft`, read at mount, which never moves focus or a caret
 *   (react-fancy 5.65.0; genie#1235).
 *
 * PURE: no DOM, no Electron. The port is main's IPC (`window.genie.chatDrafts`); the timer is injected.
 */
export interface ChatDraftsPort {
    load(): Promise<unknown>;
    save(agentId: string, draft: ChatDraft | null): Promise<void>;
    putFile(bytes: Uint8Array): Promise<string | null>;
    readFile(ref: string): Promise<Uint8Array | null>;
    release(refs: readonly string[]): Promise<void>;
}

export interface DraftClock {
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(timer: unknown): void;
}

/** How long typing pauses before the draft is written. */
export const DRAFT_SAVE_DELAY_MS = 400;

const report = (what: string) => (error: unknown): void => {
    console.warn(`[genie] chat draft: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
};

export class ChatDraftKeeper {
    readonly #port: ChatDraftsPort;
    readonly #clock: DraftClock;
    readonly #delayMs: number;
    #drafts: Record<string, ChatDraft> = {};
    readonly #pending = new Map<string, { timer: unknown; draft: ChatDraft }>();
    #ready = false;

    constructor(port: ChatDraftsPort, clock: DraftClock, delayMs: number = DRAFT_SAVE_DELAY_MS) {
        this.#port = port;
        this.#clock = clock;
        this.#delayMs = delayMs;
    }

    get ready(): boolean {
        return this.#ready;
    }

    /** Read every kept draft from main, once. Main unreachable is "no drafts": the chat is never held up by its draft. */
    async load(): Promise<void> {
        try {
            const loaded: ChatDrafts = parseChatDrafts(await this.#port.load());
            // A change made before the load answered (none should be: no composer mounts until ready) is not overwritten.
            this.#drafts = { ...loaded, ...this.#drafts };
        } catch (error) {
            report('load')(error);
        }
        this.#ready = true;
    }

    /** The draft a chat's composer starts from; `undefined` = none. */
    initial(agentId: string): ChatDraft | undefined {
        return this.#drafts[agentId];
    }

    /** The person changed a chat's draft (react-fancy `onDraftChange`). */
    change(agentId: string, draft: ChatDraft): void {
        this.#cancel(agentId);
        if (isEmptyDraft(draft)) {
            const had = agentId in this.#drafts;
            delete this.#drafts[agentId];
            if (had) void this.#port.save(agentId, null).catch(report('clear'));
            return;
        }
        this.#drafts[agentId] = draft;
        const timer = this.#clock.setTimer(() => this.#write(agentId), this.#delayMs);
        this.#pending.set(agentId, { timer, draft });
    }

    /** A message was sent with these stored files, and holds their bytes now: they are released. */
    sent(_agentId: string, refs: readonly string[]): void {
        const ours = refs.filter(isDraftRef);
        if (ours.length > 0) void this.#port.release(ours).catch(report('release'));
    }

    /** Write every pending draft now (the window is unloading: a reload, a quit). */
    flush(): void {
        for (const agentId of [...this.#pending.keys()]) {
            this.#clock.clearTimer(this.#pending.get(agentId)!.timer);
            this.#write(agentId);
        }
    }

    /** react-fancy `persistAttachment`: the bytes go to Genie's store; its ref goes in the draft. */
    async persistFile(file: Blob): Promise<string | undefined> {
        try {
            return (await this.#port.putFile(new Uint8Array(await file.arrayBuffer()))) ?? undefined;
        } catch (error) {
            report('keep a file')(error);
            return undefined;
        }
    }

    /** react-fancy `restoreAttachment`: the File back from Genie's store, or `undefined` (the chip still shows). */
    async restoreFile(entry: ChatDraftFile): Promise<File | undefined> {
        const bytes = await this.readRef(entry.ref);
        return bytes ? new File([bytes as Uint8Array<ArrayBuffer>], entry.name, { type: entry.type }) : undefined;
    }

    /** A stored file's bytes, by ref — for a restored attachment that is sent before its File came back. */
    async readRef(ref: string | undefined): Promise<Uint8Array | null> {
        if (!isDraftRef(ref)) return null;
        try {
            return await this.#port.readFile(ref);
        } catch (error) {
            report('read a file')(error);
            return null;
        }
    }

    #cancel(agentId: string): void {
        const pending = this.#pending.get(agentId);
        if (!pending) return;
        this.#clock.clearTimer(pending.timer);
        this.#pending.delete(agentId);
    }

    #write(agentId: string): void {
        const pending = this.#pending.get(agentId);
        if (!pending) return;
        this.#pending.delete(agentId);
        void this.#port.save(agentId, pending.draft).catch(report('save'));
    }
}

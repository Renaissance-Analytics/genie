import type { ChatDraft } from './chat-drafts.js';

/**
 * WITHDRAW / EDIT A QUEUED MESSAGE (Tynn #843; the owner, beta.65: "if an item is queued can I still undo the send even
 * if past the buffer"). Undo send (core/send-grace.ts, #745) covers the seconds before a message goes to the host. A
 * message the host then HOLDS for the turn's end (Codex refuses a prompt mid-turn; a provider pause; an agent starting)
 * has not reached the agent either, so the person can still take it back — a real host operation
 * (`resolvePrompt(…, 'withdraw' | 'edit')`, `SessionHost.withdrawQueued`), atomic against the turn's end delivering it.
 *
 * - **Edit**: its words back in the composer (focused), and the message out of the queue and out of the thread.
 * - **Withdraw**: out of the queue. With the composer EMPTY its words go back there (unfocused) and the message leaves
 *   the thread, exactly as Edit; with something already typed, the composer is left alone and the message STAYS in the
 *   thread marked Withdrawn, with Edit and remove, so nothing written is lost.
 * Nothing touches the composer until the host says it was taken back: a withdraw that lost the race (delivered first)
 * answers the host's words, for the message's own line.
 *
 * PURE: the host call, the composer read and the put-back are injected.
 */
export type QueuedAction = 'withdraw' | 'edit';

export type QueuedResolve = (promptId: string, action: QueuedAction) => Promise<{ ok: boolean; reason?: string }>;

/** No words (whitespace is none), no pill, no file. */
export function composerEmpty(draft: ChatDraft | null): boolean {
    return draft === null || (draft.text.trim() === '' && draft.pills.length === 0 && draft.attachments.length === 0);
}

/** What a Withdraw press asks the host for: `edit` when the words can go back to an empty composer, else `withdraw`. */
export function withdrawAction(composer: ChatDraft | null): QueuedAction {
    return composerEmpty(composer) ? 'edit' : 'withdraw';
}

export async function takeBackQueued(o: {
    pressed: QueuedAction;
    promptId: string;
    text: string;
    composer: () => ChatDraft | null;
    resolve: QueuedResolve;
    putBack: (text: string, focus: boolean) => void;
}): Promise<{ ok: true; action: QueuedAction } | { ok: false; reason: string }> {
    const action = o.pressed === 'edit' ? 'edit' : withdrawAction(o.composer());
    let answer: { ok: boolean; reason?: string };
    try {
        answer = await o.resolve(o.promptId, action);
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!answer.ok) return { ok: false, reason: answer.reason ?? 'This message could not be withdrawn. Try again.' };
    // Taken back: only now do its words return — focused for Edit, the person's own ask to write it again.
    if (action === 'edit') o.putBack(o.text, o.pressed === 'edit');
    return { ok: true, action };
}

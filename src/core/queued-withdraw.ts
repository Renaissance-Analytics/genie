import type { ChatDraft } from './chat-drafts.js';

/**
 * WITHDRAW / EDIT A QUEUED MESSAGE (Tynn #843) — stub.
 */
export type QueuedAction = 'withdraw' | 'edit';

export type QueuedResolve = (promptId: string, action: QueuedAction) => Promise<{ ok: boolean; reason?: string }>;

export function composerEmpty(_draft: ChatDraft | null): boolean {
    return false;
}

export function withdrawAction(_composer: ChatDraft | null): QueuedAction {
    return 'withdraw';
}

export async function takeBackQueued(_o: {
    pressed: QueuedAction;
    promptId: string;
    text: string;
    composer: () => ChatDraft | null;
    resolve: QueuedResolve;
    putBack: (text: string, focus: boolean) => void;
}): Promise<{ ok: true; action: QueuedAction } | { ok: false; reason: string }> {
    return { ok: false, reason: 'not implemented' };
}

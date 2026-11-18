import type { StreamEvent } from './stream-event.js';

/**
 * `carried`: kept for the next run after an interrupt it could not confirm (Tynn #702); a new run does not make it undelivered.
 * `withdrawn`: the person took it back while it was still queued (Tynn #843): the agent never got it, and no Restart owes it.
 */
export type PromptDelivery = 'queued' | 'sent' | 'undelivered' | 'discarded' | 'unconfirmed' | 'carried' | 'withdrawn';

/**
 * What the person can do with a message Genie holds for them (`resolvePrompt`): `send` / `discard` an undelivered draft;
 * `withdraw` / `edit` one still QUEUED for the turn's end (Tynn #843) — taken out of the queue before delivery, `withdraw`
 * keeping it in the thread marked Withdrawn, `edit` dropping it from the thread because its words went back to the composer.
 */
export type PromptAction = 'send' | 'discard' | 'withdraw' | 'edit';

export function isPromptAction(v: unknown): v is PromptAction {
    return v === 'send' || v === 'discard' || v === 'withdraw' || v === 'edit';
}

/** Unacknowledged input from an earlier run is a draft, never silently sent on a restart. */
export function promptDeliveries(rows: readonly { event: StreamEvent }[]): Map<string, PromptDelivery> {
    const states = new Map<string, PromptDelivery>();
    for (const { event: e } of rows) {
        if (e.kind === 'run') {
            for (const [id, status] of states) if (status === 'queued') states.set(id, 'undelivered');
        } else if (e.kind === 'message' && e.pending) states.set(e.pending.id, 'queued');
        else if (e.kind === 'prompt_delivery') states.set(e.id, e.status);
    }
    return states;
}

import type { StreamEvent } from './stream-event.js';

export type PromptDelivery = 'queued' | 'sent' | 'undelivered' | 'discarded';

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

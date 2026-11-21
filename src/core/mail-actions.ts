import type { Participant } from './inbox.js';

/**
 * MAIL BETWEEN AGENTS, AS THE WINDOWS HEAR IT (genie#1209, Tynn #766 C2a; moved to genie-host in Tynn #998, 2g-4b1): what
 * one message sent, or one reader's read receipts, says to every window as `genie:action`. genie-host keeps the inbox, so
 * it says them (a `mail` tool signal); main only checks what it was sent and passes it on.
 */
export type MailActionSignal =
    | { readonly agentId: string; readonly kind: 'mail-sent'; readonly to: string; readonly id: string }
    | { readonly agentId: string; readonly kind: 'mail-read'; readonly ids: readonly string[] }
    | { readonly agentId: string; readonly kind: 'agentmail' };

export function mailSignalsOfSend(_to: string, _message: { readonly id: string; readonly from: Participant; readonly to: Participant }): MailActionSignal[] { throw new Error('2g-4b1: not built yet'); }
export function mailSignalsOfRead(_reader: string, _ids: readonly string[] | null | undefined): MailActionSignal[] { throw new Error('2g-4b1: not built yet'); }
/** What genie-host sent, or null when it does not read as one. */
export function readMailSignal(_raw: unknown): MailActionSignal | null { throw new Error('2g-4b1: not built yet'); }

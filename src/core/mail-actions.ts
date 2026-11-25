import type { Participant } from './inbox.js';
import { mailAction } from './agent-actions.js';

/**
 * MAIL BETWEEN AGENTS, AS THE WINDOWS HEAR IT (genie#1209, Tynn #766 C2a; moved to genie-host in Tynn #998, 2g-4b1): what
 * one message sent, or one reader's read receipts, says to every window as `genie:action`. genie-host keeps the inbox, so
 * it says them (a `mail` tool signal); main only checks what it was sent and passes it on.
 */
export type MailActionSignal =
    | { readonly agentId: string; readonly kind: 'mail-sent'; readonly to: string; readonly id: string }
    | { readonly agentId: string; readonly kind: 'mail-read'; readonly ids: readonly string[] }
    | { readonly agentId: string; readonly kind: 'agentmail' }
    /** Mail crossed to or from another of the owner's workstations (P9): its own sound row, on the local agent. */
    | { readonly agentId: string; readonly kind: 'outside' };

export function mailSignalsOfSend(to: string, message: { readonly id: string; readonly from: Participant; readonly to: Participant }): MailActionSignal[] {
    const own = mailAction(message);
    return [{ agentId: message.from, kind: 'mail-sent', to, id: message.id }, ...(own ? [own] : [])];
}
export function mailSignalsOfRead(reader: string, ids: readonly string[] | null | undefined): MailActionSignal[] {
    return ids && ids.length > 0 ? [{ agentId: reader, kind: 'mail-read', ids: [...ids] }] : [];
}
/** What genie-host sent, or null when it does not read as one. */
export function readMailSignal(raw: unknown): MailActionSignal | null {
    const r = raw as { agentId?: unknown; kind?: unknown; to?: unknown; id?: unknown; ids?: unknown } | null;
    if (!r || typeof r !== 'object' || typeof r.agentId !== 'string') return null;
    if (r.kind === 'mail-sent') return typeof r.to === 'string' && typeof r.id === 'string' ? { agentId: r.agentId, kind: 'mail-sent', to: r.to, id: r.id } : null;
    if (r.kind === 'mail-read') return Array.isArray(r.ids) && r.ids.every((i) => typeof i === 'string') ? { agentId: r.agentId, kind: 'mail-read', ids: [...r.ids] as string[] } : null;
    if (r.kind === 'agentmail') return { agentId: r.agentId, kind: 'agentmail' };
    if (r.kind === 'outside') return { agentId: r.agentId, kind: 'outside' };
    return null;
}

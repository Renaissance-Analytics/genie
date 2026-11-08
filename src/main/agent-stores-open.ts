import { planV1KnowledgeImport, type V1Knowledge } from '../core/v1-import.js';
import type { V1Inbox } from '../core/v1-inbox.js';
import type { AgentRecord } from '../core/identity.js';
import type { InboxSessionProbe } from '../core/inbox.js';
import { AttentionStore, type AttentionLimits } from './attention-store.js';
import { InboxStore } from './inbox-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { runV1InboxImport } from './v1-inbox.js';

/**
 * THE STORES AGENTS WRITE TO, OPENED IN ONE PLACE (the host split, P3.1): genie-host opens them (their one writer), and
 * compose only on the emergency path when no host could start. Genie 1's memories and AgentInbox history are taken
 * once, by whoever opens them — each store records that it did.
 */
export async function openAgentStores(
    userData: string,
    now: () => string,
    /** The live pause state AgentInbox's automatic reply reads (genie#1515); it starts no session. Absent = never paused. */
    sessionOf?: InboxSessionProbe,
    /** How much finished history attention keeps (Tynn #549), from the settings; absent = the defaults. */
    attentionLimits?: () => AttentionLimits,
): Promise<{ inbox: InboxStore; attention: AttentionStore; knowledge: KnowledgeStore }> {
    const inbox = await InboxStore.open(userData, now, sessionOf);
    const attention = await AttentionStore.open(userData, inbox, now, attentionLimits);
    const knowledge = KnowledgeStore.open(userData, now);
    return { inbox, attention, knowledge };
}

/** Genie 1's memories, once (knowledge-store.ts records it); a failure is not recorded, so the next boot tries again. */
export function importV1Knowledge(knowledge: KnowledgeStore, read: (() => V1Knowledge | null) | undefined, log: (line: string) => void = console.log): void {
    if (!read || knowledge.v1Import()?.sawV1) return;
    try {
        const done = knowledge.importFromV1(planV1KnowledgeImport(read()));
        const notes = knowledge.v1Import()?.notes ?? [];
        if (!done.alreadyDone) log(`[genie] v1 knowledge import: ${done.noV1 ? 'no v1 knowledge graph seen' : `${done.imported} memories imported, ${done.kept} already here`}${notes.length ? `; ${notes.length} noted: ${notes.join(' | ')}` : ''}`);
    } catch (error) {
        console.error(`[genie] v1 knowledge import failed: ${(error as Error).message}`);
    }
}

/** Genie 1's AgentInbox history, once (inbox-store.ts records it), mapped onto the roster the v1 agent import registered. */
export async function importV1Inbox(inbox: InboxStore, read: (() => V1Inbox | null) | undefined, roster: readonly AgentRecord[], now: number): Promise<void> {
    if (!read) return;
    await runV1InboxImport(inbox, read, { roster, now });
}

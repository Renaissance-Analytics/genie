import type { AgentId } from '../core/identity.js';
import type { ListItem, ListKind } from '../core/attention.js';
import type { AskedRecord, AttentionData, Finished, PendingQuestion } from './attention-store.js';

/**
 * ATTENTION'S READS, over its data (the host split, P3.1). One implementation for the store that owns it
 * (main/attention-store.ts, in genie-host) and the window's replica (main/agent-stores-replica.ts), so the Deck's
 * questions, the person's list and "Last finished" read the same on both sides.
 */

export function pendingOf(data: AttentionData): readonly PendingQuestion[] {
    return data.questions;
}

export function finishedOf(data: AttentionData): readonly Finished[] {
    return data.finished;
}

/** Every user-list item in every workspace, with its workspace — the Deck's user-list source. */
export function allUserItemsOf(data: AttentionData): Array<{ workspaceId: string; item: ListItem }> {
    return data.lists.filter((r) => r.list === 'user').map((r) => ({ workspaceId: r.workspaceId, item: r.item }));
}

/** An agent's LAST handoff, read or not: its first line, and when. A finish without a handoff is skipped. */
export function lastHandoffOf(data: AttentionData, agentId: AgentId): { text: string; at: number } | null {
    for (let i = data.finished.length - 1; i >= 0; i -= 1) {
        const f = data.finished[i]!;
        if (f.agentId !== agentId || f.handoff === null) continue;
        const text = f.handoff.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
        const at = Date.parse(f.at);
        if (text === undefined || Number.isNaN(at)) continue;
        return { text: text.slice(0, 200), at };
    }
    return null;
}

/** A decided question's record, by the id its mail names. */
export function askedOf(data: AttentionData, questionId: string): AskedRecord | null {
    return (data.asked ?? []).find((r) => r.id === questionId) ?? null;
}

/** A list's items as one agent sees them: the person's list is the workspace's; an agent's own list is what it asked. */
export function scopedListOf(data: AttentionData, input: { list: ListKind; workspaceId: string; agentId: AgentId }): AttentionData['lists'] {
    return data.lists.filter((r) => r.list === input.list && r.workspaceId === input.workspaceId && (input.list === 'user' || r.item.askedBy === input.agentId));
}

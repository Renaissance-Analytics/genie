import type { ListItem } from './attention.js';
import type { DeckItem } from './deck.js';
import { HUMAN } from './inbox.js';
import type { Finished, PendingQuestion } from '../main/attention-store.js';
import type { InboxMessage } from '../main/inbox-store.js';

/**
 * THE DECK'S FOUR SOURCES (§4.5), normalised into one item each so the band ranks them as a whole.
 *
 * Approvals arrive from the session layer already. The other three come from tonight's stores:
 *
 * - an AGENT QUESTION is BLOCKING — the agent has stopped until a person answers. A single
 *   question with plain options is answered inline; anything multi-part, multi-select or
 *   free-text-only expands into a form in place.
 * - a USER-LIST item is a thing only a person can DO; it blocks nobody and is done inline.
 * - an UNREAD DM to the human is low priority, titled by sender and first line, marked read inline.
 * - a FINISH WITH A HANDOFF carries the note, with Open / Restart with this / mark read. A finish
 *   with no handoff is the agent's row going idle, not a Deck row.
 *
 * An agent the roster no longer knows is still shown, under its id — never dropped silently.
 */

export interface DeckSourceInput {
    readonly questions: readonly PendingQuestion[];
    readonly userList: readonly { workspaceId: string; item: ListItem }[];
    readonly unreadDms: readonly InboxMessage[];
    readonly finished: readonly Finished[];
    /** Who the agent ids are, for names and workspaces. */
    readonly agents: Readonly<Record<string, { name: string; workspaceId: string }>>;
}

const option = (id: string, label: string) => ({ id, label, tone: 'neutral' as const });

export function deckItemsFrom(input: DeckSourceInput): DeckItem[] {
    const who = (agentId: string) => {
        const a = input.agents[agentId];
        return { agentId, agentName: a?.name ?? agentId, workspaceId: a?.workspaceId ?? null };
    };
    const items: DeckItem[] = [];

    for (const q of input.questions) {
        const first = q.questions[0]!;
        const inline = q.questions.length === 1 && first.multiSelect !== true;
        items.push({
            id: q.id,
            source: 'agent-question',
            agentId: q.agentId,
            agentName: q.agentName,
            workspaceId: q.workspaceId,
            title: q.questions.length === 1 ? first.question : `${first.question} (+${q.questions.length - 1} more)`,
            blocking: true,
            priority: q.priority,
            at: Date.parse(q.askedAt),
            answer: inline
                ? { kind: 'inline', options: first.options.map((o) => option(o.label, o.label)) }
                : { kind: 'form', fields: q.questions.length, questions: q.questions },
            forwardedFrom: null,
        });
    }

    for (const { workspaceId, item } of input.userList) {
        if (item.done) continue;
        const asked = who(item.askedBy);
        items.push({
            id: item.id,
            source: 'user-list',
            agentId: item.askedBy,
            agentName: asked.agentName,
            workspaceId,
            title: item.text,
            blocking: false,
            priority: 'normal',
            at: Date.parse(item.createdAt),
            answer: { kind: 'inline', options: [option('done', 'Done')] },
            forwardedFrom: null,
        });
    }

    for (const m of input.unreadDms) {
        if (m.to !== HUMAN || m.from === HUMAN || m.readAt !== null) continue;
        const sender = who(m.from);
        const firstLine = m.text.split(/\r?\n/)[0] ?? '';
        items.push({
            id: m.id,
            source: 'unread-dm',
            ...sender,
            title: `${sender.agentName}: ${firstLine}`,
            blocking: false,
            priority: 'low',
            at: Date.parse(m.sentAt),
            answer: { kind: 'inline', options: [option('read', 'Mark read')] },
            forwardedFrom: null,
        });
    }

    for (const f of input.finished) {
        if (f.seen || f.handoff === null) continue;
        const agent = who(f.agentId);
        items.push({
            id: f.id,
            source: 'finished-handoff',
            agentId: f.agentId,
            agentName: f.agentName ?? agent.agentName,
            workspaceId: agent.workspaceId,
            title: `${f.agentName ?? agent.agentName} finished: ${f.handoff}`,
            blocking: false,
            priority: 'normal',
            at: Date.parse(f.at),
            answer: { kind: 'inline', options: [option('open', 'Open'), option('restart', 'Restart with this'), option('seen', 'mark read')] },
            forwardedFrom: null,
        });
    }

    return items;
}

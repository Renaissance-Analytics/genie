import type Database from 'better-sqlite3';
import { listWorkspaceTodos } from '../db';
import type { ListItem } from './types';

/**
 * One workspace's lists, shaped for the PANEL rather than for an agent.
 *
 * The agent-facing `lists` tool answers "my list, and the shared one". A person
 * looking at the workspace wants the other cut: everything waiting on them, and
 * what each agent is separately keeping track of. Same rows, different question,
 * so this is a second projection rather than a parameter on the first.
 */

/** One agent's own checklist, as the panel groups it. */
export interface AgentListGroup {
    agentName: string;
    items: ListItem[];
}

export interface WorkspaceListsView {
    /** Every agent with at least one open item, by name. */
    agents: AgentListGroup[];
    /** The shared UserList, each item naming the agent that asked. */
    user: ListItem[];
    /**
     * How many items are waiting on a PERSON — the header badge.
     *
     * Deliberately NOT the total. An agent's own checklist is the agent's work;
     * counting it would put a number on the user's badge that no action of
     * theirs can ever clear.
     */
    userCount: number;
}

export function workspaceListsView(
    database: Database.Database,
    workspaceId: string,
): WorkspaceListsView {
    const user: ListItem[] = listWorkspaceTodos(database, workspaceId, 'user').map((row) => ({
        id: row.id,
        text: row.text,
        ...(row.agent_name ? { agentName: row.agent_name } : {}),
    }));

    // Rows arrive oldest-first per the query's ORDER BY, and a Map preserves
    // insertion order — so each agent's items stay in the order they were
    // written, and the agents themselves come out in the order they first
    // appeared. Stable either way, which is what stops the panel reshuffling
    // itself under a reader between refreshes.
    const byAgent = new Map<string, ListItem[]>();
    for (const row of listWorkspaceTodos(database, workspaceId, 'agent')) {
        const owner = (row.agent_name ?? '').trim();
        // A pre-v76 row has no owner. It belongs to no list that can be shown
        // under a name, and inventing one would attribute someone's item to an
        // agent that never wrote it.
        if (!owner) continue;
        const items = byAgent.get(owner) ?? [];
        items.push({ id: row.id, text: row.text });
        byAgent.set(owner, items);
    }

    return {
        agents: [...byAgent.entries()].map(([agentName, items]) => ({ agentName, items })),
        user,
        userCount: user.length,
    };
}

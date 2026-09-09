/**
 * The wire shape of the `lists` tool — shared by the pure MCP protocol layer
 * and the host that does the sqlite I/O.
 *
 * Deliberately not `WorkspaceTodoRow`. The row carries the table's history
 * (`agent_id`, `status`, timestamps, the v51 columns nothing reads); an agent
 * needs an id to act on and the text to read, and every extra field is a thing
 * it has to decide to ignore.
 */

/** Which of the two lists an action is about. */
export type ListKind = 'agent' | 'user';

/**
 * How many OPEN items each list holds before it refuses more.
 *
 * Here, in the module with no imports, rather than beside the SQL: the pure MCP
 * protocol layer advertises these numbers to agents ("3/10 open") and must be
 * able to read them without pulling in better-sqlite3. `db.ts` re-exports this
 * so there is still exactly one definition.
 */
export const WORKSPACE_TODO_CAPS: Record<ListKind, number> = {
    /** One shared list per workspace, so the human is never handed a wall. */
    user: 5,
    /** Per AGENT, not per workspace — the owner's spec is "no more than 10". */
    agent: 10,
};

/** One line of a list, as an agent sees it. */
export interface ListItem {
    /** The id `done` takes. */
    id: string;
    text: string;
    /**
     * On a USER item, the agent that asked for it — so a person can see who is
     * waiting before they act. Absent on an agent's own items, where it would
     * only ever be the reader.
     */
    agentName?: string;
}

export interface ListsRequest {
    action: 'show' | 'add' | 'done' | 'clear';
    /** `add` only — which list to add to. Defaults to the caller's own. */
    list?: ListKind;
    /** `add` only. */
    text?: string;
    /** `done` only — the item id from `show`. */
    id?: string;
}

export type ListsResult =
    | {
          ok: true;
          /** Whose AgentList `agent` is. */
          agentName: string;
          workspaceId: string;
          /** The caller's own open items. */
          agent: ListItem[];
          /** The workspace's shared open UserList. */
          user: ListItem[];
          /** What the action did, when it did something worth saying. */
          note?: string;
      }
    | { ok: false; error: string };

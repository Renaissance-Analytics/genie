import type Database from 'better-sqlite3';
import {
    createWorkspaceTodo,
    listAgentTodos,
    listWorkspaceTodos,
    resolveUserTodo,
    WORKSPACE_TODO_CAPS,
    type WorkspaceTodoRow,
    type WorkspaceTodoStatus,
} from '../db';

/**
 * AgentList and UserList — the workspace-local lists (genie#556).
 *
 * Two different things sharing one table:
 *
 *  - an **AgentList** is one agent's own scratch to-do. One per agent, capped,
 *    and it survives a restart because that is the entire point of writing it
 *    down rather than keeping it in a turn.
 *  - a **UserList** is one list per WORKSPACE, written by agents, worked by a
 *    person. It is the counterpart to ForceTheQuestion: FTQ parks the agent on
 *    an answer, a UserList lets it carry on while a human does something.
 *
 * The completion nudge is the reason the second one is worth building, so the
 * delivery is a seam rather than a direct broker call: "did the agent that
 * asked actually find out" is the question this feature fails at, and it has to
 * be assertable without an Electron main process.
 *
 * Neither list ever reaches Tynn. They are local, workspace-scoped, and bounded
 * on purpose — roadmap and project-management work belongs in Tynn instead.
 */

/** How a completion notice reaches the agent that asked for the item. */
export interface ListNudgeIO {
    /** That agent's live terminal, or null when it is not running right now. */
    liveTerminalFor(workspaceId: string, agentName: string): string | null;
    /**
     * Post the notice. Reports WHY it failed rather than a bare false: the
     * caller has to turn this into a sentence for a PERSON, and a caller with
     * one bit to work from invents a cause (genie#462).
     */
    deliver(terminalId: string, text: string): { ok: true } | { ok: false; reason: string };
}

/** Whether the notice landed, or the reason it did not. */
export type NudgeOutcome = { delivered: true; terminalId: string } | { delivered: false; reason: string };

export type UserListAction = Exclude<WorkspaceTodoStatus, 'open'>;

export type ResolveUserItemResult =
    | { ok: true; todo: WorkspaceTodoRow; nudge: NudgeOutcome }
    | { ok: false; error: string };

/** The workspace's single UserList — every open item, oldest first. */
export function readUserList(database: Database.Database, workspaceId: string): WorkspaceTodoRow[] {
    return listWorkspaceTodos(database, workspaceId, 'user');
}

/** One agent's own AgentList — every open item, oldest first. */
export function readAgentList(
    database: Database.Database,
    workspaceId: string,
    agentName: string,
): WorkspaceTodoRow[] {
    return listAgentTodos(database, workspaceId, agentName);
}

const PAST_TENSE: Record<UserListAction, string> = {
    done: 'marked DONE',
    thrown_back: 'thrown BACK to you',
    refused: 'REFUSED',
};

/** What the agent reads when a person acts on something it asked for. */
export function userItemNoticeText(
    item: { text: string },
    action: UserListAction,
    comment: string,
): string {
    return [
        `[Genie] A UserList item you were waiting on was ${PAST_TENSE[action]}:`,
        `  "${item.text}"`,
        '',
        `They said: ${comment}`,
        '',
        action === 'done'
            ? 'You are unblocked on this one — carry on.'
            : 'This one did NOT go your way, so re-read it before you carry on.',
    ].join('\n');
}

/**
 * The human acted on a UserList item — record it, then tell the agent that
 * asked.
 *
 * The order matters. The resolution is committed FIRST and stands whatever
 * happens to the notice: the person really did the thing, and losing that
 * because the agent had already exited would make the list lie to the next
 * human who read it. So a failed nudge is reported, never rolled back — and
 * never reported as a success, which is the failure mode that makes a person
 * think they have unblocked someone who is in fact still waiting.
 */
export function resolveUserListItem(
    database: Database.Database,
    io: ListNudgeIO,
    input: { todoId: string; action: UserListAction; comment: string },
): ResolveUserItemResult {
    const resolved = resolveUserTodo(database, input.todoId, input.action, input.comment);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const todo = resolved.todo;
    const agentName = (todo.agent_name ?? '').trim();
    if (!agentName) {
        // Pre-v76 rows have no owner, so there is nobody to tell. Say that
        // rather than silently succeeding.
        return {
            ok: true,
            todo,
            nudge: { delivered: false, reason: 'this item has no agent recorded against it, so there is nobody to notify' },
        };
    }

    const terminalId = io.liveTerminalFor(todo.workspace_id, agentName);
    if (!terminalId) {
        return {
            ok: true,
            todo,
            nudge: {
                delivered: false,
                reason: `${agentName} is not running in this workspace, so it was not told. It will see this the next time it reads its lists.`,
            },
        };
    }

    const sent = io.deliver(terminalId, userItemNoticeText(todo, input.action, input.comment.trim()));
    return {
        ok: true,
        todo,
        nudge: sent.ok ? { delivered: true, terminalId } : { delivered: false, reason: sent.reason },
    };
}

/** Add one item to a list. Refuses past the cap and says so — see `db.ts`. */
export function addListItem(
    database: Database.Database,
    input: { workspaceId: string; agentName: string; list: 'agent' | 'user'; text: string },
): ReturnType<typeof createWorkspaceTodo> {
    return createWorkspaceTodo(database, {
        workspaceId: input.workspaceId,
        kind: input.list,
        agentName: input.agentName,
        text: input.text,
    });
}

export { WORKSPACE_TODO_CAPS };

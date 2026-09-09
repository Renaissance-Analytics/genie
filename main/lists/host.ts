import type Database from 'better-sqlite3';
import { emitListsChanged } from './changed';
import { planListOwner } from './identity';
import {
    addListItem,
    clearAgentList,
    completeAgentItem,
    readAgentList,
    readUserList,
} from './service';
import type { ListItem, ListsRequest, ListsResult } from './types';
import type { WorkspaceTodoRow } from '../db';

/**
 * The `lists` tool's host half: resolve WHO is calling, then act.
 *
 * The I/O it needs is injected rather than imported, for one specific reason —
 * the identity rule is the part of this feature that fails invisibly, and a
 * module that reaches for `getDb()` and `getTerminalSpec()` itself can only be
 * tested with an Electron main process behind it. `server-deps.ts` supplies the
 * real pair; the tests supply a sqlite `:memory:` and a plain object.
 *
 * Every failure comes back as a SENTENCE. A list that cannot be resolved must
 * never render as an empty one: "you have nothing to do" and "Genie could not
 * work out whose list this is" are the same picture, and the agent acts on the
 * first reading.
 */
export interface ListsHostIO {
    db: Database.Database;
    /** The caller's terminal — only the two fields the identity rule reads. */
    specOf(terminalId: string): {
        workspace_id: string | null;
        meta?: { whisper_purpose?: unknown } | null;
    } | null;
}

/** A stored row as an agent sees it. The `agentName` is carried on USER items
 *  only, where "who is waiting on this" is information the reader lacks. */
const toItem = (row: WorkspaceTodoRow, withAuthor: boolean): ListItem => ({
    id: row.id,
    text: row.text,
    ...(withAuthor && row.agent_name ? { agentName: row.agent_name } : {}),
});

/** Both lists as they stand right now, for the given owner. */
function snapshot(
    io: ListsHostIO,
    workspaceId: string,
    agentName: string,
    note?: string,
): ListsResult {
    return {
        ok: true,
        agentName,
        workspaceId,
        agent: readAgentList(io.db, workspaceId, agentName).map((r) => toItem(r, false)),
        user: readUserList(io.db, workspaceId).map((r) => toItem(r, true)),
        ...(note ? { note } : {}),
    };
}

export function handleListsRequest(
    io: ListsHostIO,
    terminalId: string,
    req: ListsRequest,
): ListsResult {
    const spec = io.specOf(terminalId);
    if (!spec) {
        return {
            ok: false,
            // Not "unknown terminal": a GApp reaches these tools under a caller
            // id that is not a terminal at all, and telling it to pass a
            // GENIE_TERMINAL_ID it does not have would send it somewhere there
            // is no answer.
            error: 'Genie could not resolve this caller to a workspace and an agent, so it cannot tell whose list to open. If you are an agent, pass `terminalId` — the value of your GENIE_TERMINAL_ID environment variable.',
        };
    }
    const owner = planListOwner(spec);
    if (!owner.ok) return { ok: false, error: owner.reason };
    const { workspaceId, agentName } = owner;

    switch (req.action) {
        case 'show':
            return snapshot(io, workspaceId, agentName);

        case 'add': {
            const list = req.list === 'user' ? 'user' : 'agent';
            const added = addListItem(io.db, {
                workspaceId,
                agentName,
                list,
                text: req.text ?? '',
            });
            // The cap refusal is the db's own sentence — it explains that
            // nothing was added AND nothing was dropped, which is the thing a
            // caller needs to know before it decides what to do next.
            if (!added.ok) return { ok: false, error: added.error };
            // Only after a write that actually landed — an announcement for a
            // refused add would make the panel re-read for nothing, and worse,
            // would say something changed when the caller was just told it did
            // not.
            emitListsChanged(workspaceId);
            return snapshot(
                io,
                workspaceId,
                agentName,
                list === 'user'
                    ? 'Added to the UserList. You are NOT blocked on it — carry on, and Genie will nudge you when someone marks it done.'
                    : 'Added to your AgentList.',
            );
        }

        case 'done': {
            const done = completeAgentItem(io.db, { todoId: req.id ?? '', agentName });
            if (!done.ok) return { ok: false, error: done.error };
            emitListsChanged(workspaceId);
            return snapshot(io, workspaceId, agentName, `Marked done: ${done.todo.text}`);
        }

        case 'clear': {
            const { cleared } = clearAgentList(io.db, workspaceId, agentName);
            if (cleared > 0) emitListsChanged(workspaceId);
            return snapshot(
                io,
                workspaceId,
                agentName,
                cleared === 0
                    ? 'Your AgentList was already empty — nothing to clear.'
                    : `Cleared your AgentList (${cleared} item${cleared === 1 ? '' : 's'}).`,
            );
        }
    }
}

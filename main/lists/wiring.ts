import { agentInboxBroker } from '../agentinbox/broker';
import { getDb, getWorkspaceTodo, listTerminalSpecs } from '../db';
import { emitListsChanged } from './changed';
import { buildListNudgeIO } from './nudge-io';
import { resolveUserListItem, type ResolveUserItemResult, type UserListAction } from './service';
import { workspaceListsView, type WorkspaceListsView } from './workspace-view';

/**
 * The real db + broker behind the two list operations a WINDOW performs.
 *
 * ONE implementation, two callers: the local IPC handlers (`lists:read` /
 * `lists:resolveUser`) and the host's `/api/desktop/lists/*` routes, which serve
 * a REMOTE window driving this machine (genie#586). That sharing is the whole
 * point rather than tidiness — a second copy of the resolve wiring is a second
 * answer to "was the agent actually told", and the remote copy is the one nobody
 * would notice drifting.
 *
 * The pure halves stay pure: `workspaceListsView` and `resolveUserListItem` take
 * their I/O as arguments and keep their own suites. This module is only the
 * place the real ones get bolted on.
 */

/** One workspace's lists as the panel reads them. */
export function readWorkspaceLists(workspaceId: string): WorkspaceListsView {
    return workspaceListsView(getDb(), workspaceId);
}

/**
 * Which workspace a list item belongs to, or null when no such item exists.
 *
 * Exists for the host route's allow-list, which has to decide whether a remote
 * may act on this item BEFORE it acts. A null answer is "no such row", not
 * "denied" — see `getWorkspaceTodo`.
 */
export function workspaceOfListItem(todoId: string): string | null {
    return getWorkspaceTodo(getDb(), todoId)?.workspace_id ?? null;
}

/**
 * The human acted on a UserList item — record it, nudge the agent that asked,
 * and announce the change.
 *
 * The nudge is why this must run on the HOST wherever the request came from: the
 * authoring agent's terminal and the broker that would carry the notice are both
 * here. "Live" is deliverability rather than liveness in the abstract, so the
 * gate consults the same broker the delivery does — a gate that consults
 * anything else can disagree with the delivery it guards (genie#502).
 *
 * The resolution stands whatever happens to the nudge, and the outcome is
 * REPORTED rather than allowed to roll it back. Callers must carry that outcome
 * back to the person unchanged: a tick in the UI over a nudge that went nowhere
 * is the failure this feature exists to prevent, and it is no less a failure for
 * having crossed a network on the way.
 */
export function resolveUserListItemOnHost(input: {
    todoId: string;
    action: UserListAction;
    comment: string;
}): ResolveUserItemResult {
    const io = buildListNudgeIO({
        terminals: () => listTerminalSpecs(),
        isLive: (id) => agentInboxBroker.agentIdForTerminal(id) != null,
        deliver: (terminalId, text) =>
            agentInboxBroker.deliverHumanMessageToTerminalResult(terminalId, text),
    });
    const result = resolveUserListItem(getDb(), io, {
        todoId: input.todoId,
        action: input.action,
        comment: input.comment ?? '',
    });
    // Through the same emitter an agent's MCP write uses, rather than reaching
    // for a broadcast here: one announcement path means a panel cannot refresh
    // for one kind of writer and not the other, and this module stays free of
    // the window layer.
    if (result.ok) emitListsChanged(result.todo.workspace_id);
    return result;
}

/**
 * The workspace a flow is confined to — read straight from the row.
 *
 * A module of its own, and deliberately tiny, because of WHO imports it:
 * `mcp/caller-workspace.ts`, which `host-tools.ts` loads and which every MCP
 * tool reaches. Importing `flows/store.ts` from there would pull the graph
 * admission types, the trigger reader and the cron parser into that chain, and
 * `flows/executors.ts` imports the bridge, which imports the MCP protocol, which
 * imports host-tools. That is a cycle through the file every tool loads.
 *
 * So this reads one column and depends on nothing but the database.
 *
 * ## Three answers, all different
 *
 *   - a workspace id → the flow is confined to it;
 *   - `null`         → a `system` flow, machine-wide and NOT confined;
 *   - `undefined`    → no such flow, or a scope nobody can read. Fails closed.
 *
 * The third is the one worth stating: a row whose `scope_json` will not parse
 * must not resolve to `null`, because `null` here means the WIDEST authority
 * Genie has. Unreadable is not unconfined.
 */

import { getDb } from '../db';
import { parseFlowScope } from './types';

export function flowWorkspaceIdIn(
    db: { prepare: ReturnType<typeof getDb>['prepare'] },
    flowId: string,
): string | null | undefined {
    const row = (
        db.prepare('SELECT scope_json FROM flows WHERE id = ?') as unknown as {
            get(id: string): { scope_json: string } | undefined;
        }
    ).get(flowId);
    if (!row) return undefined;

    let parsed: unknown = null;
    try {
        parsed = JSON.parse(row.scope_json);
    } catch {
        return undefined;
    }

    const scope = parseFlowScope(parsed);
    if (!scope) return undefined;
    if (scope.kind === 'workspace') return scope.workspaceId;
    // `gapp` reaches here only if something called with a flow caller id for a
    // GApp flow, which nothing does — those run through `dispatchAppCall` as
    // their app. Treated as confined-to-nothing rather than unconfined, because
    // guessing wide is the one mistake this file must not make.
    if (scope.kind === 'gapp') return undefined;
    return null;
}

/** The workspace a flow acts in. See the header for what each answer means. */
export function flowWorkspaceId(flowId: string): string | null | undefined {
    return flowWorkspaceIdIn(getDb(), flowId);
}

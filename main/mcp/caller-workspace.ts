/**
 * WHICH WORKSPACE a caller acts from — one implementation, shared.
 *
 * The decision itself is pure (`caller-identity.ts`); this is the thin wrapper
 * that hands it the two live lookups. Every tool that used to read
 * `getTerminalSpec(id)?.workspace_id` goes through here instead, so an installed
 * GApp resolves to ITS workspace on exactly the same path a terminal does — one
 * implementation of caller authority, not two.
 *
 * It has a module of its own, rather than living in `host-tools.ts` where it was
 * written, because `gapp-dev-tools.ts` needs it too and host-tools needs
 * gapp-dev-tools for the workspace map. Importing both ways would put a cycle
 * through the file every MCP tool loads. Copying the four lines instead would
 * mean two answers to "who is calling", which is the one thing this function
 * exists to prevent.
 */

import { getTerminalSpec } from '../db';
import { appGrantFor } from '../apps/grant-lookup';
import { resolveCaller, type Caller } from './caller-identity';
import { workspaceSlug } from '../agentinbox/slug';

export function resolveCallerFor(callerId: string): Caller {
    return resolveCaller(callerId, {
        terminalWorkspaceId: (id) => getTerminalSpec(id)?.workspace_id ?? null,
        // Installed OR being PREVIEWED. A preview's grant is never written to
        // the app registry, so a lookup that only read the table would let its
        // `me()` answer while every `call()` it made resolved to no workspace at
        // all — an app that looks alive and can do nothing.
        appGrant: (appId) => appGrantFor(appId),
    });
}

/** The workspace a caller (terminal or GApp) acts from, or null for none. */
export function callerWorkspaceIdFor(callerId: string): string | null {
    return callerId ? resolveCallerFor(callerId).workspaceId : null;
}

/** The minimum a caller's workspace has to supply to join the AgentInbox. */
export interface CallerWorkspace {
    id: string;
    name: string;
    slug: string;
    /** Root the caller acts from — attachment paths are resolved against it. */
    path: string;
}

/**
 * The workspace a caller acts from — ONE lookup, no exceptions.
 *
 * ★ This docblock used to argue against what the code now does, so read the
 * reversal rather than trusting either half from memory.
 *
 * It said: the System Workspace deliberately has no `workspaces` row, its specs
 * carry `workspace_id: null` + `meta.system === true`, "every surface
 * substitutes", and *"binding it to a `__system__` row is NOT the fix; no such
 * row exists by design, so that only trades 'not in a workspace' for 'Workspace
 * not found'."*
 *
 * That reasoning was correct GIVEN ITS PREMISE. The premise is what changed: the
 * row exists now (`ensureSystemWorkspaceRow`, rooted at `~/.gosa`), because the
 * pretence was costing more than it saved. AgentInbox identity is
 * `workspaceId:purpose` — the workspace is not a scope on the inbox, it is half
 * the primary key — so an operator with no workspace had no identity, and forty
 * or so surfaces each had to remember to substitute one. Five of those were
 * found broken in a single day: it had never joined the inbox at all, its
 * handoff note was always dropped, it was nearly locked out of service
 * inventory, every restart failed on a non-null assertion against an always-null
 * value, and it was permanently stuck in first-boot.
 *
 * So the substitution is DELETED, not moved. A spec with no `workspace_id` is
 * what it says it is — a terminal in no workspace — and is refused, `meta.system`
 * or not. That tag still marks unattached System-Workspace PANELS and global
 * processes, which root at their own `cwd` and are not callers; it no longer
 * stands in for a missing row. And a missing row now reads as a missing row,
 * which on a machine whose operator is supposed to have one is exactly the
 * report you want.
 *
 * Pure: takes the row lookup, so it is testable without a database.
 */
export function callerWorkspaceDescriptor(
    spec: { workspace_id: string | null },
    lookup: (id: string) => { id: string; project_name: string; path?: string } | undefined,
): CallerWorkspace | null {
    if (!spec.workspace_id) return null;
    const ws = lookup(spec.workspace_id);
    if (!ws) return null;
    return {
        id: ws.id,
        name: ws.project_name,
        slug: workspaceSlug({ project_name: ws.project_name, path: ws.path ?? '' }),
        path: ws.path ?? '',
    };
}

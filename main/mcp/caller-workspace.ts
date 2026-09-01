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
import { SYSTEM_WORKSPACE_ID } from '../terminal/workspace-of-terminal';
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
 * The workspace a caller acts from, INCLUDING the System Workspace.
 *
 * The System Workspace deliberately has no `workspaces` row — its specs carry
 * `workspace_id: null` + `meta.system === true`, and every surface substitutes
 * the sentinel (see `terminal/workspace-of-terminal.ts`). The workspace-scoped
 * guards read `spec.workspace_id` RAW, so they saw null and refused the Genie OS
 * agent outright: it could not use agentinbox, could not file its own feedback,
 * and — because `thumbsUp` gates on a transport it therefore could not register
 * — could never signal boot complete, so it re-ran first-boot orientation on
 * every launch (genie#321).
 *
 * Binding it to a `__system__` row is NOT the fix; no such row exists by design,
 * so that only trades "not in a workspace" for "Workspace not found". The spec
 * is already correct — the guard has to honour the convention.
 *
 * Pure: takes the row lookup, so it is testable without a database.
 */
export function callerWorkspaceDescriptor(
    spec: { workspace_id: string | null; meta?: { system?: boolean } | null },
    lookup: (id: string) => { id: string; project_name: string; path?: string } | undefined,
    /** Where the System Workspace lives on disk (the OSA envelope). */
    systemRoot = '',
): CallerWorkspace | null {
    if (!spec.workspace_id) {
        // A system spec is IN a workspace — the synthetic one. An unattached
        // terminal is genuinely in none, and must still be refused.
        if (spec.meta?.system !== true) return null;
        return {
            id: SYSTEM_WORKSPACE_ID,
            name: 'System Workspace',
            slug: 'system',
            path: systemRoot,
        };
    }
    const ws = lookup(spec.workspace_id);
    if (!ws) return null;
    return {
        id: ws.id,
        name: ws.project_name,
        slug: workspaceSlug({ project_name: ws.project_name, path: ws.path ?? '' }),
        path: ws.path ?? '',
    };
}

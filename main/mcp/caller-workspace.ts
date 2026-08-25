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

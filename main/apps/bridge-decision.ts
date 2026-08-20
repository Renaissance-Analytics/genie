/**
 * PURE. The one gate every GApp call goes through (Tynn #250).
 *
 * A GApp's window has no `window.genie` and no Node — the only way out of it is a
 * mediated bridge, and this function is the decision that bridge makes. It is the
 * entire security surface of the feature, so it lives here on its own, pure, with
 * every refusal asserted in tests rather than assumed from a code path.
 *
 * Two independent questions, in this order:
 *
 *   1. WHAT — is this tool covered by a capability the user GRANTED?
 *   2. WHERE — may this app act on the workspace it is asking about?
 *
 * Capability first, deliberately. When both are wrong, the user needs the
 * actionable reason: "this app was not granted Run commands" sends them to the
 * app's permissions, while a workspace complaint would send them somewhere that
 * was never the problem.
 *
 * The WHERE half delegates to {@link decideAppTarget}, which returns the same
 * `TargetDecision` agents already use, so a GApp cannot end up on a second, laxer
 * authority path beside the agent one.
 */

import { capabilityForTool, findCapability, isAppCapability, UNGRANTABLE_TOOLS } from './capabilities';
import { decideAppTarget } from './scope';
import type { AppScope } from './manifest';
import type { TargetDecision } from '../mcp/target-workspace';

/** What the user actually consented to, as stored. */
export interface AppGrant {
    appId: string;
    /** Shown in every refusal and stamped on anything the app says to the user. */
    appName: string;
    /** The app's own workspace. Empty means it has none, and so no authority. */
    workspaceId: string;
    scope: AppScope;
    /** Named workspaces, when scope is `workspaces`. */
    workspaces?: string[];
    /** GRANTED capabilities — a subset of what the manifest declared. */
    capabilities: string[];
    /** Revocation is immediate and total. */
    revoked: boolean;
}

export interface AppCallRequest {
    tool: string;
    /** Absent means the app's own workspace — never a wildcard. */
    workspaceId?: string;
}

export interface AppCallDecision extends TargetDecision {
    /** The capability that carried an allowed call. */
    capability?: string;
    /** The bridge must stamp {@link appName} on anything sent through this call. */
    mustAttribute?: true;
    appName?: string;
}

function refuse(reason: string): AppCallDecision {
    return { allowed: false, workspaceId: '', reason, via: 'denied' };
}

export function decideAppCall(
    request: AppCallRequest,
    grant: AppGrant | null | undefined,
): AppCallDecision {
    if (!grant) {
        return refuse('This app has no permission grant, so it cannot call Genie.');
    }
    if (grant.revoked) {
        return refuse(
            `“${grant.appName}” has been revoked — its permissions were turned off, so no Genie call it makes will run.`,
        );
    }

    // --- WHAT ---------------------------------------------------------------
    const standingRefusal = UNGRANTABLE_TOOLS[request.tool];
    if (standingRefusal) {
        // Not a missing grant — nobody can grant this. Say so, so the user is not
        // sent looking for a switch that does not exist.
        return refuse(
            `No Genie App may use “${request.tool}”, at any permission level. ${standingRefusal}`,
        );
    }

    const capability = capabilityForTool(request.tool);
    if (!capability) {
        // Unclassified is denied. A tool added to Genie without being placed in the
        // capability model must be unreachable, not implicitly public.
        return refuse(
            `“${request.tool}” is not something a Genie App can call — no permission covers it.`,
        );
    }

    // `isAppCapability` guards a hand-edited or migrated grant row: the manifest
    // already rejects invented capability names, and this makes sure one cannot
    // arrive by another route and match a tool by accident.
    const granted = grant.capabilities.some((c) => isAppCapability(c) && c === capability);
    if (!granted) {
        const label = findCapability(capability)?.label ?? capability;
        return refuse(
            `“${grant.appName}” was not granted “${label}”, which is required to use ${request.tool}. ` +
                'You can change what this app is allowed to do in its permissions.',
        );
    }

    // --- WHERE --------------------------------------------------------------
    const target = decideAppTarget(grant.workspaceId || null, request.workspaceId, {
        scope: grant.scope,
        ...(grant.workspaces ? { workspaces: grant.workspaces } : {}),
    });
    if (!target.allowed) return { ...target, capability };

    return {
        ...target,
        capability,
        ...(findCapability(capability)?.mustAttribute
            ? { mustAttribute: true as const, appName: grant.appName }
            : {}),
    };
}

/**
 * PURE. WHO is making a tool call (Tynn #250).
 *
 * Every Genie tool resolves its workspace from the caller, and until now a caller
 * was always a TERMINAL. A GApp has no terminal — it is a window — but the
 * requirement is that a GApp can use Genie's full tool set under a consented
 * scope. Building a second dispatch path for apps would mean two implementations
 * of "may this caller act here?", and experience says the laxer one eventually
 * wins.
 *
 * So there is ONE caller identity with two kinds, resolved here, and the existing
 * chokepoint (`resolveAgentTarget`) applies the rules for whichever kind arrived.
 * An app's caller id is prefixed so the two namespaces cannot collide: a terminal
 * literally named `gapp:com.example.trader` must not inherit that app's grant.
 *
 * The security consequence worth stating: an app's authority is read from the
 * GRANT — the record of what the user consented to — never from anything the
 * caller says about itself. A revoked grant resolves to no workspace at all, so
 * even a call that reached dispatch by another route has nothing to act on.
 */

import type { AppGrant } from '../apps/bridge-decision';

const GAPP_CALLER_PREFIX = 'gapp:';

/**
 * A FLOW's caller prefix.
 *
 * A flow has no terminal either, and it has something neither of the other two
 * kinds does: it runs with NOBODY WATCHING. Its authority therefore comes from
 * the flow's scope — the record of what the user armed — exactly as an app's
 * comes from its grant, and never from anything the caller says about itself.
 *
 * Reserved for the same reason `gapp:` is: a terminal literally named
 * `flow:nightly` must not inherit a flow's authority.
 */
const FLOW_CALLER_PREFIX = 'flow:';

/** The caller id a GApp's bridge calls present. */
export function callerIdForApp(appId: string): string {
    return `${GAPP_CALLER_PREFIX}${appId}`;
}

/** The caller id a flow run presents. */
export function flowCallerId(flowId: string): string {
    return `${FLOW_CALLER_PREFIX}${flowId}`;
}

/** The flow id inside a flow caller id, or null when it is not one. */
export function flowIdFromCallerId(callerId: string): string | null {
    return callerId.startsWith(FLOW_CALLER_PREFIX)
        ? callerId.slice(FLOW_CALLER_PREFIX.length) || null
        : null;
}

/** The app id inside a GApp caller id, or null when it is not one. */
export function appIdFromCallerId(callerId: string): string | null {
    return callerId.startsWith(GAPP_CALLER_PREFIX)
        ? callerId.slice(GAPP_CALLER_PREFIX.length) || null
        : null;
}

export interface CallerLookups {
    /** The workspace a terminal is attached to, or null. */
    terminalWorkspaceId: (terminalId: string) => string | null;
    /** The installed app's grant, or null when it is not installed. */
    appGrant: (appId: string) => AppGrant | null;
    /**
     * The workspace a flow's SCOPE confines it to.
     *
     * Three answers, and they are all different:
     *   - a workspace id  → confined to it;
     *   - `null`          → a `system` flow, not confined;
     *   - `undefined`     → no such flow. Fails closed.
     *
     * A `gapp` flow never reaches here — it calls through `dispatchAppCall` as
     * its app and resolves as `kind: 'app'`.
     */
    flowWorkspaceId: (flowId: string) => string | null | undefined;
}

export type Caller =
    | { kind: 'terminal'; terminalId: string; workspaceId: string | null }
    | { kind: 'app'; appId: string; grant: AppGrant; workspaceId: string | null }
    /**
     * A flow run. `workspaceId: null` means UNCONFINED (a `system` flow), not
     * "nowhere" — which is the opposite of what it means for a terminal, and is
     * why this is its own kind rather than a terminal with a funny id.
     */
    | { kind: 'flow'; flowId: string; workspaceId: string | null }
    | { kind: 'none'; workspaceId: null };

export function resolveCaller(callerId: string, lookups: CallerLookups): Caller {
    if (!callerId) return { kind: 'none', workspaceId: null };

    const appId = appIdFromCallerId(callerId);
    if (appId !== null) {
        const grant = lookups.appGrant(appId);
        // An uninstalled app fails closed rather than falling through to a terminal
        // lookup that might happen to match.
        if (!grant) return { kind: 'none', workspaceId: null };
        return {
            kind: 'app',
            appId,
            grant,
            // Revoked means no authority anywhere, immediately.
            workspaceId: grant.revoked ? null : grant.workspaceId || null,
        };
    }

    const flowId = flowIdFromCallerId(callerId);
    if (flowId !== null) {
        const workspaceId = lookups.flowWorkspaceId(flowId);
        // A flow that is not there fails closed rather than falling through to a
        // terminal lookup that might happen to match — the same rule an
        // uninstalled app gets, and for the same reason.
        if (workspaceId === undefined) return { kind: 'none', workspaceId: null };
        return { kind: 'flow', flowId, workspaceId };
    }

    return {
        kind: 'terminal',
        terminalId: callerId,
        workspaceId: lookups.terminalWorkspaceId(callerId) || null,
    };
}

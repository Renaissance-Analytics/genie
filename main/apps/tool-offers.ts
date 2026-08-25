/**
 * PURE. May THIS caller invoke a tool that GApp offers? (capability-provider
 * finding, 2026-08-24.)
 *
 * The inverse of `scope.ts`, and the reason both exist separately. `decideAppTarget`
 * answers "may this APP act on that workspace?" — a grant the user makes TO the
 * app. This answers "may that workspace's AGENTS spend this app's compute?" — a
 * grant the user makes ABOUT it. An app is routinely `scope: self` and callable
 * from everywhere: a renderer touches nothing but its own workspace, and other
 * workspaces' agents calling it is the entire point of shipping it.
 *
 * Kept pure and beside its sibling for the same reason that one is: ONE chokepoint
 * for "may this caller do this", so a provider tool cannot end up on a second,
 * laxer path beside the agent one.
 *
 * ## Discovery and invocation, in one place
 *
 * A consuming agent never learns a special protocol. It sees `remotion.renderVideo`
 * in `tools/list` beside every other tool, with the app's own description and
 * argument schema, and calls it with `tools/call` like anything else. The
 * dot-namespaced fall-through in `mcp/protocol.ts` already routes any name that
 * missed every core case to a dispatcher — today that dispatcher only knows
 * plugins, and the remaining work is a second one that speaks to a GApp service.
 *
 * What must NOT be a second path is the permission check, which is why the list and
 * the call are decided by the same function here: a tool a caller may not invoke
 * must not appear in that caller's tool list either. A tool an agent can see and
 * cannot call is a tool it will keep trying.
 */

import { appToolName, type AppConsumers, type AppMcpTool } from './manifest';

/** An installed app's offer, as the decision layer wants to see it. */
export interface AppToolOffer {
    appId: string;
    /** The tool namespace — the app's own slug. */
    slug: string;
    /** Null for an app with no workspace of its own: no authority to extend. */
    appWorkspaceId: string | null;
    /** The GRANTED offer, not the declared one. The user narrows this at install. */
    consumers: AppConsumers;
    tools: AppMcpTool[];
    revoked?: boolean;
}

export interface ToolOfferDecision {
    allowed: boolean;
    reason: string;
    /** WHY, in a word — it travels into approval prompts and logs. */
    via: 'self' | 'granted' | 'workstation' | 'denied';
}

/** A tool descriptor as `tools/list` returns it. */
export interface OfferedTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

function denied(reason: string): ToolOfferDecision {
    return { allowed: false, reason, via: 'denied' };
}

export function decideToolOffer(
    offer: AppToolOffer,
    callerWorkspaceId: string | undefined,
): ToolOfferDecision {
    // Revocation beats every other answer, including the app's own workspace. A
    // revoked app is one the user has switched off, and "off" that still ran its
    // own tools would not be off.
    if (offer.revoked) {
        return denied(`"${offer.slug}" has been revoked, so none of its tools can be called.`);
    }
    if (!offer.appWorkspaceId) {
        return denied(
            `"${offer.slug}" has no workspace of its own, so it has no authority to lend out.`,
        );
    }

    const caller = callerWorkspaceId?.trim();
    // Not "unknown, so probably fine". With no caller there is nothing to check
    // the grant against, so there is nothing that permits the call.
    if (!caller) {
        return denied(
            `A call to "${offer.slug}" has no calling workspace, so no grant can cover it.`,
        );
    }

    // The app's own agents always may. That is not a grant anybody has to make —
    // it is the app running its own tools.
    if (caller === offer.appWorkspaceId) {
        return { allowed: true, reason: 'The app’s own workspace.', via: 'self' };
    }

    const consumers = offer.consumers;
    if (consumers.scope === 'workstation') {
        return {
            allowed: true,
            reason: `"${offer.slug}" was granted to every workspace on this machine at install.`,
            via: 'workstation',
        };
    }
    if (consumers.scope === 'workspaces') {
        // An empty allow-list is not "all" — `validateAppManifest` refuses to
        // produce one, and this refuses to honour one if it ever arrives.
        if (consumers.workspaces?.includes(caller)) {
            return {
                allowed: true,
                reason: `"${offer.slug}" was granted to this workspace at install.`,
                via: 'granted',
            };
        }
        return refusal(offer.slug, caller, 'workspaces');
    }
    if (consumers.scope === 'self') return refusal(offer.slug, caller, 'self');

    // An unrecognised scope must refuse rather than fall through to allow.
    return refusal(offer.slug, caller, String((consumers as { scope?: unknown }).scope ?? 'unknown'));
}

/**
 * A refusal a user could act on.
 *
 * This is a grant they can change, not a wall, and the message has to say so —
 * otherwise the agent reports "not allowed" and nobody knows there was a switch.
 */
function refusal(slug: string, caller: string, scope: string): ToolOfferDecision {
    return denied(
        `"${slug}" does not offer its tools to workspace "${caller}": its granted reach is ` +
            `"${scope}". Who may call an app's tools is chosen at install and can be changed in ` +
            "the app's permissions.",
    );
}

/**
 * The tools a caller in this workspace can SEE.
 *
 * Fail-closed PER APP, not per list — the same contract `pluginTools` already
 * keeps. One malformed provider must never take a working one's tools out of an
 * agent's surface.
 */
export function offeredToolsFor(
    offers: readonly AppToolOffer[],
    callerWorkspaceId: string | undefined,
): OfferedTool[] {
    const out: OfferedTool[] = [];
    for (const offer of offers) {
        try {
            if (!decideToolOffer(offer, callerWorkspaceId).allowed) continue;
            for (const tool of offer.tools) {
                out.push({
                    name: appToolName(offer.slug, tool.name),
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                });
            }
        } catch {
            // A bad offer contributes nothing and takes nothing with it.
        }
    }
    return out;
}

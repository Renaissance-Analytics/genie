import type { AppPermissions } from './manifest';

/**
 * Just the WHERE half of a grant. Deliberately not the whole {@link AppPermissions}:
 * which workspace an app may act on has nothing to do with which capabilities it
 * holds, and a function that cannot see them cannot accidentally consult them.
 */
export type AppScopeGrant = Pick<AppPermissions, 'scope' | 'workspaces'>;
import type { TargetDecision } from '../mcp/target-workspace';

/**
 * PURE. Which workspace a GApp may act on (Tynn #250).
 *
 * A GApp installs into its own workspace and can reach Genie's tool surface. How
 * far that reach extends is the most consequential thing the user consents to at
 * install, so it is decided here — in one pure function — rather than spread
 * through the bridge.
 *
 * It returns the same {@link TargetDecision} shape agents already use
 * (`mcp/target-workspace.ts`), on purpose: the runtime keeps ONE chokepoint for
 * "may this caller act here?", and a GApp cannot end up on a second, laxer path
 * beside the agent one. The `via` values differ because the REASON differs, and
 * that reason travels into approval prompts and logs.
 *
 * Fail-closed at every edge. An unknown scope, an empty allow-list, or a GApp with
 * no workspace of its own all refuse — the last because there is nothing to be
 * scoped relative to, so there is no authority to extend.
 */
export function decideAppTarget(
    appWorkspaceId: string | null,
    requestedWorkspaceId: string | undefined,
    permissions: AppScopeGrant,
): TargetDecision {
    if (!appWorkspaceId) {
        return {
            allowed: false,
            workspaceId: '',
            reason: 'This app has no workspace of its own, so it has no authority to act on one.',
            via: 'denied',
        };
    }

    const requested = requestedWorkspaceId?.trim();

    // A blank/absent request means "my own workspace" — never a wildcard.
    if (!requested || requested === appWorkspaceId) {
        return {
            allowed: true,
            workspaceId: appWorkspaceId,
            reason: 'Acting on the app’s own workspace.',
            via: 'self',
        };
    }

    if (permissions.scope === 'workstation') {
        return {
            allowed: true,
            workspaceId: requested,
            reason: 'This app was granted workstation scope at install.',
            via: 'workstation',
        };
    }

    if (permissions.scope === 'workspaces') {
        // An empty allow-list is not "all" — `validateAppManifest` refuses to
        // produce one, and this refuses to honour one if it ever arrives.
        if (permissions.workspaces?.includes(requested)) {
            return {
                allowed: true,
                workspaceId: requested,
                reason: 'This app was granted access to this workspace at install.',
                via: 'granted',
            };
        }
        return denied(requested, 'workspaces');
    }

    if (permissions.scope === 'self') return denied(requested, 'self');

    // An unrecognised scope must refuse rather than fall through to allow.
    return denied(requested, String((permissions as { scope?: unknown }).scope ?? 'unknown'));
}

function denied(requested: string, scope: string): TargetDecision {
    return {
        allowed: false,
        workspaceId: '',
        reason:
            `Not allowed to target workspace "${requested}": this app's granted scope is "${scope}". ` +
            'An app may always act on its own workspace; anything wider is granted at install and can be changed there.',
        via: 'denied',
    };
}

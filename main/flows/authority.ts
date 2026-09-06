/**
 * PURE. Whose authority a flow runs under, decided by its SCOPE.
 *
 * This is the one thing scope decides. Everywhere else scope is noise reduction
 * — which surfaces list a flow, which agents it clutters — and nothing
 * security-bearing may rest on it. Here it answers a different question: when
 * this graph calls a Genie tool, who is calling?
 *
 *   - `gapp`      → the owning APP. Exactly what that app could already do from
 *                   its own window, through the same `decideAppCall` gate. A
 *                   flow can do less than its app, never more.
 *   - `workspace` → the USER, confined to one workspace.
 *   - `system`    → the USER, machine-wide.
 *
 * ## Why the user is not simply allowed everything
 *
 * Because nobody is watching. The recipe system this replaces reached the same
 * conclusion from the other direction — *an unattended run may execute
 * first-party code and nothing else*, because a shell step at 3am is a command
 * nobody sanctioned — and refused every step type that was not in-repo code.
 *
 * Under graphs the rule has a sharper form, because every step names its tool
 * STRUCTURALLY rather than deciding it at run time: **a flow may call the tools
 * an app could be granted, and never an ungrantable one.** That list already
 * exists, in `apps/capabilities.ts`, and a test there fails the BUILD when a new
 * Genie tool is added without being classified — so this inherits a rule that
 * cannot silently go stale, instead of inventing a second one beside it.
 *
 * `UNGRANTABLE_TOOLS` never produce a node kind at all (`nodes.ts`), so most of
 * this is enforced by construction. The check stays anyway: a stored graph can
 * be hand-edited, and a defence that only exists at authoring time is not a
 * defence.
 *
 * ## What arming means
 *
 * A flow is born disarmed and a human turns it on. THAT is the consent, and the
 * graph is the consequence sentence it is given against — which is the whole
 * reason a graph is better than a recipe id here: the sentence cannot drift from
 * the code, because it IS the code.
 */

import type { AppGrant } from '../apps/bridge-decision';
import type { FlowScope } from './types';

/**
 * Who a run acts as.
 *
 * A discriminated union rather than a nullable grant, because "no grant" has two
 * completely different meanings — *this app has no permissions* (refuse
 * everything) and *this flow is the user's* (no app is involved at all) — and
 * collapsing them is how a user-scoped flow ends up silently refused, or worse,
 * an ownerless app flow ends up silently allowed.
 */
export type FlowAuthority =
    | { kind: 'app'; grant: AppGrant | null }
    | { kind: 'user'; workspaceId: string | null };

/**
 * The authority a scope confers.
 *
 * `loadGrant` is injected so this stays pure and the decision is testable
 * without a database. Production binds it to `getAppGrant`.
 *
 * Returns null for an UNREADABLE scope, and the callers treat that as "refuse".
 * The dangerous alternative is defaulting to `system`, which would turn a
 * corrupt column into the widest authority Genie has.
 */
export function authorityForScope(
    scope: FlowScope | null,
    loadGrant: (appId: string) => AppGrant | null,
): FlowAuthority | null {
    if (!scope) return null;
    if (scope.kind === 'gapp') return { kind: 'app', grant: loadGrant(scope.appId) };
    if (scope.kind === 'workspace') return { kind: 'user', workspaceId: scope.workspaceId };
    return { kind: 'user', workspaceId: null };
}

/** How to name the actor in a refusal, so a message reads as a sentence. */
export function describeAuthority(authority: FlowAuthority): string {
    if (authority.kind === 'app') return authority.grant?.appName ?? 'this app';
    return authority.workspaceId ? 'this workspace' : 'this machine';
}

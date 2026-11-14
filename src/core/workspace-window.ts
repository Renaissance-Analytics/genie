import { formatRoute, parseRoute } from './route.js';

/**
 * A WORKSPACE-SHARE WINDOW (Tynn #690; the owner, 2026-11-13: "make sure the genie window UI for workspace shares doesn't
 * show any workstation specific ux"). A window opened from a Tynn share link or invite to ONE workspace renders that
 * workspace and nothing of the workstation it lives on: its agents, their chat, its files and terminals, as the share
 * allows. Read-only shows no send or act controls.
 *
 * What scopes the window is the HOST's welcome (main/remote-host.ts: `isOwner`, `workspaceId`, `readonly`, from the Tynn
 * grant), never a flag this client sets: the host refuses everything outside the workspace whatever the window draws, and
 * this only keeps the window from offering it.
 */
export type WindowScope =
    | { readonly kind: 'workstation' }
    | { readonly kind: 'workspace'; readonly workspaceId: string; readonly readonly: boolean };

export const WORKSTATION_SCOPE: WindowScope = Object.freeze({ kind: 'workstation' });

/** What the host's welcome said, as the window keeps it (renderer/remote-bridge.ts RemoteState). */
export interface WelcomeReading {
    readonly connected: boolean;
    readonly isOwner: boolean;
    readonly workspaceId: string | null;
    readonly readonly?: boolean | undefined;
}

/** A guest the host admitted to one workspace is a workspace window; everyone else — the owner, a whole-workstation guest, this machine — is not. */
export function windowScopeOf(state: WelcomeReading | null | undefined): WindowScope {
    if (!state || !state.connected || state.isOwner || state.workspaceId === null || state.workspaceId === '') return WORKSTATION_SCOPE;
    return { kind: 'workspace', workspaceId: state.workspaceId, readonly: state.readonly === true };
}

/** Where a workspace window lands: its workspace's own page. */
export function workspaceHome(workspaceId: string): string {
    return `genie://workspace/${encodeURIComponent(workspaceId)}`;
}

/**
 * The route a window may show. A workstation window shows what it is asked. A workspace window shows its workspace's page
 * or one of its agents' — never the Dashboard, the Deck, Settings, Hosting, Flows, Knowledge, the browser, another
 * workspace, another workspace's agent or Genie's own agent; a deep link to any of them lands on the workspace's page.
 * What rides the route is kept to the workspace too: no AgentInbox flyout (the workstation's mail), no chat naming an agent
 * outside it.
 */
export function routeInScope(route: string, scope: WindowScope, agents: readonly { id: string; workspaceId: string }[]): string {
    if (scope.kind === 'workstation') return route;
    const home = workspaceHome(scope.workspaceId);
    const parsed = parseRoute(route);
    const ownAgent = (id: string | null | undefined): boolean => typeof id === 'string' && agents.some((a) => a.id === id && a.workspaceId === scope.workspaceId);
    const inside = (parsed.surface === 'workspace' && parsed.workspaceId === scope.workspaceId) || (parsed.surface === 'agent' && ownAgent(parsed.agentId));
    if (!inside) return home;
    const dropInbox = parsed.inbox !== undefined && parsed.inbox !== null;
    const dropChat = parsed.chat !== null && !ownAgent(parsed.chat);
    if (!dropInbox && !dropChat) return route;
    return formatRoute({ ...parsed, ...(dropInbox ? { inbox: null } : {}), ...(dropChat ? { chat: null } : {}) });
}

/**
 * Whose chat a workspace window shows: the agent picked when it is one of the workspace's, else the workspace's default
 * agent, else its first — never Genie's own agent or another workspace's. `null` = the workspace has no agent yet.
 */
export function chatSubjectInScope(subject: string | null, scope: WindowScope, agents: readonly { id: string; workspaceId: string }[], workspaces: readonly { id: string; defaultAgentId?: string | null | undefined }[] | null): string | null {
    if (scope.kind === 'workstation') return subject;
    const own = agents.filter((a) => a.workspaceId === scope.workspaceId);
    if (subject !== null && own.some((a) => a.id === subject)) return subject;
    const preferred = workspaces?.find((w) => w.id === scope.workspaceId)?.defaultAgentId ?? null;
    if (preferred !== null && own.some((a) => a.id === preferred)) return preferred;
    return own[0]?.id ?? null;
}

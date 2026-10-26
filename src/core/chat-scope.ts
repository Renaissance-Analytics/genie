import type { Route } from './route.js';
import { workspaceLabel } from './workspace-label.js';

/**
 * WHICH WORKSPACE THE CHAT IS TALKING TO, against the one on screen.
 *
 * The owner, on beta.26: "I sent a chat to the wrong agent because the navigation still doesn't sync — I navigated to
 * the prism workspace but the chat stayed on moic." #258 made an open chat ride every navigation (`carryChat`), so a
 * person can roam with one conversation open. It rode onto another workspace too, and the composer still read
 * `Message moic` over prism's agents — a message typed there went to a project the person was not looking at.
 *
 * The contract — THE CHAT FOLLOWS THE VIEW, and there are no chat tabs (the owner, 2026-10-18: "get rid of the chat
 * tabs completely because we should be switching from workspace to workspace and then the workspaces have agent tabs
 * already. Any view that is not a workspace view shows the genie agent chat"):
 *  - **An agent's view** — the chat is that agent. A workspace's agent tabs are how a person picks one.
 *  - **A workspace's view** — an agent of that workspace: the one already in the chat if it is there, else the one
 *    you last chatted with there (newest first), else its first.
 *  - **Any other view** (Dashboard, Deck, Settings, the feature surfaces) — Genie.
 *  - Pinned stays pinned; a closed chat stays closed.
 *  - **A workspace with no agent to message** (or whose agents are not read yet) keeps the chat where it was, and the
 *    composer is replaced by the reason — there is nothing on screen to send to, and sending elsewhere is the bug.
 *  - **A chat deliberately on another workspace's agent** (a link or route that names it) names that workspace in the
 *    composer and the header: `Message lark — in beta.example`. Never silent.
 */

/** The slice of an agent row these rules read (structurally `AgentRow`). */
export interface ChatRosterAgent {
    readonly id: string;
    readonly name: string;
    readonly workspaceId: string;
}

/** The slice of a workspace these rules read (structurally `RailWorkspace`). */
export interface ChatScopeWorkspace {
    readonly id: string;
    readonly path: string;
    readonly name?: string | undefined;
    /** `false` = Genie has not read its agents yet: "none" would be a guess. */
    readonly agentsKnown?: boolean | undefined;
}

/** The OS agent's workspace id: genie belongs to no project. */
const OS_WORKSPACE = '__genie__';

const isProjectAgent = (r: ChatRosterAgent): boolean => r.workspaceId !== OS_WORKSPACE;

/**
 * The agent a route's `chat=` names: by id, else by NAME when exactly one agent has it (a link may say `chat=atlas`).
 * An ambiguous or unknown name resolves to nothing — the rules then leave the chat alone rather than guess.
 */
export function resolveChatAgent(subject: string, roster: readonly ChatRosterAgent[]): ChatRosterAgent | null {
    const byId = roster.find((r) => r.id === subject);
    if (byId) return byId;
    const named = roster.filter((r) => r.name === subject);
    return named.length === 1 ? named[0]! : null;
}

/** The workspace a route puts on screen: a workspace's own, an agent's (from the roster), or none. */
export function workspaceOnScreen(route: Route, roster: readonly ChatRosterAgent[]): string | null {
    if (route.surface === 'workspace' || route.surface === 'files') return route.workspaceId;
    if (route.surface === 'agent') {
        const row = resolveChatAgent(route.agentId, roster);
        return row && isProjectAgent(row) ? row.workspaceId : null;
    }
    return null;
}

/**
 * The chat's subject on `next`, given it was `subject` before. Unchanged unless `next` puts ANOTHER workspace on screen
 * and that workspace has an agent to move to (see the contract above).
 */
export function followChat(subject: string, next: Route, roster: readonly ChatRosterAgent[], opened: readonly string[]): string {
    // Without the roster nothing can be placed: the chat rides along unchanged rather than guess.
    if (roster.length === 0) return subject;
    if (next.surface === 'agent') return resolveChatAgent(next.agentId, roster)?.id ?? subject;
    const screen = workspaceOnScreen(next, roster);
    if (screen === null) return genieOf(roster);
    const current = resolveChatAgent(subject, roster);
    if (current !== null && current.workspaceId === screen) return subject;
    const here = roster.filter((r) => r.workspaceId === screen);
    const last = opened.find((id) => here.some((r) => r.id === id));
    return last ?? here[0]?.id ?? subject;
}

/** Genie, the OS agent: its id on this roster, else its name (a route resolves either). */
export function genieOf(roster: readonly ChatRosterAgent[]): string {
    return roster.find((r) => !isProjectAgent(r) && r.name === 'genie')?.id ?? 'genie';
}

export type ChatScope =
    /** The chat's agent is in the workspace on screen, or nothing on screen belongs to a workspace. */
    | { kind: 'here' }
    /** The chat's agent is in ANOTHER workspace than the one on screen: the composer names it. */
    | { kind: 'elsewhere'; workspace: string }
    /** The workspace on screen has no agent to message: the composer is replaced by why. */
    | { kind: 'blocked'; reason: string };

/** Where the open chat's agent sits against the workspace on screen. */
export function chatScope(route: Route, roster: readonly ChatRosterAgent[], workspaces: readonly ChatScopeWorkspace[] | null): ChatScope {
    if (route.chat === null) return { kind: 'here' };
    const agent = resolveChatAgent(route.chat, roster);
    if (agent === null || !isProjectAgent(agent)) return { kind: 'here' };
    const screen = workspaceOnScreen(route, roster);
    if (screen === null || screen === agent.workspaceId) return { kind: 'here' };
    const theirs = workspaceLabel(workspaces, agent.workspaceId);
    const here = workspaceLabel(workspaces, screen);
    const known = workspaces?.find((w) => w.id === screen)?.agentsKnown !== false;
    if (!known) return { kind: 'blocked', reason: `${here}'s agents are not read yet. ${agent.name} is in ${theirs}.` };
    if (!roster.some((r) => r.workspaceId === screen)) return { kind: 'blocked', reason: `${here} has no agent to message. ${agent.name} is in ${theirs}.` };
    return { kind: 'elsewhere', workspace: theirs };
}

/** The slice of a workspace the chat's subject reads: its chosen default agent (Workspace settings). */
export interface ChatSubjectWorkspace {
    readonly id: string;
    readonly defaultAgentId?: string | undefined;
}

/**
 * THE CHAT IS ALWAYS OPEN, AND THE VIEW DECIDES WHOSE IT IS (the owner, 2026-10-19: "Chat cannot be closed PERIOD"; "the
 * chat is always the workspace agent unless I click on another agents tab then the chat shows that agent's chat"):
 *  - an agent's tab → that agent;
 *  - a workspace's view → its DEFAULT agent (Workspace settings), else its first agent;
 *  - any other view → genie.
 *  - the Dashboard → the agent picked there, else genie (genie#1209; the owner, 2026-10-26: "on the dashboard page I
 *    should be able to click on agent to bring up their chat and stay on the dashboard"). The pick is the WINDOW's,
 *    passed in, never the address's.
 * Nothing else moves it: a `chat=` in a route is not read here (the address is losing it, Tynn #831).
 */
export function chatSubjectFor(route: Route, roster: readonly ChatRosterAgent[], workspaces: readonly ChatSubjectWorkspace[], dashboardPick: string | null = null): string {
    if (route.surface === 'agent') return resolveChatAgent(route.agentId, roster)?.id ?? route.agentId;
    if (route.surface === 'dashboard' && dashboardPick !== null && roster.some((r) => r.id === dashboardPick)) return dashboardPick;
    const screen = workspaceOnScreen(route, roster);
    if (screen === null) return genieOf(roster);
    const chosen = workspaces.find((w) => w.id === screen)?.defaultAgentId;
    const here = roster.filter((r) => r.workspaceId === screen);
    if (chosen !== undefined && here.some((r) => r.id === chosen)) return chosen;
    return here[0]?.id ?? genieOf(roster);
}

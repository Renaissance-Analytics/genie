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
 * The contract:
 *  - **Inside one workspace, and on surfaces of no workspace** (Dashboard, Deck, Settings, the feature surfaces), the
 *    chat stays on its agent — #258's free roam, unchanged.
 *  - **Arriving at ANOTHER workspace** — its route, or one of its agents — moves the chat to an agent of that workspace:
 *    the agent on screen, else the one you last chatted with there (the chat's remembered tabs, newest first), else
 *    its first. Pinned stays pinned, floating stays floating.
 *  - **A workspace with no agent to message** (or whose agents are not read yet) keeps the chat where it was, and the
 *    composer is replaced by the reason — there is nothing on screen to send to, and sending elsewhere is the bug.
 *  - **A chat deliberately on another workspace's agent** (its tab picked while floating) names that workspace in the
 *    composer and the header: `Message lark — in beta.example`. Never silent.
 *  - **genie, the OS agent,** belongs to no project and is never swapped out.
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
    const screen = workspaceOnScreen(next, roster);
    if (screen === null) return subject;
    const current = resolveChatAgent(subject, roster);
    if (current === null || !isProjectAgent(current) || current.workspaceId === screen) return subject;
    const here = roster.filter((r) => r.workspaceId === screen);
    if (next.surface === 'agent') {
        const onScreen = resolveChatAgent(next.agentId, roster);
        if (onScreen && here.includes(onScreen)) return onScreen.id;
    }
    const last = opened.find((id) => here.some((r) => r.id === id));
    return last ?? here[0]?.id ?? subject;
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

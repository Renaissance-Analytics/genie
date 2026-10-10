/**
 * ROUTES — the application's state, written down.
 *
 * ```
 * genie://dashboard?group=workspace
 * genie://deck
 * genie://agent/<id>?tab=stream&lane=tools&at=ev_8831
 * genie://workspace/<id>?panel=files
 * …&chat=<agent>&pin=right              on ANY surface
 * ```
 *
 * ## Why all of it is in the URL
 *
 * So refresh, back and deep links work — and above all so **an agent can hand a human a link
 * to the exact place it needs them.** `genie://agent/kai?tab=stream&at=ev_8831` is the whole
 * handoff: the surface, the lane, and the one event under discussion. A view that keeps its
 * state in a component cannot be pointed at.
 *
 * The title bar shows the route verbatim for the same reason: it is how a human and an agent
 * name the same place.
 *
 * ## The two failure modes this file is shaped around
 *
 *  - **A blank surface.** An unparseable or unknown route falls back to the Dashboard, never
 *    to an empty frame with a stale string in the bar — that state is unrecoverable without
 *    knowing a shortcut.
 *  - **An empty id.** `genie://agent/` must not resolve to an agent named `''`, which would
 *    look up nothing, find nothing, and render an empty session forever. That is §0.4 — the
 *    identity split that hid a finished Conversation UI for three releases — reached by a
 *    different door.
 *
 * And the line between them: an id that is *well-formed but unknown* is KEPT. The parser does
 * not hold the roster, and one that redirects an id it cannot resolve produces "I clicked the
 * link and it dumped me on the Dashboard" with nothing to read.
 */

export type Pin = 'right';

/** Modifiers that ride any surface. The chat flyout is not a surface of its own. */
interface Common {
    chat: string | null;
    pin: Pin | null;
}

export type DashboardGroup = 'workspace' | 'status';
export type AgentTab = 'stream' | 'files' | 'changes' | 'terminal' | 'activity';
export type WorkspacePanel = 'files';

export type Route =
    | ({ surface: 'dashboard'; group: DashboardGroup } & Common)
    | ({ surface: 'deck' } & Common)
    | ({ surface: 'agent'; agentId: string; tab: AgentTab; lane: string | null; at: string | null } & Common)
    | ({ surface: 'workspace'; workspaceId: string; panel: WorkspacePanel | null } & Common);

export const DEFAULT_ROUTE = 'genie://dashboard?group=workspace';

const AGENT_TABS: readonly AgentTab[] = ['stream', 'files', 'changes', 'terminal', 'activity'];

function dashboard(group: DashboardGroup, common: Common): Route {
    return { surface: 'dashboard', group, ...common };
}

export function parseRoute(input: string): Route {
    const blank: Common = { chat: null, pin: null };

    const match = /^genie:\/\/([^?]*)(?:\?(.*))?$/.exec(input.trim());
    if (!match) return dashboard('workspace', blank);

    const [head = '', ...rest] = (match[1] ?? '').split('/');
    const params = new URLSearchParams(match[2] ?? '');
    const tail = rest.join('/');

    const common: Common = {
        chat: params.get('chat') || null,
        pin: params.get('pin') === 'right' ? 'right' : null,
    };

    switch (head) {
        case 'deck':
            return { surface: 'deck', ...common };

        case 'agent': {
            // An empty id is NOT an agent. Falling through to the Dashboard is the honest
            // outcome; resolving `''` would render an empty session that looks like a bug in
            // the agent rather than in the link.
            if (!tail) return dashboard('workspace', common);

            const asked = params.get('tab');
            const tab: AgentTab = AGENT_TABS.includes(asked as AgentTab) ? (asked as AgentTab) : 'stream';

            return {
                surface: 'agent',
                agentId: tail,
                tab,
                lane: params.get('lane') || null,
                at: params.get('at') || null,
                ...common,
            };
        }

        case 'workspace': {
            if (!tail) return dashboard('workspace', common);
            return {
                surface: 'workspace',
                workspaceId: tail,
                panel: params.get('panel') === 'files' ? 'files' : null,
                ...common,
            };
        }

        case 'dashboard':
            return dashboard(params.get('group') === 'status' ? 'status' : 'workspace', common);

        default:
            return dashboard('workspace', common);
    }
}

export function formatRoute(route: Route): string {
    const params = new URLSearchParams();

    switch (route.surface) {
        case 'dashboard':
            params.set('group', route.group);
            break;
        case 'agent':
            params.set('tab', route.tab);
            if (route.lane) params.set('lane', route.lane);
            if (route.at) params.set('at', route.at);
            break;
        case 'workspace':
            if (route.panel) params.set('panel', route.panel);
            break;
        case 'deck':
            break;
    }

    if (route.chat) params.set('chat', route.chat);
    if (route.pin) params.set('pin', route.pin);

    const path =
        route.surface === 'agent' ? `agent/${route.agentId}`
        : route.surface === 'workspace' ? `workspace/${route.workspaceId}`
        : route.surface;

    // No trailing `?` when there is nothing to say. Small, but it is the difference between
    // the bar's text and the link an agent pasted, for no reason a reader could work out.
    const query = params.toString();
    return query ? `genie://${path}?${query}` : `genie://${path}`;
}

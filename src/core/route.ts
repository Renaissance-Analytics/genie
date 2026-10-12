import { formatRange, parseRange, type TimeRange } from './lanes.js';
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
export type WorkspaceView = 'home' | 'terminals' | 'settings';
const WORKSPACE_VIEWS: readonly WorkspaceView[] = ['home', 'terminals', 'settings'];
/** The settings surface's four groups (`core/settings.ts` owns the registry; this is the URL's view of it). */
export type SettingsGroup = 'general' | 'agents' | 'workstation' | 'appearance';
/** Surfaces with no parameters of their own beyond the common modifiers. */
export type PlainFeature = 'knowledge' | 'flows' | 'hosting' | 'toolchain' | 'inbox';

export type Route =
    | ({ surface: 'dashboard'; group: DashboardGroup } & Common)
    /** The Deck, optionally opened ON one item (`?item=<id>`): where a waiting Dashboard row sends the reader (§4.1). */
    | ({ surface: 'deck'; item: string | null } & Common)
    | ({ surface: 'agent'; agentId: string; tab: AgentTab; lane: string | null; at: string | null; range: TimeRange | null } & Common)
    /**
     * A workspace opens on its AGENTS (`home`, the board's workspace surface); `terminals` (§4.6) and the
     * workspace's `settings` are the other two views of the same route. Home writes no `view=`.
     */
    | ({ surface: 'workspace'; workspaceId: string; panel: WorkspacePanel | null; view: WorkspaceView } & Common)
    /** A Take Over window: one terminal, no chrome. `genie://takeover/<terminalId>`. */
    | ({ surface: 'takeover'; terminalId: string } & Common)
    /** The file panel in its own window (§4.3): one workspace's panel, no chrome. `genie://files/<workspaceId>`. */
    | ({ surface: 'files'; workspaceId: string } & Common)
    /** The feature surfaces (§4.0's title-bar icons and the rest of §6): one route each. */
    | ({ surface: PlainFeature } & Common)
    | ({ surface: 'settings'; group: SettingsGroup | null } & Common)
    /** The Genie browser; the page it shows rides the URL so back and deep links work. */
    | ({ surface: 'browser'; url: string | null } & Common);

export const DEFAULT_ROUTE = 'genie://dashboard?group=workspace';

const AGENT_TABS: readonly AgentTab[] = ['stream', 'files', 'changes', 'terminal', 'activity'];
const SETTINGS_GROUPS: readonly SettingsGroup[] = ['general', 'agents', 'workstation', 'appearance'];
const PLAIN_FEATURES: readonly PlainFeature[] = ['knowledge', 'flows', 'hosting', 'toolchain', 'inbox'];
/** The sub-routes lines and signals point at (`genie://settings/github`) → the group that holds them. */
const SETTINGS_ALIASES: Readonly<Record<string, SettingsGroup>> = { github: 'workstation', tynn: 'general', agents: 'agents', updates: 'general' };

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
            return { surface: 'deck', item: params.get('item') || null, ...common };

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
                // Malformed is DROPPED, not fatal: the lane and anchor beside it still open.
                range: parseRange(params.get('range')),
                ...common,
            };
        }

        case 'takeover': {
            // No id is not a window. Same honesty as an empty agent id: the Dashboard.
            if (!tail) return dashboard('workspace', common);
            // No modifiers: a TUI window has no chat flyout to open and no pin to keep.
            return { surface: 'takeover', terminalId: tail, chat: null, pin: null };
        }
        case 'files': {
            // The popped-out panel (§4.3): no id is not a window; no modifiers either.
            if (!tail) return dashboard('workspace', common);
            return { surface: 'files', workspaceId: tail, chat: null, pin: null };
        }
        case 'workspace': {
            if (!tail) return dashboard('workspace', common);
            return {
                surface: 'workspace',
                workspaceId: tail,
                panel: params.get('panel') === 'files' ? 'files' : null,
                view: WORKSPACE_VIEWS.includes(params.get('view') as WorkspaceView) ? (params.get('view') as WorkspaceView) : 'home',
                ...common,
            };
        }

        case 'dashboard':
            return dashboard(params.get('group') === 'status' ? 'status' : 'workspace', common);

        case 'settings': {
            const asked = tail ? SETTINGS_ALIASES[tail] ?? null : params.get('group');
            const group = SETTINGS_GROUPS.includes(asked as SettingsGroup) ? (asked as SettingsGroup) : null;
            return { surface: 'settings', group, ...common };
        }

        case 'browser':
            return { surface: 'browser', url: params.get('url') || null, ...common };

        default:
            if (PLAIN_FEATURES.includes(head as PlainFeature)) return { surface: head as PlainFeature, ...common };
            return dashboard('workspace', common);
    }
}

export function formatRoute(route: Route): string {
    const params = new URLSearchParams();

    switch (route.surface) {
        case 'settings':
            if (route.group !== null) params.set('group', route.group);
            break;
        case 'browser':
            if (route.url !== null) params.set('url', route.url);
            break;
        case 'dashboard':
            params.set('group', route.group);
            break;
        case 'agent':
            params.set('tab', route.tab);
            if (route.lane) params.set('lane', route.lane);
            if (route.range) params.set('range', formatRange(route.range) as string);
            if (route.at) params.set('at', route.at);
            break;
        case 'workspace':
            if (route.panel) params.set('panel', route.panel);
            if (route.view !== 'home') params.set('view', route.view);
            break;
        case 'takeover':
            break;
        case 'files':
            break;
        case 'deck':
            if (route.item) params.set('item', route.item);
            break;
    }

    if (route.chat) params.set('chat', route.chat);
    if (route.pin) params.set('pin', route.pin);

    const path =
        route.surface === 'agent' ? `agent/${route.agentId}`
        : route.surface === 'workspace' ? `workspace/${route.workspaceId}`
        : route.surface === 'takeover' ? `takeover/${route.terminalId}`
        : route.surface === 'files' ? `files/${route.workspaceId}`
        : route.surface;

    // No trailing `?` when there is nothing to say. Small, but it is the difference between
    // the bar's text and the link an agent pasted, for no reason a reader could work out.
    const query = params.toString();
    return query ? `genie://${path}?${query}` : `genie://${path}`;
}

/**
 * An agent route reached by NAME (`genie://agent/genie`) settles on the resolved id: every live channel
 * and every link the Agent view builds is keyed by the minted id, so a page left at the name would never
 * update. Returns the canonical route, or `null` when the route is already canonical or not an agent's.
 */
export function canonicalAgentRoute(current: string, resolvedId: string): string | null {
    const parsed = parseRoute(current);
    if (parsed.surface !== 'agent' || parsed.agentId === resolvedId) return null;
    return formatRoute({ ...parsed, agentId: resolvedId });
}

/**
 * A PINNED chat's subject does not follow the view (§4.4) — it stays. The rail's routes are literals, so without this
 * every navigation dropped `chat=&pin=` and the pinned flyout vanished. Carries the current pinned chat onto `next`
 * when `next` names no chat of its own. An unpinned chat is an overlay on the view it was opened over, and does not
 * follow.
 */
export function carryPinnedChat(next: string, current: Route, pinned: boolean): string {
    if (!pinned || current.chat === null) return next;
    const parsedNext = parseRoute(next);
    if (parsedNext.chat !== null) return next;
    return formatRoute({ ...parsedNext, chat: current.chat, pin: current.pin ?? 'right' });
}

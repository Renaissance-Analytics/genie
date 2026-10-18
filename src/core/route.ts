import { formatRange, parseRange, type TimeRange } from './lanes.js';
import { followChat, type ChatRosterAgent } from './chat-scope.js';
/**
 * ROUTES — the application's state, written down.
 *
 * ```
 * genie://dashboard?group=workspace
 * genie://deck
 * genie://agent/<id>?tab=stream&lane=tools&at=ev_8831
 * genie://workspace/<id>?files=<path>&filter=changed     (the file panel; `files=` open with no file, `files=detached` popped out)
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
export type AgentTab = 'stream' | 'files' | 'changes' | 'shells' | 'terminal' | 'activity' | 'settings';
export type WorkspacePanel = 'files';
/** `tab:<id>` is a tab the person designed (Tynn #282, core/workspace-tabs.ts). */
export type WorkspaceView = 'home' | 'terminals' | 'settings' | 'github' | `tab:${string}`;
const WORKSPACE_VIEWS: readonly WorkspaceView[] = ['home', 'terminals', 'settings', 'github'];
/** A designed tab's id, as `core/workspace-tabs.ts` mints it; anything else in `view=` falls back to the Agents view. */
const DESIGNED_TAB = /^tab:[A-Za-z0-9-]{1,40}$/;
function workspaceViewOf(raw: string | null): WorkspaceView {
    if (raw !== null && DESIGNED_TAB.test(raw)) return raw as WorkspaceView;
    return WORKSPACE_VIEWS.includes(raw as WorkspaceView) ? (raw as WorkspaceView) : 'home';
}
/** The settings surface's four groups (`core/settings.ts` owns the registry; this is the URL's view of it). */
export type SettingsGroup = 'general' | 'agents' | 'workstation' | 'appearance';
/** The Stream's two layouts (the board): the ledger, or one card per turn. */
export type StreamLayout = 'ledger' | 'turns';
/** Surfaces with no parameters of their own beyond the common modifiers. */
export type PlainFeature = 'knowledge' | 'flows' | 'hosting' | 'toolchain' | 'inbox';

export type Route =
    | ({ surface: 'dashboard'; group: DashboardGroup } & Common)
    /** The Deck, optionally opened ON one item (`?item=<id>`): where a waiting Dashboard row sends the reader (§4.1). */
    | ({ surface: 'deck'; item: string | null } & Common)
    /** `layout`: the Stream as a ledger (the default, writes nothing) or folded into `turns` cards (the board's `&layout=turns`). */
    | ({ surface: 'agent'; agentId: string; tab: AgentTab; lane: string | null; at: string | null; range: TimeRange | null; layout: StreamLayout } & Common)
    /**
     * A workspace opens on its AGENTS (`home`, the board's workspace surface); `terminals` (§4.6) and the
     * workspace's `settings` are the other two views of the same route. Home writes no `view=`.
     */
    | ({
          surface: 'workspace';
          workspaceId: string;
          panel: WorkspacePanel | null;
          view: WorkspaceView;
          /** The file open in the panel (the board's `?files=<path>`); `null` = the panel shows no file. */
          file: string | null;
          /** The line that file opens at (`&line=<n>`, from 1) — openFileForUser's line (Tynn #804); `null` = the top. */
          line: number | null;
          /** The panel's Changed filter (`&filter=changed`); `null` = All. */
          filter: 'changed' | null;
          /** The panel in its own window (`?files=detached`). */
          detached: boolean;
      } & Common)
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

const AGENT_TABS: readonly AgentTab[] = ['stream', 'files', 'changes', 'shells', 'terminal', 'activity', 'settings'];
const SETTINGS_GROUPS: readonly SettingsGroup[] = ['general', 'agents', 'workstation', 'appearance'];
const PLAIN_FEATURES: readonly PlainFeature[] = ['knowledge', 'flows', 'hosting', 'toolchain', 'inbox'];
/** The sub-routes lines and signals point at (`genie://settings/github`) → the group that holds them. */
const SETTINGS_ALIASES: Readonly<Record<string, SettingsGroup>> = { github: 'workstation', tynn: 'general', agents: 'agents', updates: 'general', mcp: 'workstation' };

function dashboard(group: DashboardGroup, common: Common): Route {
    return { surface: 'dashboard', group, ...common };
}

/**
 * WHICH WORKSPACE A ROUTE IS IN (Tynn #805): the workspace's own pages, and an agent's page — which belongs to its
 * agent's workspace. The sidebar keeps that workspace highlighted wherever in it you are; `null` elsewhere.
 */
/** A line number from the route: a whole number from 1, else none. */
function lineOf(raw: string | null): number | null {
    if (raw === null || !/^[0-9]+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 ? n : null;
}

export function routeWorkspace(route: string, agents: ReadonlyArray<{ id: string; workspaceId: string }>): string | null {
    const r = parseRoute(route);
    if (r.surface === 'workspace' || r.surface === 'files') return r.workspaceId;
    if (r.surface === 'agent') return agents.find((a) => a.id === r.agentId)?.workspaceId ?? null;
    return null;
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
                layout: params.get('layout') === 'turns' ? 'turns' : 'ledger',
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
            // The board's keys: `files=<path>` (empty = open, no file; `detached` = in its own window). An old
            // `panel=files` link still opens the panel.
            const files = params.get('files');
            const detached = files === 'detached';
            return {
                surface: 'workspace',
                workspaceId: tail,
                panel: files !== null || params.get('panel') === 'files' ? 'files' : null,
                file: files !== null && files !== '' && !detached ? files : null,
                line: files !== null && files !== '' && !detached ? lineOf(params.get('line')) : null,
                filter: files !== null && params.get('filter') === 'changed' ? 'changed' : null,
                detached,
                view: workspaceViewOf(params.get('view')),
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
            if (route.layout === 'turns') params.set('layout', 'turns');
            break;
        case 'workspace':
            if (route.panel === 'files') {
                params.set('files', route.detached ? 'detached' : route.file ?? '');
                if (route.filter === 'changed' && !route.detached) params.set('filter', 'changed');
                if (route.file && route.line !== null && !route.detached) params.set('line', String(route.line));
            }
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
 * AN OPEN CHAT STAYS OPEN WHEREVER YOU GO — pinned or floating (the owner, 2026-10-14: "When in flyout mode and it's
 * floating I can free roam anywhere in the app and it remains open to the same agent chat until I close the flyout or
 * pin it again"). It used to follow only when pinned; an unpinned chat vanished on the first navigation. The rail's
 * routes are literals, so this carries the current chat (and whether it is pinned) onto `next` when `next` names no chat
 * of its own. Closing the chat is a route without `chat=`, built from the current one — it never passes through here.
 *
 * BUT NOT ONTO ANOTHER WORKSPACE (the owner, beta.26: "I navigated to the prism workspace but the chat stayed on moic" —
 * and a message went to the wrong agent). When `next` puts another workspace on screen, the chat moves to an agent of
 * THAT workspace (`core/chat-scope.ts` `followChat`: the agent on screen, else the one last chatted with there — `opened`,
 * the chat's remembered tabs, newest first — else its first). Inside one workspace, and on surfaces of no workspace, it
 * stays. Without the roster nothing can be placed in a workspace, and the chat rides along unchanged.
 */
export function carryChat(next: string, current: Route, roster: readonly ChatRosterAgent[] = [], opened: readonly string[] = []): string {
    if (current.chat === null) return next;
    const parsedNext = parseRoute(next);
    if (parsedNext.chat !== null) return next;
    return formatRoute({ ...parsedNext, chat: followChat(current.chat, parsedNext, roster, opened), pin: current.pin });
}

/**
 * PICKING A CHAT TAB (the owner, 2026-10-14: "When the chat is pinned, whenever I select an agent tab, it should bring me
 * to that agent's view as well"). The chat is always docked now (2026-10-17), so this is what a pick does: the main view
 * goes to that agent too, the chat beside it.
 */
export function pickThreadRoute(agentId: string): string {
    return formatRoute({ ...parseRoute(`genie://agent/${agentId}?tab=stream`), chat: agentId });
}

/**
 * The NAVIGATIONAL route — which SUBJECT is on screen, encoded in the url.
 *
 * **Not to be confused with `./view-state.ts`**, which is the per-window LAYOUT
 * store (`view_state_json`: which panels a workspace shows in this window, the
 * focused one, the grid mode). That is client-local persistence of *how a
 * workspace is arranged*. This is *where you are*, and it belongs in the url for
 * three reasons Genie has never had:
 *
 *   1. **Refresh and back work.** Today `master.tsx` holds 11 independent flyout
 *      booleans and imports no router, so a reload drops you wherever the default
 *      is and there is no way back to what you were reading.
 *   2. **A place is linkable.** An agent that needs a human can hand over a link
 *      to the exact surface it needs them on, rather than "open Genie and look".
 *   3. **One destination per badge.** The Deck is the landing view, so Esc has
 *      somewhere to go and a notification has somewhere to point.
 *
 * Pure and DOM-free on purpose: the decisions below are the ones easy to get
 * subtly wrong, and they are all unit-testable without mounting anything.
 */

/** Tabs an agent surface can show. Which ones EXIST depends on the agent's
 *  fidelity — a Declared agent gets Conversation, an Observed one gets Activity —
 *  so this union is the superset and the surface validates against the agent. */
export type AgentTab = 'session' | 'terminal' | 'files' | 'changes' | 'activity';

const AGENT_TABS: readonly AgentTab[] = ['session', 'terminal', 'files', 'changes', 'activity'];

/** The subject on screen. */
export type GenieView =
    /**
     * Today's Floor — the panel grid for whatever workspace is active.
     *
     * NOT the default any more: `parseViewRoute` answers the Deck for no params and
     * `viewRouteQuery` gives the grid `?view=grid`, so the grid is now the one you ask for.
     *
     * This comment used to say the opposite — "THE DEFAULT, and deliberately so for now" —
     * which was true when it was written and became a lie the moment the default moved. It is
     * corrected rather than deleted because the warning inside it is still live: an earlier
     * attempt made the Deck the no-params default BEFORE it was ready, and E2E caught it on
     * all three platforms with the grid hidden on every window that opened without a query
     * string. The lesson is that the default is load-bearing in E2E, not that it may never
     * move.
     */
    | { kind: 'grid' }
    /** Cross-workspace view: what needs you, every agent, what changed. Reached
     *  EXPLICITLY with `?view=deck` until it becomes the default. */
    | { kind: 'deck' }
    /**
     * The WORKFLOW DASHBOARD — what every agent is producing, grouped by workspace.
     *
     * A sibling of the Deck, not a replacement: the Deck answers "does anything need me?" and
     * is a queue you clear; this answers "what is being produced, and by whom?" and is a board
     * you read. The owner's ruling on the overlap, and it is why a waiting agent appears on
     * both — only the Deck row asks for anything.
     *
     * NAMED rather than default, like the grid. The board's own title bars read
     * `genie://dashboard?group=workspace`.
     */
    | { kind: 'dashboard' }
    /** One workspace's panels — today's Floor. */
    | { kind: 'workbench'; workspaceId: string }
    /** One agent. `tab: null` means "not chosen yet"; the surface picks a default
     *  from the agent's fidelity, which the route cannot know. */
    | { kind: 'agent'; agentId: string; tab: AgentTab | null };

/** The shape Next hands back for `router.query`. */
export type RouteQuery = Record<string, string | string[] | undefined>;

/**
 * Read one query param. Repeated params (`?ws=a&ws=b`) arrive as an array; take
 * the first rather than letting a workspace id become the string `"a,b"`. Blank
 * and whitespace-only values are treated as absent — `?ws=` must not open a
 * Workbench for the workspace named `""`.
 */
function one(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the url into a view. **Never throws and never returns something
 * unrenderable** — anything it cannot satisfy (a `view=workbench` with no
 * workspace, an id that is blank, a tab that does not exist) degrades to the
 * Deck or drops the offending part. A bad link must land somewhere useful, not
 * on a blank screen.
 */
export function parseViewRoute(query: RouteQuery): GenieView {
    // Explicit, checked FIRST so a named view wins over a leftover `ws`. `grid` is now the
    // one that must be asked for -- the Deck is the default (Genie 2).
    const named = one(query.view);
    if (named === 'deck') return { kind: 'deck' };
    if (named === 'grid') return { kind: 'grid' };
    if (named === 'dashboard') return { kind: 'dashboard' };

    const agentId = one(query.agent);
    if (agentId) {
        // The agent WINS over a workspace. An agent is the more specific subject
        // and its link carries a workspace implicitly, so a deep link naming both
        // must not land on the Workbench.
        const tab = one(query.tab);
        return {
            kind: 'agent',
            agentId,
            tab: tab && (AGENT_TABS as readonly string[]).includes(tab) ? (tab as AgentTab) : null,
        };
    }

    const workspaceId = one(query.ws);
    if (workspaceId) return { kind: 'workbench', workspaceId };

    /**
     * No params: THE WORKFLOW DASHBOARD.
     *
     * The owner's instruction, and the spec board's own architecture: the Dashboard
     * "absorbs the Deck's Agents band and the Floor as a cross-workspace glance", and
     * "the top level shows status and communication; work opens one level down".
     *
     * beta.1 made the DECK the default instead and stranded the owner on first launch. The
     * reasoning behind that flip was not wrong — a 2x2 of transcripts really is maximum
     * pixels and near-zero information. What was missed is that the destination had NO WAY
     * OUT BY MOUSE: roster rows carried no handler, the workspace rail changed
     * `activeWorkspaceId` without touching the route so clicking a workspace altered
     * nothing visible, and the only door out was a palette row — which
     * `feature-reachability` judged sufficient, because it checks that a feature HAS an
     * entry, not that a human can find one. A palette row is not an affordance.
     *
     * So this default is conditional on the destination being escapable, and that is now a
     * test rather than a promise: `Dashboard` declares `onOpenAgent`, `dashboard-render`
     * proves a wired row is a real `<button>` carrying its agent id, and
     * `surface-handlers-wired` fails the build if `master.tsx` ever stops passing it.
     */
    return { kind: 'dashboard' };
}

/**
 * The query params for a view — the inverse of {@link parseViewRoute}.
 *
 * The GRID encodes to `{}`, deliberately: it is the landing view, so its url stays
 * clean instead of carrying `?view=grid`. That also means "no params" and "the grid"
 * are the same thing in both directions, which is what keeps the round trip honest —
 * and it must move together with `parseViewRoute`'s default or the two halves of this
 * module disagree about what an empty url means.
 */
export function viewRouteQuery(view: GenieView): Record<string, string> {
    switch (view.kind) {
        case 'grid':
            // NAMED, and on its way out. The owner's ruling: the terminal grid leaves the
            // Floor entirely — a provider TUI opens in its OWN WINDOW (`openTerminalWindow`),
            // and the only terminal-shaped thing left on the Floor is an agent's workstream,
            // which is a rendered firehose and not a pty. Until that removal lands this stays
            // reachable by name so nobody is stranded mid-migration.
            return { view: 'grid' };
        case 'deck':
            // Also named. Per the spec board the Deck keeps Needs-you and the signal strip
            // and gives up its Agents band to the Dashboard.
            return { view: 'deck' };
        case 'dashboard':
            // The DEFAULT carries no params, so the url you land on stays clean. It must move
            // together with `parseViewRoute`'s default or the two halves of this module
            // disagree about what an empty url means.
            return {};
        case 'workbench':
            return { ws: view.workspaceId };
        case 'agent':
            return view.tab ? { agent: view.agentId, tab: view.tab } : { agent: view.agentId };
    }
}

/** The query keys this module OWNS. A closed list: everything else in the url
 *  belongs to whoever put it there and survives navigation untouched. */
const ROUTE_KEYS = ['view', 'ws', 'agent', 'tab'] as const;

/**
 * Rewrite only the ROUTE part of a url, preserving every other param.
 *
 * The master window does not start on a clean url. It is loaded with
 * `?stage=<workspaceId>` for a workspace-scoped window and `?host=<connKey>` for a
 * remote host window (`main/background.ts:720,780`). `host` in particular is bound
 * before load and decides whether the renderer's namespaces point at a remote
 * host at all — so navigating with `router.replace({ query: viewRouteQuery(v) })`
 * would drop it and silently turn a remote window into a local one. That failure
 * would look like "the remote window forgot where it was connected", which is a
 * long way from "we changed views".
 *
 * Unrecognised params are preserved verbatim, arrays included, so a param added
 * after this module was written is not collateral damage.
 */
export function mergeViewRoute(current: RouteQuery, view: GenieView): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(current)) {
        if ((ROUTE_KEYS as readonly string[]).includes(key)) continue;
        if (value !== undefined) out[key] = value;
    }
    return { ...out, ...viewRouteQuery(view) };
}

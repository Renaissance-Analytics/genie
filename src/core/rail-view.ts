/**
 * THE CHROME'S DECISIONS — the rail, the Deck badge, the four feature icons.
 *
 * ## Why there is a view-model for a navigation rail at all
 *
 * Because the rail makes claims. A number beside a workspace says *"this many agents are in
 * there"*, and a dot says *"something in here needs you"*. Both are assertions about state
 * Genie may not have read yet, and both have exactly the failure mode §5 is about: a `0` on
 * first paint that means "we have not looked" and reads as "it is empty".
 *
 * Navigation itself is not a decision — but what the rail *asserts* is, so it is decided here
 * and tested without a DOM.
 *
 * ## The rail is persistent and labelled, and ⌘K is an accelerator
 *
 * Stated here because it was the third failure of the previous attempt: navigation was
 * deleted and the command palette was called its replacement. A palette helps you find a
 * surface you already know exists; it cannot be the only route to the default screen. A
 * person given no instructions must reach the Dashboard without a keyboard shortcut.
 */

import type { AgentRow } from './dashboard-view.js';
import { processTitle, processTone, siteTitle, siteTone, workingAgents, type ProcessTone, type SiteTone } from './rail-indicators.js';

/** A workspace as the rail receives it. */
export interface RailWorkspace {
    id: string;
    path: string;
    /** The envelope's name (project.json), else the folder — never the id. */
    name?: string;
    /**
     * Whether Genie has actually read this workspace's agents.
     *
     * `false` is the launch state, and it is the whole reason this field exists: without it
     * "no agents yet read" and "no agents" are the same `0`.
     */
    agentsKnown: boolean;
    /** Hibernated: the rail says so and nothing starts here. */
    asleep?: boolean;
    /** Ops projects (§6.1): the workspaces this one governs, and the one that governs this one. */
    governs?: readonly string[];
    governedBy?: string | null;
}

export interface RailItem {
    id: string;
    path: string;
    /** The envelope's name, else the folder — never the id. */
    name?: string;
    /** `null` = not read yet. Renders nothing — never a `0`, and never a skeleton's leftovers. */
    count: number | null;
    /** `null` = not read yet. `false` = read, and nothing in here wants you. */
    alert: boolean | null;
    /** Present only on a governed workspace: the ops project it sits under. */
    governedBy?: string;
    /** Hibernated. The rail hides these unless the person asks to see them. */
    asleep?: boolean;
    /** GENIE 1'S ROW (core/rail-indicators.ts): agents mid-turn (`null` = not read yet), and the process / site tones. */
    working?: number | null;
    processes?: ProcessTone;
    processesTitle?: string;
    sites?: SiteTone | null;
    sitesTitle?: string;
}

/**
 * The workspace rows, in the order Genie was given them.
 *
 * **Not sorted.** The rail's order is the user's arrangement, and re-sorting it alphabetically
 * would move a workspace under the cursor between renders.
 *
 * The alert dot fires for **waiting and broken only**. Not for `remote`: a workstation being
 * offline is not work waiting on a human, and a dot that fires for it teaches the reader to
 * stop trusting the dot. That signal belongs on the Deck's strip, where it comes with a door.
 */
/** Governed workspaces follow their governor, in the given order; everyone else keeps their place. */
export function nestGoverned<T extends { id: string }>(items: readonly T[], governorOf: (id: string) => string | null): T[] {
    const ids = new Set(items.map((i) => i.id));
    const out: T[] = [];
    for (const item of items) {
        const governor = governorOf(item.id);
        if (governor !== null && ids.has(governor)) continue;
        out.push(item);
        for (const child of items) if (governorOf(child.id) === item.id) out.push(child);
    }
    return out;
}

function governorMap(workspaces: readonly RailWorkspace[]): (id: string) => string | null {
    const map = new Map<string, string>();
    for (const w of workspaces) {
        if (w.governedBy) map.set(w.id, w.governedBy);
        for (const child of w.governs ?? []) map.set(child, w.id);
    }
    return (id) => map.get(id) ?? null;
}

/** The workspace's runtime the row's indicators read: its background processes and its sites, each with its state. */
export interface RailRuntime {
    readonly processes: ReadonlyArray<{ readonly workspaceId: string; readonly state: string }>;
    readonly sites: ReadonlyArray<{ readonly workspaceId: string; readonly state: string }>;
}

export function railWorkspaces(
    workspaces: readonly RailWorkspace[],
    rows: readonly AgentRow[],
    runtime: RailRuntime = { processes: [], sites: [] },
): readonly RailItem[] {
    const governorOf = governorMap(workspaces);
    return nestGoverned(workspaces, governorOf).map((w) => {
        const governor = governorOf(w.id);
        const governed = governor !== null ? { governedBy: governor } : {};
        const named = w.name ? { name: w.name } : {};
        const asleep = w.asleep === true ? { asleep: true } : {};
        const indicators = {
            processes: processTone(runtime.processes, w.id),
            processesTitle: processTitle(runtime.processes, w.id),
            sites: siteTone(runtime.sites, w.id),
            sitesTitle: siteTitle(runtime.sites, w.id),
        };
        if (!w.agentsKnown) return { id: w.id, path: w.path, count: null, alert: null, working: null, ...indicators, ...named, ...governed, ...asleep };

        const mine = rows.filter((r) => r.workspaceId === w.id);
        return {
            id: w.id,
            path: w.path,
            ...named,
            count: mine.length,
            alert: mine.some((r) => r.state === 'waiting' || r.state === 'broken'),
            working: workingAgents(mine, w.id),
            ...indicators,
            ...governed,
            ...asleep,
        };
    });
}

/**
 * The Deck's count, or `null` for no badge.
 *
 * **The Deck is the only place a badge exists in Genie.** If a badge appears anywhere else,
 * the design has failed — which is also why the comms column's recency level deliberately
 * excludes Fancy's amber `unseen`.
 *
 * Zero produces no badge. A badge that is sometimes `0` is furniture, and furniture is what
 * people learn to stop reading; the Deck being empty is said by the Deck itself.
 */
export function deckBadge(waiting: number | null): number | null {
    if (waiting === null || waiting <= 0) return null;
    return waiting;
}

export interface FeatureIcon {
    label: string;
    icon: string;
    route: string;
}

/**
 * The four feature icons, in the title bar, right of the logo.
 *
 * **The owner's decision, and the one thing the design board does not carry** — the board
 * predates it. They match the bar's existing icon metrics.
 *
 * Every one has a label, and the label is not decoration: four unexplained glyphs in the
 * chrome is how a finished feature ships and nobody ever finds it. That is §0.4's entire
 * story — a Conversation UI that was built, shipped and unreachable.
 */
export const FEATURE_ICONS: readonly FeatureIcon[] = [
    { label: 'GApps', icon: 'layout-grid', route: 'genie://gapps' },
    { label: 'Knowledge Graph', icon: 'network', route: 'genie://knowledge' },
    { label: 'Flows', icon: 'workflow', route: 'genie://flows' },
    { label: 'Genie OSA', icon: 'sparkles', route: 'genie://agent/genie' },
];

/** Every surface a route can name. */
export type Surface = 'dashboard' | 'deck' | 'agent' | 'workspace' | 'takeover' | 'files' | 'knowledge' | 'flows' | 'hosting' | 'toolchain' | 'inbox' | 'settings' | 'browser';

/** The rail's fixed rows. */
export type RailSurface = 'deck' | 'dashboard' | 'genie' | 'hosting' | 'browser' | 'toolchain' | 'inbox' | 'workspace' | 'settings';

/**
 * Which rail rows a build can offer, DERIVED from which surfaces it can serve.
 *
 * One source of truth, and the reason is drift. Two lists — "surfaces the shell renders" and
 * "rows the rail shows" — have to be edited together, and the failure when they are not is
 * silent in both directions: a row that navigates to a surface the shell cannot render leaves
 * a blank body, and a surface that renders with no row is §0.4 again, built and unreachable.
 *
 * The `genie` row is the OS agent, so it rides the AGENT surface rather than one of its own.
 */
export function railSurfacesFor(servable: readonly Surface[]): readonly RailSurface[] {
    const rows: RailSurface[] = [];
    if (servable.includes('deck')) rows.push('deck');
    if (servable.includes('dashboard')) rows.push('dashboard');
    if (servable.includes('agent')) rows.push('genie');
    // Labelled rows, not palette-only (the owner, 2026-10-14: "WTF happened to all of our genie sites and bg processes
    // features?" — Hosting, Toolchain and AgentInbox were built, served, and reachable from nowhere).
    if (servable.includes('hosting')) rows.push('hosting');
    // The Genie Browser (the owner: "we are missing the Genie Browser for testing and access to sites").
    if (servable.includes('browser')) rows.push('browser');
    if (servable.includes('toolchain')) rows.push('toolchain');
    if (servable.includes('inbox')) rows.push('inbox');
    if (servable.includes('workspace')) rows.push('workspace');
    // Settings is a labelled route in the rail, not a palette-only surface (owner, 2026-10-12: "I have no menu to access my settings").
    if (servable.includes('settings')) rows.push('settings');
    return rows;
}


/**
 * The workspace rows a filter leaves (Tynn #282, Genie 1's "Search workspaces…"): the name or the path containing the
 * query, any case; a blank query keeps every row. Order kept.
 */
export function filterRail<T extends { readonly name?: string | undefined; readonly path: string }>(items: readonly T[], query: string): T[] {
    const q = query.trim().toLowerCase();
    if (q === '') return [...items];
    return items.filter((w) => (w.name ?? '').toLowerCase().includes(q) || w.path.toLowerCase().includes(q));
}

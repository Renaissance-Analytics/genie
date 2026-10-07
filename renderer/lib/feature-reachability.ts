/**
 * NO FEATURE BECOMES UNREACHABLE.
 *
 * The Genie 2 plan (P7) deletes eight title-bar icons on the promise that those features
 * "survive as ⌘K entries, plus contextual entry points", and summarises it as
 * "8 icons → 0 icons, 0 features lost".
 *
 * **Measured 2026-10-05, that promise did not hold.** Every feature is reached through an
 * `onShow*` prop on the title bar (`master.tsx:4316-4515`). The command palette
 * (`GenieCommandWindow`, Tynn #247) does exist — but
 *
 *   1. it opens only "while a terminal panel has focus" (`master.tsx:3086`), and the Deck
 *      focuses no terminal, so under Genie 2 it would never open at all; and
 *   2. its items are workspaces, terminals and prompts. It carries **no feature entries**.
 *
 * Deleting the icons in that state would have stranded Sharing, Sites, IssueWatch, Flows,
 * AppStore and Knowledge. This module exists so CI refuses to let that happen, instead of
 * a plan asserting it won't.
 *
 * ## Why it is shaped this way
 *
 * `FEATURE_SURFACES` is a hand-written CONTRACT. The entry points are DISCOVERED by
 * reading the real source. Deriving both from the same place would make the guard
 * circular — it would agree with whatever the code currently does, which is precisely the
 * failure mode of a test written after the fact. To drop a feature you must edit this
 * list, in a diff a human reads.
 */

export interface FeatureSurface {
    /** Stable id, used by the test and by nothing else. */
    id: string;
    /** What a person calls it. Appears in the failure message. */
    label: string;
    entry: {
        /** An `onShow*` prop on the title bar. */
        titleBarProp?: string;
        /** An id the command palette offers. */
        paletteId?: string;
        /**
         * A path a test cannot verify ("right-click a workspace row").
         *
         * Deliberately NOT sufficient on its own. If a bare `contextual` counted, anyone
         * deleting an icon could add one and go green — the guard would become a rubber
         * stamp for exactly the change it exists to catch. It is documentation that must
         * accompany a real, checkable entry point.
         */
        contextual?: string;
    };
}

/**
 * The features that must stay reachable.
 *
 * Owner direction 2026-10-05: *"make sure we are retaining much of our current feature
 * set. The remote/host feature is super important and our plugins and other features like
 * the knowledge graph, agent inbox etc."* Those four are called out in the test by id so
 * a future edit cannot quietly drop them.
 */
export const FEATURE_SURFACES: readonly FeatureSurface[] = [
    // ─── The owner's named four ───────────────────────────────────────────────────────
    {
        id: 'remote-host',
        label: 'Remote / Work Mode hosts',
        // The safest of the four: its own subsystem (`api().workmode.discoverHosts()`),
        // not in P7's deletion list. It needs a home on the Deck, nothing more.
        entry: { titleBarProp: 'onShowSharing', contextual: 'Settings → hosts; workmode discovery' },
    },
    { id: 'plugins-appstore', label: 'Plugins / App Store', entry: { titleBarProp: 'onShowAppStore' } },
    { id: 'knowledge-graph', label: 'Knowledge graph', entry: { titleBarProp: 'onShowKnowledge' } },
    {
        id: 'agent-inbox',
        label: 'AgentInbox',
        // P7 RESTRUCTURES rather than deletes: agent↔agent channels stay (observing a
        // conversation you are not in is genuinely different), human↔agent DMs fold into
        // the Agent Conversation. Either way it must stay reachable.
        entry: { titleBarProp: 'onShowAgentInbox' },
    },

    // ─── The rest of today's surfaces ─────────────────────────────────────────────────
    { id: 'sharing', label: 'Sharing', entry: { titleBarProp: 'onShowSharing' } },
    { id: 'sites', label: 'Site Manager', entry: { titleBarProp: 'onShowSiteManager' } },
    { id: 'issuewatch', label: 'IssueWatch', entry: { titleBarProp: 'onShowIssueWatch' } },
    { id: 'flows', label: 'Flows', entry: { titleBarProp: 'onShowFlows' } },
    { id: 'lists', label: 'Lists', entry: { titleBarProp: 'onShowLists' } },
    {
        id: 'questions',
        label: 'Question inbox',
        // P7: title-bar icon REMOVED. The Deck owns this queue now -- it is the only place
        // badges exist -- and the palette is how you reach the flyout.
        entry: { paletteId: 'questions', contextual: 'Deck → Needs you' },
    },
    { id: 'docs', label: 'Docs', entry: { titleBarProp: 'onShowDocs' } },
    { id: 'processes', label: 'Process manager', entry: { titleBarProp: 'onShowProcessManager' } },
    {
        id: 'tasks',
        label: 'Task manager',
        // P7: title-bar icon REMOVED. WorkspaceProcessManager already owns processes; the
        // palette is how you reach this view.
        entry: { paletteId: 'tasks', contextual: 'Workspace → processes' },
    },
    { id: 'github-caps', label: 'GitHub capabilities', entry: { titleBarProp: 'onShowGithubCaps' } },
    { id: 'genie-os', label: 'Genie OS', entry: { titleBarProp: 'onShowGenieOs' } },

    /**
     * THE GRID ITSELF — the surface this whole contract was protecting other things from
     * losing, and the one it did not cover.
     *
     * Genie 2 made the Deck the default (`parseViewRoute({})` → `{kind:'deck'}`). The plan
     * justified that with *"the grid is one query away and loses nothing"*, and measured on
     * 2026-10-06 it was EXACTLY one query away and nothing else: no title-bar control, no
     * keyboard shortcut, no palette row, no link on the Deck. `?view=grid` in a desktop app
     * with no address bar is not a route a person has.
     *
     * So the 2×2 Floor that every existing user opens Genie to see became unreachable the
     * moment the default flipped — a feature lost by the very change this module was added
     * to make safe. It was missed because the contract was written for the eight title-bar
     * ICONS of P7, and a SURFACE becoming unreachable is not an icon being deleted.
     *
     * Registered here so it is covered by the same guard as everything else, and so the
     * palette carries it like any other feature.
     */
    { id: 'grid', label: 'The grid (all workspaces)', entry: { paletteId: 'grid' } },
];

export interface FoundEntryPoints {
    titleBarProps: ReadonlySet<string>;
    paletteIds: ReadonlySet<string>;
}

/**
 * Scan real source for the entry points that exist.
 *
 * Caller normalises CRLF before handing source in — genie#517 is this repo's source
 * guards going quietly inert on `\r\n`, and `master.tsx` is a CRLF file.
 */
export function entryPointsInSource(src: string): FoundEntryPoints {
    const titleBarProps = new Set<string>();
    for (const m of src.matchAll(/\bonShow([A-Z][A-Za-z]*)\b/g)) {
        titleBarProps.add(`onShow${m[1]}`);
    }

    // Feature entries the palette offers. The palette takes `workspaces`, `terminals` and
    // `prompts` today and nothing else, so this is empty — which is the measured fact that
    // makes P7 unsafe until the palette is widened. When it is, entries will be declared
    // as `featureId: '…'` and picked up here.
    const paletteIds = new Set<string>();
    for (const m of src.matchAll(/featureId:\s*'([a-z0-9-]+)'/g)) {
        paletteIds.add(m[1]);
    }

    return { titleBarProps, paletteIds };
}

/** Every contracted feature with no entry point a test can actually verify. */
export function unreachableFeatures(
    features: readonly FeatureSurface[],
    found: FoundEntryPoints,
): FeatureSurface[] {
    return features.filter((f) => {
        const byIcon = !!f.entry.titleBarProp && found.titleBarProps.has(f.entry.titleBarProp);
        const byPalette = !!f.entry.paletteId && found.paletteIds.has(f.entry.paletteId);
        // `contextual` is never counted — see the note on the field.
        return !byIcon && !byPalette;
    });
}

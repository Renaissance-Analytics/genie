/**
 * ONE DRAWER AT A TIME — P7's *"one `Drawer` with a single `openDrawer: DrawerId | null`, making
 * two-open-at-once structurally impossible"*.
 *
 * ## What this replaces
 *
 * Fourteen independent `useState` booleans, OR-ed by hand in `master.tsx` to answer one question:
 *
 * ```ts
 * overlayOpen: sharingOpen || paletteOpen || recipeLauncherOpen || onboardingOpen || genieOsOpen
 *   || docsOpen || issueWatchOpen || taskManagerOpen || agentInboxOpen || flowsOpen
 *   || questionsOpen || listsOpen || appStoreOpen || githubCapsOpen,
 * ```
 *
 * The file says what is wrong with that in its own words: *"it reads as a list because that is
 * genuinely the state today… until then an incomplete OR is the honest risk — a missing flag means
 * Escape navigates out from under an open panel."* Fourteen flags maintained by hand, and the cost
 * of forgetting one is silent.
 *
 * ## NOT EVERYTHING IS A DRAWER, and that is the owner's ruling
 *
 * Asked directly about the Lists dock, the answer was **"a pinned dock is NOT a drawer"**: the
 * refactor governs the flyouts, and a pinned panel stays a layout state outside it, because *a pin
 * exists so the panel stays up while you work* — exclusivity would make it useless, which is the one
 * thing a pin is for.
 *
 * That reasoning does not stop at Lists, and following it is what keeps this from breaking two other
 * things:
 *
 *  - **The palette is not a drawer.** genie#820 was exactly about ⌘K needing to open OVER a flyout
 *    (it was painting under the scrim and silently unclickable). Making them mutually exclusive would
 *    close your panel the moment you reached for the command window — a regression in feel, dressed
 *    as a structural improvement.
 *  - **First run is not a drawer.** It opens by itself on an empty workstation; a flyout closing it
 *    would be a flyout cancelling onboarding.
 *  - **The recipe launcher is not a drawer** — it is a modal raised from a workspace row, and nothing
 *    about it reserves gutter space or competes for the right edge.
 *
 * So `openDrawer` is the single source of truth for the eleven RIGHT-EDGE panels, and the three
 * surfaces above keep their own state deliberately. `overlayOpen` then becomes one comparison plus
 * those three, which is four terms that cannot silently grow rather than fourteen that can.
 */

/** The right-edge panels, exactly one of which may be open. */
export const DRAWER_IDS = [
    'sharing',
    'genie-os',
    'docs',
    'issuewatch',
    'tasks',
    'agent-inbox',
    'flows',
    'questions',
    'lists',
    'appstore',
    'github-caps',
    /** Chat (§5.4) — a drawer like the rest, and DOCKABLE on top of that; see
     *  {@link DOCKABLE}. The file panel (§5.3) joins when it is built. */
    'chat',
] as const;

export type DrawerId = (typeof DRAWER_IDS)[number];

/**
 * THE PANELS THAT MAY BE DOCKED — and there is ONE slot for them.
 *
 * §0.3 of the agent-surfaces design, and the generalisation of the owner's ruling on the
 * Lists panel: *"a pinned dock is NOT a drawer."* Lists was the only pinnable panel, so its
 * state was a boolean. §5.4 adds a pinnable chat and §5.3 a pinnable file panel, and two
 * booleans would make "both pinned" REPRESENTABLE — three panels competing for the right edge,
 * each reserving its own gutter.
 *
 * So the slot is a value, exactly as `openDrawer` replaced eleven booleans and for the same
 * reason: the illegal state stops being merely absent and becomes unrepresentable. The owner
 * already supplied the escape valve for wanting two at once — the file panel pops into its own
 * window.
 */
export const DOCKABLE = ['lists', 'chat'] as const;
// `files` (§5.3) joins this list WITH the panel, not before it. Listing it early failed the
// dock-width guard — a dockable id with no panel and no `--dock-w` rule would reserve nothing
// and the dock would sit on the content, which is genie#841's failure mode exactly. The guard
// reads this constant, so the list and the stylesheet cannot drift.

export type DockId = (typeof DOCKABLE)[number];

/**
 * What the dock slot becomes when the pin on `id` is pressed.
 *
 * A TOGGLE, because the pin is one button: pressing the pin of the panel already docked
 * undocks it. A pin that cannot unpin is a dead control the moment it is pressed, which is
 * exactly what the Lists header icon was while the panel was docked (genie#589).
 */
export function pinDockNext(pinnedDock: DockId | null, id: DockId): DockId | null {
    return pinnedDock === id ? null : id;
}

/**
 * Is `id` actually DOCKED — pinned AND open?
 *
 * Both halves, because pinned-but-closed reserves nothing. The old `listsPinned` meant "when
 * it shows, dock it rather than float it" — a preference, not a state — and conflating the two
 * is what made the header icon toggle something nothing rendered.
 */
export function isDocked(pinnedDock: DockId | null, openDrawer: DrawerId | null): boolean {
    return pinnedDock !== null && openDrawer === pinnedDock;
}

/**
 * Is this drawer the open one?
 *
 * A function rather than `openDrawer === id` at each site, so the comparison cannot drift and the
 * PINNED exception has one home — see `isDrawerOpen`'s `pinned` argument.
 */
export function isDrawerOpen(openDrawer: DrawerId | null, id: DrawerId): boolean {
    return openDrawer === id;
}

/**
 * Open `id`, closing whatever was open. The whole point: there is no state in which two are open.
 *
 * Returns the next value rather than mutating, so it is testable without React and so the caller's
 * `setOpenDrawer` stays the only writer.
 */
export function openDrawerNext(id: DrawerId): DrawerId | null {
    return id;
}

/**
 * Close `id` — but only if it is the one open.
 *
 * The guard matters: a panel's `onClose` can fire after something else has taken the slot (a backdrop
 * click racing a ⌘K-driven feature activation, a React cleanup running late). Closing
 * unconditionally would shut the NEW panel, which reads as "the thing I just opened flickered and
 * vanished" and is the kind of bug nobody can reproduce on demand.
 */
export function closeDrawerNext(openDrawer: DrawerId | null, id: DrawerId): DrawerId | null {
    return openDrawer === id ? null : openDrawer;
}

/**
 * Does something cover the Floor right now — the question `escapeLeavesForDeck` actually asks.
 *
 * A PINNED Lists panel does NOT count, and that is the ruling made concrete: it reserves gutter
 * space beside the content rather than covering it (`master.css`: the reserve is there *"so a pinned
 * panel covers nothing"*), so Escape should leave for the Deck exactly as it would with no panel at
 * all. Treating it as an overlay would trap Escape behind a panel the person deliberately docked.
 *
 * The three non-drawers are passed explicitly instead of being folded in, so adding a fourth is a
 * type error here rather than a forgotten clause in a fourteen-term OR.
 */
export function somethingCoversTheFloor(input: {
    openDrawer: DrawerId | null;
    pinnedDock: DockId | null;
    paletteOpen: boolean;
    onboardingOpen: boolean;
    recipeLauncherOpen: boolean;
}): boolean {
    const { openDrawer, pinnedDock, paletteOpen, onboardingOpen, recipeLauncherOpen } = input;
    /**
     * A DOCKED panel sits beside the content, not over it — whichever panel it is.
     *
     * This used to name Lists specifically. Generalising it is what stops the chat flyout
     * inheriting a bug the Lists panel already had fixed: a pin exists so the panel stays up
     * WHILE you work, so it must not be the thing that makes Escape navigate out from under
     * you. Unpinned, the same panel DOES overlay — the board says so, with a shadow and Esc to
     * close — so it counts then.
     */
    const drawerCovers = openDrawer !== null && !isDocked(pinnedDock, openDrawer);
    return drawerCovers || paletteOpen || onboardingOpen || recipeLauncherOpen;
}

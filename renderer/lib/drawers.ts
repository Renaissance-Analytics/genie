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
] as const;

export type DrawerId = (typeof DRAWER_IDS)[number];

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
    listsPinned: boolean;
    paletteOpen: boolean;
    onboardingOpen: boolean;
    recipeLauncherOpen: boolean;
}): boolean {
    const { openDrawer, listsPinned, paletteOpen, onboardingOpen, recipeLauncherOpen } = input;
    // A pinned Lists panel is docked beside the content, not over it.
    const drawerCovers = openDrawer !== null && !(openDrawer === 'lists' && listsPinned);
    return drawerCovers || paletteOpen || onboardingOpen || recipeLauncherOpen;
}

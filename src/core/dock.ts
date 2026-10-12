/**
 * THE DOCK — one slot, one width, and a geometry with three shipped failures behind it.
 *
 * ## The width is ONE token, read by both sides
 *
 * The reserve the content row gives up and the width the panel occupies are the same number.
 * **Two numbers is a panel overlapping the content by their difference** — which is exactly
 * what shipped, twice, and the second time it was a three-pixel overlap nobody could name.
 *
 * ## Where the reserve goes, and the three places it must not
 *
 * The reserve is a **`margin` on the content row**. Never:
 *
 *  - **`padding`** — the content then sizes to the padded box and its own borders and
 *    backgrounds run under the panel;
 *  - **on the outer wrapper** — that narrows the view HEADER too, and the header is supposed
 *    to keep its width and position when a panel pins. The design is explicit: the gutter
 *    starts *below* the header;
 *  - **on a `flex: 1` column** — measured: this squeezed the left rail from 300px to 163px,
 *    because a flex child with a margin gives up basis, not slack.
 *
 * That is why this is a module with tests rather than a CSS class: the rule is three
 * prohibitions deep and every one of them has already cost a release.
 */

/** The dock's width, in pixels. The single source for the panel AND for the reserve. */
export const DOCK_WIDTH = 380;

export type DockPanel = 'chat' | 'files' | 'lists';

/**
 * The reserve the content row gives up, in pixels.
 *
 * `0` when nothing is pinned — and an UNPINNED panel reserves nothing: it overlays the right
 * edge with a shadow and **nothing underneath moves**. That is the whole difference between
 * the two states, and the reason a pin is worth having.
 */
export function dockReserve(pinned: DockPanel | null): number {
    return pinned === null ? 0 : DOCK_WIDTH;
}

export interface PinOutcome {
    /** What ends up pinned. */
    pinned: DockPanel | null;
    /** What was displaced, so the UI can show the handoff rather than closing it silently. */
    replaced: DockPanel | null;
    /** Set when the request was REFUSED, with the reason to show. */
    refused: string | null;
}

/**
 * Pin a panel into the single dock slot.
 *
 * **At most one of {chat, files, lists} is pinned.** Pinning a second **replaces** the first,
 * and the replacement is reported so the UI can show a handoff — the displaced panel's pin
 * lamp going out — rather than a silent close. A panel that vanishes without a visible cause
 * reads as a bug every time.
 *
 * **One exception: a file panel with unsaved edits refuses to be replaced.** It says so and
 * offers pop-out. Nothing a person typed is discarded to make room for a panel.
 *
 * Pinning what is already pinned UNPINS it, because the control is a toggle and a toggle that
 * does nothing on the second press is a control people press twice.
 */
export function pinPanel(
    current: DockPanel | null,
    requested: DockPanel,
    filesHaveUnsavedEdits: boolean,
): PinOutcome {
    if (current === requested) return { pinned: null, replaced: null, refused: null };

    if (current === 'files' && filesHaveUnsavedEdits) {
        return {
            pinned: current,
            replaced: null,
            refused: 'The file panel has unsaved edits. Save them, or pop the panel out to keep both.',
        };
    }

    return { pinned: requested, replaced: current, refused: null };
}

/**
 * THE ROUTE AFTER A PIN (§4.4): `?pin=right` says the CHAT is pinned. When pinning the file panel displaces the chat,
 * the route stops saying so — a stale `pin=right` would reopen the chat pinned on the next navigation and undo the
 * handoff the user just watched. Anything that leaves the chat alone leaves the route alone.
 */
export function routeAfterPin(route: string, outcome: PinOutcome): string {
    if (outcome.replaced !== 'chat') return route;
    return route.replace(/([?&])pin=right(&|$)/, (_m, lead: string, tail: string) => (tail === '&' ? lead : '')).replace(/\?$/, '');
}

/**
 * Whether chat and files can be pinned side by side. **They cannot.**
 *
 * Both at once means popping the file panel out into its own window: a 170px tree beside a
 * 170px chat is two useless panels, and splitting the dock is how a layout becomes something
 * nobody can use at any width.
 */
export const DOCK_SLOTS = 1;

/**
 * THE DOCK'S NOTICE (§4.4): what the shell says under the title bar after a pin — the handoff (which panel moved out,
 * which took the slot) or the refusal (the file panel's unsaved edits, with the pop-out offer). One line with a door;
 * never a silent change, never a modal.
 */
export type DockNotice =
    | { kind: 'replaced'; replaced: DockPanel; pinned: DockPanel | null }
    | { kind: 'refused'; reason: string; workspaceId: string | null };

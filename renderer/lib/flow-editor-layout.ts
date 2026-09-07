/**
 * How much of the Flow editor fits, at the width the editor actually has.
 *
 * fancy-flow lays `.ff-editor` out as `grid-template-columns: 216px 1fr 300px`
 * — two FIXED columns with the canvas as the `1fr` between them — so the canvas
 * is the only element that yields, and it yields all the way to nothing. That is
 * the owner's screenshot: a graph squeezed to a sliver between a full palette
 * and a full config panel.
 *
 * The package's own answer is two media queries that `display: none` the panel
 * below 1024px and the palette below 720px. Genie cannot use them, for two
 * reasons that are both about the same mistake:
 *
 *  - they measure the VIEWPORT. The editor is not the window. It is a tab inside
 *    a GApp window, or the body of its own window with chrome around it, so the
 *    query fires against a width the editor never had — early in one direction,
 *    late in the other;
 *  - they are one-way. A hidden palette is a palette you cannot drag a node
 *    from, and nothing offers to bring it back. Removing the only way to add a
 *    step is not a responsive layout, it is a smaller broken one.
 *
 * So the decision is made here, from a measured CONTAINER width, and a pane that
 * leaves the grid comes back as an overlay over the canvas.
 *
 * Pure and DOM-free on purpose: the renderer has no jsdom harness, and this is
 * the part worth asserting. The wiring — a ResizeObserver and two props — is
 * the part a test could only restate.
 */

/** The palette column fancy-flow reserves. */
export const FLOW_PALETTE_WIDTH = 216;
/** The config panel column fancy-flow reserves. */
export const FLOW_PANEL_WIDTH = 300;
/**
 * What the canvas keeps, always.
 *
 * The breakpoints below are DERIVED from this rather than chosen: a pane may
 * dock only while the canvas still has this much left after it. That is the
 * whole rule — "the canvas must not be the only element that yields" — written
 * as a number instead of as an intention.
 */
export const FLOW_CANVAS_MIN_WIDTH = 520;

/** A pane is either in the grid, or floating over the canvas on demand. */
export type FlowPaneFit = 'docked' | 'overlay';
export type FlowPaneName = 'palette' | 'panel';

export interface FlowEditorLayout {
    palette: FlowPaneFit;
    panel: FlowPaneFit;
    /** `grid-template-columns` for `.ff-editor` — the DOCKED panes only. */
    columns: string;
    /** What the canvas is left with once the docked panes have taken theirs. */
    canvasWidth: number;
}

/** Both panes docked need this much before the canvas gets its minimum. */
const DOCK_BOTH_AT = FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH + FLOW_PANEL_WIDTH;
/** The palette alone needs this much. */
const DOCK_PALETTE_AT = FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH;

/**
 * The panes that fit at `width`.
 *
 * The config panel is dropped BEFORE the palette. Both matter, but a canvas with
 * no palette cannot be added to at all, while a canvas with no config panel is
 * still a canvas you can draw on and configure a moment later.
 *
 * `width <= 0` means nobody has measured yet — the first frame, before the
 * ResizeObserver fires. That is read as "wide enough", because guessing narrow
 * would slam both panes shut on every open of a full-size window and then flap
 * them back a frame later.
 */
export function flowEditorLayout(width: number): FlowEditorLayout {
    const measured = width > 0 ? width : DOCK_BOTH_AT;

    if (measured >= DOCK_BOTH_AT) {
        return {
            palette: 'docked',
            panel: 'docked',
            columns: `${FLOW_PALETTE_WIDTH}px 1fr ${FLOW_PANEL_WIDTH}px`,
            canvasWidth: measured - FLOW_PALETTE_WIDTH - FLOW_PANEL_WIDTH,
        };
    }
    if (measured >= DOCK_PALETTE_AT) {
        return {
            palette: 'docked',
            panel: 'overlay',
            columns: `${FLOW_PALETTE_WIDTH}px 1fr`,
            canvasWidth: measured - FLOW_PALETTE_WIDTH,
        };
    }
    // Nothing left to yield: the canvas takes the lot and is honestly reported
    // as under its minimum rather than pretending a 400px container holds 520.
    return { palette: 'overlay', panel: 'overlay', columns: '1fr', canvasWidth: measured };
}

/**
 * The panes with no column of their own at this width — the ones that need a
 * way back, or the layout is amputated rather than responsive.
 */
export function flowPaneToggles(width: number): FlowPaneName[] {
    const at = flowEditorLayout(width);
    const toggles: FlowPaneName[] = [];
    if (at.palette === 'overlay') toggles.push('palette');
    if (at.panel === 'overlay') toggles.push('panel');
    return toggles;
}

export interface FlowEditorPanes {
    /** `showPalette` for `<FlowEditor>` — docked, or floating and open. */
    showPalette: boolean;
    /** `showPanel` for `<FlowEditor>`. */
    showPanel: boolean;
    /** `grid-template-columns` for the editor root. */
    columns: string;
    /** The pane currently floating over the canvas, if any. */
    overlay: FlowPaneName | null;
}

/**
 * What to render, given the width and which undocked pane the user has opened.
 *
 * `opened` is a single pane rather than a set, deliberately: the canvas is
 * UNDERNEATH an overlay, and two overlays at a narrow width would cover the
 * thing they exist to let you edit.
 *
 * An `opened` pane that has since become docked is not "still open" — it is
 * simply docked, and nothing floats. That keeps a stale toggle from leaving a
 * pane positioned over a canvas that has room for it.
 */
export function flowEditorPanes(width: number, opened: FlowPaneName | null): FlowEditorPanes {
    const at = flowEditorLayout(width);
    const floating = opened && at[opened] === 'overlay' ? opened : null;
    return {
        showPalette: at.palette === 'docked' || floating === 'palette',
        showPanel: at.panel === 'docked' || floating === 'panel',
        columns: at.columns,
        overlay: floating,
    };
}

/** The human label for a pane, used by the toolbar toggle and its title. */
export function flowPaneLabel(pane: FlowPaneName): string {
    return pane === 'palette' ? 'Steps' : 'Configure';
}

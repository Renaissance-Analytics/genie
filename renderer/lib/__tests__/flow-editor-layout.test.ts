import { describe, expect, it } from 'vitest';
import {
    FLOW_CANVAS_MIN_WIDTH,
    FLOW_PALETTE_WIDTH,
    FLOW_PANEL_WIDTH,
    flowEditorLayout,
    flowEditorPanes,
    flowPaneToggles,
} from '../flow-editor-layout';

/**
 * The editor's panes, at whatever width the container turns out to be.
 *
 * ## The bug this is the standing answer to
 *
 * fancy-flow lays `.ff-editor` out as `grid-template-columns: 216px 1fr 300px`
 * — two FIXED columns with the canvas as the `1fr` between them. So the canvas
 * is the only element that yields, and it yields all the way to nothing: the
 * owner's screenshot is a graph squeezed between a full palette and a full
 * config panel.
 *
 * The package's own answer is two viewport media queries that `display: none`
 * the panel below 1024px and the palette below 720px. That is the wrong axis and
 * a dead end in both directions:
 *
 *  - VIEWPORT, not container. The editor is not the window — it is a tab in a
 *    GApp window, or the body of its own window with chrome around it — so the
 *    query fires against a width the editor never had.
 *  - No way BACK. A hidden palette is a palette you cannot drag a node from, and
 *    nothing in the editor offers to bring it back. "Responsive" that removes
 *    the only way to add a step is not responsive, it is broken smaller.
 *
 * So Genie decides this itself, from the width the editor actually measures, and
 * the panes it takes out of the grid come back as OVERLAYS over the canvas.
 *
 * ## Why the breakpoints are derived rather than chosen
 *
 * A number picked by eye is a number nobody can defend when the next screenshot
 * arrives. These come out of the constraint the owner's bug is about: THE CANVAS
 * KEEPS A USABLE MINIMUM, and the panes yield around it. A pane may dock only
 * while the canvas still has {@link FLOW_CANVAS_MIN_WIDTH} left after it.
 */

describe('what the editor keeps at a given width', () => {
    it('POSITIVE CONTROL: the widths are real numbers in the right order', () => {
        // Every assertion below is arithmetic on these three. If they were
        // zero, or the canvas minimum were smaller than a pane, the breakpoints
        // would still "pass" and mean nothing.
        expect(FLOW_PALETTE_WIDTH).toBeGreaterThan(100);
        expect(FLOW_PANEL_WIDTH).toBeGreaterThan(FLOW_PALETTE_WIDTH);
        expect(FLOW_CANVAS_MIN_WIDTH).toBeGreaterThan(FLOW_PANEL_WIDTH);
    });

    it('docks both panes when the canvas still clears its minimum', () => {
        const wide = FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH + FLOW_PANEL_WIDTH;
        const at = flowEditorLayout(wide);

        expect(at.palette).toBe('docked');
        expect(at.panel).toBe('docked');
        expect(at.columns).toBe(`${FLOW_PALETTE_WIDTH}px 1fr ${FLOW_PANEL_WIDTH}px`);
        expect(at.canvasWidth).toBe(FLOW_CANVAS_MIN_WIDTH);
    });

    it('drops the config panel out of the grid one pixel below that', () => {
        const at = flowEditorLayout(
            FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH + FLOW_PANEL_WIDTH - 1,
        );

        // The panel goes first, not the palette: without a palette there is no
        // way to put a node on the canvas at all, and a canvas you cannot add to
        // is not an editor.
        expect(at.panel).toBe('overlay');
        expect(at.palette).toBe('docked');
        expect(at.columns).toBe(`${FLOW_PALETTE_WIDTH}px 1fr`);
    });

    it('drops the palette too once even that leaves the canvas short', () => {
        const at = flowEditorLayout(FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH - 1);

        expect(at.palette).toBe('overlay');
        expect(at.panel).toBe('overlay');
        expect(at.columns).toBe('1fr');
    });

    it('never lets the canvas be the element that yields', () => {
        // The property the whole module exists for, asserted across the range
        // rather than at the two edges a breakpoint test would cover. Above the
        // minimum, the canvas has the minimum — whatever the panes cost.
        for (let w = FLOW_CANVAS_MIN_WIDTH; w <= 2200; w += 7) {
            expect(
                flowEditorLayout(w).canvasWidth,
                `at ${w}px the canvas is squeezed below its minimum`,
            ).toBeGreaterThanOrEqual(FLOW_CANVAS_MIN_WIDTH);
        }
    });

    it('reports the canvas honestly when the container is smaller than the minimum', () => {
        // 400px cannot hold 520px of canvas and nothing here should pretend it
        // can. What it CAN do is spend all 400 on the canvas — which is what
        // "the panes yield first" means once there is nothing left to yield.
        const at = flowEditorLayout(400);
        expect(at.canvasWidth).toBe(400);
        expect(at.columns).toBe('1fr');
    });

    it('treats an unmeasured container as wide rather than collapsing it', () => {
        // A ResizeObserver has not fired yet on the first frame. Guessing
        // "narrow" would flash both panes shut on every open of a full-size
        // window, which is the more visible wrong answer.
        expect(flowEditorLayout(0).palette).toBe('docked');
        expect(flowEditorLayout(0).panel).toBe('docked');
    });
});

describe('what is actually rendered, and the way back to a hidden pane', () => {
    const WIDE = FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH + FLOW_PANEL_WIDTH + 200;
    const NARROW = FLOW_CANVAS_MIN_WIDTH;

    it('renders both panes docked at a wide width, with nothing floating', () => {
        // POSITIVE CONTROL for every absence asserted below: a component that
        // rendered no panes at all would satisfy "the palette is hidden at
        // 600px" perfectly.
        const panes = flowEditorPanes(WIDE, null);
        expect(panes.showPalette).toBe(true);
        expect(panes.showPanel).toBe(true);
        expect(panes.overlay).toBeNull();
        expect(flowPaneToggles(WIDE)).toEqual([]);
    });

    it('hides an undocked pane until it is asked for', () => {
        const shut = flowEditorPanes(NARROW, null);
        expect(shut.showPalette).toBe(false);
        expect(shut.showPanel).toBe(false);

        const open = flowEditorPanes(NARROW, 'palette');
        expect(open.showPalette).toBe(true);
        expect(open.overlay).toBe('palette');
        // It floats OVER the canvas — the columns are the docked panes only, so
        // an overlaid pane costs the canvas nothing.
        expect(open.columns).toBe('1fr');
    });

    it('offers a toggle for exactly the panes that are not docked', () => {
        // Without this the narrow layout is not responsive, it is amputated.
        expect(flowPaneToggles(NARROW)).toEqual(['palette', 'panel']);
        expect(flowPaneToggles(FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH)).toEqual(['panel']);
    });

    it('floats only one pane at a time, because the canvas is underneath', () => {
        const panes = flowEditorPanes(NARROW, 'panel');
        expect(panes.showPanel).toBe(true);
        expect(panes.showPalette).toBe(false);
        expect(panes.overlay).toBe('panel');
    });

    it('ignores a stale open pane once the width docks it again', () => {
        // The container grew while the palette overlay was open. It is docked
        // now, so nothing should still be floating over the canvas.
        const panes = flowEditorPanes(WIDE, 'palette');
        expect(panes.showPalette).toBe(true);
        expect(panes.overlay).toBeNull();
    });
});

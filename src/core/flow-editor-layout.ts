/**
 * THE FLOW EDITOR MEASURES ITSELF (genie#505, ported from Genie 1's renderer/lib/flow-editor-layout.ts at
 * v0.7.0-beta.342). Genie 1 first put the canvas in a modal card that clipped it; the fix was a window of its own whose
 * editor lays its panes out from its OWN width — fancy-flow's media queries ask the viewport, which is the wrong question.
 * Wide: palette, canvas and inspector side by side. Narrower: the inspector yields, then the palette, so the canvas never
 * drops under its minimum; a pane that yielded comes back on request (a toolbar toggle), one at a time.
 *
 * Unlike Genie 1, a pane brought back DOCKS (its grid track returns) rather than floating over the canvas: no positioned
 * overlay to keep in step with fancy-flow's own grid.
 */

export const FLOW_PALETTE_WIDTH = 216;
export const FLOW_PANEL_WIDTH = 300;
export const FLOW_CANVAS_MIN_WIDTH = 520;

export type FlowPaneName = 'palette' | 'panel';

const DOCK_BOTH_AT = FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH + FLOW_PANEL_WIDTH;
const DOCK_PALETTE_AT = FLOW_CANVAS_MIN_WIDTH + FLOW_PALETTE_WIDTH;

export interface FlowEditorPanes {
    readonly showPalette: boolean;
    readonly showPanel: boolean;
    /** `grid-template-columns` for the editor root: the shown panes' tracks around the canvas's `1fr`. */
    readonly columns: string;
    /** The panes that yielded at this width — each gets a toolbar toggle. */
    readonly toggles: readonly FlowPaneName[];
}

/** `width` = the editor's own measured width (0 = not measured yet: laid out as wide). `opened` = a yielded pane asked back. */
export function flowEditorPanes(width: number, opened: FlowPaneName | null): FlowEditorPanes {
    const w = width > 0 ? width : DOCK_BOTH_AT;
    const dockedPalette = w >= DOCK_PALETTE_AT;
    const dockedPanel = w >= DOCK_BOTH_AT;
    const toggles: FlowPaneName[] = [...(dockedPalette ? [] : ['palette' as const]), ...(dockedPanel ? [] : ['panel' as const])];
    const showPalette = dockedPalette || opened === 'palette';
    // One yielded pane at a time: asking for the inspector on a narrow editor puts the palette away.
    const showPanel = dockedPanel || opened === 'panel';
    const palette = showPalette && !(opened === 'panel' && !dockedPalette);
    return { showPalette: palette, showPanel, columns: [palette ? 'auto' : null, '1fr', showPanel ? 'auto' : null].filter(Boolean).join(' '), toggles };
}

export function flowPaneLabel(pane: FlowPaneName): string {
    return pane === 'palette' ? 'Steps' : 'Configure';
}

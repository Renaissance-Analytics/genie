// RED-PHASE STUB (genie#1204).
export type FlowPaneName = 'palette' | 'panel';
export function flowEditorPanes(_width: number, _opened: FlowPaneName | null): { showPalette: boolean; showPanel: boolean; columns: string; overlay: FlowPaneName | null } {
    return { showPalette: true, showPanel: true, columns: '', overlay: null };
}

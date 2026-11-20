/** RED stub (Tynn #933): the shape only; the GREEN commit fills it in. */
export type SliceState = 'proposed' | 'ready' | 'running' | 'awaiting_review' | 'accepted' | 'blocked' | 'rejected' | 'cancelled' | 'failed';
export const SLICE_STATE_LABEL: Readonly<Record<string, string>> = {};
export function sliceStateOf(_row: { readonly state?: unknown; readonly status?: unknown }): SliceState | null {
    return null;
}

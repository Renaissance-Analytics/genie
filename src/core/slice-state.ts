/**
 * A SLICE'S STATE, AS GENIE NAMES IT (Tynn #933, PM G-0; spec .ai/plans/specs/pm-model.md §5.1, §13.1).
 *
 * Tynn PM-1 renamed a Story to a Slice and gave it states from the corpus: proposed → ready → running → awaiting review →
 * accepted, plus blocked, rejected, cancelled and failed. Tynn's board answer and the workspace-UX contract still key a
 * story by its legacy `status` (Tynn keeps `status` as a projection of `state` for the alias window), so the board's
 * columns, drags and card steps stay on `status` and only the NAMES change. A row that carries `state` shows that state;
 * a row with only `status` (every Tynn answer before PM-1) shows the state Tynn's own migration maps it to.
 */
export const SLICE_STATES = ['proposed', 'ready', 'running', 'awaiting_review', 'accepted', 'blocked', 'rejected', 'cancelled', 'failed'] as const;
export type SliceState = (typeof SLICE_STATES)[number];

/** Tynn's own labels (SliceState::label()). */
export const SLICE_STATE_LABEL: Readonly<Record<SliceState, string>> = {
    proposed: 'Proposed', ready: 'Ready', running: 'Running', awaiting_review: 'Awaiting review', accepted: 'Accepted',
    blocked: 'Blocked', rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed',
};

/** The migration's map (spec §13.1): the state a legacy-only status stands for. `archived` names no one state. */
export const LEGACY_STATUS_STATE: Readonly<Record<string, SliceState>> = {
    backlog: 'proposed', in_progress: 'running', qa: 'awaiting_review', done: 'accepted', blocked: 'blocked',
};

const isSliceState = (v: unknown): v is SliceState => typeof v === 'string' && (SLICE_STATES as readonly string[]).includes(v);

/** The row's Slice state: its `state` when Tynn sent a known one, else its legacy `status` mapped; null when neither names one. */
export function sliceStateOf(row: { readonly state?: unknown; readonly status?: unknown }): SliceState | null {
    if (isSliceState(row.state)) return row.state;
    return typeof row.status === 'string' ? (LEGACY_STATUS_STATE[row.status] ?? null) : null;
}

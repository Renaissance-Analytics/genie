/**
 * A SLICE'S STATE, AS GENIE NAMES IT (Tynn #933, PM G-0; spec .ai/plans/specs/pm-model.md §5.1, §13.1).
 *
 * Tynn PM-1 renamed a Story to a Slice and gave it states from the corpus: proposed → ready → running → awaiting review →
 * accepted, plus blocked, rejected, cancelled and failed. Since workspace-ux 0.13.0 every story row carries its `state`
 * beside its legacy `status`, and the contract says the state is "never inferred from legacy status". The board's
 * columns, drags and card steps stay on `status` (the contract still keys them so) and only the NAMES change.
 *
 * So: a row WITH a `state` field shows that state, and a value Genie does not know shows as unknown; the status map is
 * never used for it. Only a row with NO `state` field at all (a Tynn older than 0.13.0) shows the state Tynn's own
 * migration maps its status to.
 */
export const SLICE_STATES = ['proposed', 'ready', 'running', 'awaiting_review', 'accepted', 'blocked', 'rejected', 'cancelled', 'failed'] as const;
export type SliceState = (typeof SLICE_STATES)[number];

/** Tynn's own labels (SliceState::label()). */
export const SLICE_STATE_LABEL: Readonly<Record<SliceState, string>> = {
    proposed: 'Proposed', ready: 'Ready', running: 'Running', awaiting_review: 'Awaiting review', accepted: 'Accepted',
    blocked: 'Blocked', rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed',
};

/** A `state` Tynn sent that is none of the nine (a newer Tynn's, or not a state at all): shown as it is, never guessed. */
export const UNKNOWN_SLICE_STATE = 'unknown';
/** What a story shows: one of Tynn's states, or unknown. */
export type ShownSliceState = SliceState | typeof UNKNOWN_SLICE_STATE;
export const sliceStateLabel = (state: ShownSliceState): string => (state === UNKNOWN_SLICE_STATE ? 'Unknown' : SLICE_STATE_LABEL[state]);

/** The migration's map (spec §13.1): the state a legacy-only status stands for. `archived` names no one state. */
export const LEGACY_STATUS_STATE: Readonly<Record<string, SliceState>> = {
    backlog: 'proposed', in_progress: 'running', qa: 'awaiting_review', done: 'accepted', blocked: 'blocked',
};

const isSliceState = (v: unknown): v is SliceState => typeof v === 'string' && (SLICE_STATES as readonly string[]).includes(v);

/**
 * The row's Slice state. With a `state` field: that state, or unknown when it is not one Genie knows. With no `state`
 * field at all (an older Tynn): its legacy `status` mapped, or null when the status names no state.
 */
export function sliceStateOf(row: { readonly state?: unknown; readonly status?: unknown }): ShownSliceState | null {
    if ('state' in row) return isSliceState(row.state) ? row.state : UNKNOWN_SLICE_STATE;
    return typeof row.status === 'string' ? (LEGACY_STATUS_STATE[row.status] ?? null) : null;
}

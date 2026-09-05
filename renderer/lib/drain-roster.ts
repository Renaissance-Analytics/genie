import { drainRowIsGreen, type DrainRow, type DrainSnapshot } from '../../main/agents/drain';

/**
 * THE "WAITING ON" ROSTER, as a person reads it (genie#389).
 *
 * *"One row per agent, an EMPTY icon while waiting, filled GREEN the moment
 * that agent's `thumbsUp` lands."* And a stuck agent's row says so — telling a
 * slow agent from a wedged one is the only way the user knows to go and shut
 * one down, which is the escape hatch that makes the whole drain shippable.
 *
 * Pure, and here rather than inside the JSX, because this lane has no DOM
 * harness: *"the icon is empty while waiting"* is exactly the kind of claim
 * that quietly stops being true, and it needs somewhere it can be asserted.
 */

/** What the row's icon shows. */
export type DrainRowIcon =
    /** Nothing yet — the outline. */
    | 'empty'
    /** Green: the agent answered, or a person answered for it. */
    | 'filled'
    /** Something is wrong with this row and the user can fix it. */
    | 'alert'
    /** Its terminal is gone. Nothing to wait for, and nobody answered. */
    | 'closed';

export function drainRowIcon(row: DrainRow): DrainRowIcon {
    if (row.state === 'ready' || row.state === 'satisfied') return 'filled';
    if (row.state === 'gone') return 'closed';
    if (row.state === 'stuck') return 'alert';
    return 'empty';
}

/**
 * The sentence under the agent's name.
 *
 * The row's own `note` wins when it has one: *"Genie could not reach this
 * agent"* and *"it has not answered"* call for different actions, and
 * flattening both to "not responding" throws that away.
 *
 * A satisfied row says the USER filled it in. A drain that showed a press and
 * an answer identically would be claiming an answer nobody gave.
 */
export function drainRowStatusLabel(row: DrainRow): string {
    if (row.note) return row.note;
    switch (row.state) {
        case 'ready':
            return 'Handed off and ready.';
        case 'satisfied':
            return 'You marked this one done.';
        case 'gone':
            return 'Its terminal closed.';
        case 'stuck':
            return 'Not responding — shut it down, then press its thumb.';
        default:
            return 'Finishing up and writing its handoff…';
    }
}

/** Can the user press the thumb for this row? Only while it holds the drain up. */
export function canSatisfyDrainRow(row: DrainRow): boolean {
    return !drainRowIsGreen(row.state);
}

export interface DrainRosterSummary {
    green: number;
    /** Rows the upgrade is still waiting on. */
    pending: number;
    /** How many of those have stopped answering. */
    stuck: number;
    done: boolean;
    headline: string;
}

export function drainRosterSummary(snapshot: DrainSnapshot): DrainRosterSummary {
    const rows = snapshot.rows ?? [];
    const green = rows.filter((row) => drainRowIsGreen(row.state)).length;
    const pending = rows.length - green;
    const stuck = rows.filter((row) => row.state === 'stuck').length;
    return {
        green,
        pending,
        stuck,
        done: pending === 0,
        headline:
            pending === 0
                ? 'Everyone has handed off — installing the update.'
                : `Waiting on ${pending} agent${pending === 1 ? '' : 's'} to finish and hand off.`,
    };
}

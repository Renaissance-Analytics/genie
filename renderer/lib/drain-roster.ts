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

/**
 * What the USER has decided about the window (genie#622).
 *
 * Stored, and passed in, rather than derived — that is the whole fix. See
 * {@link upgradeModalPlan}; the store that holds it is `./upgrade-view`.
 */
export interface UpgradeViewState {
    /**
     *  - `auto`   — the user has not touched it. The drain gate decides.
     *  - `open`   — they asked to see it, from the header control.
     *  - `closed` — they dismissed it. Only for the drain named below.
     */
    intent: 'auto' | 'open' | 'closed';
    /**
     * Which drain a `closed` was about — its `startedAt`, or null when there
     * was no drain to dismiss.
     *
     * Without this, closing the window once would disarm genie#565's gate for
     * every upgrade afterwards: the next drain would start under working agents
     * with nothing on screen saying so.
     */
    forDrain: number | null;
}

const NO_INTENT: UpgradeViewState = { intent: 'auto', forDrain: null };

/**
 * PURE. Is the upgrade window on screen, for which version, and does it show a
 * roster (genie#565, genie#622)?
 *
 * ## Two facts, and only the second belongs to the drain
 *
 * This used to be one. `open` was `drain is running or complete`, which made
 * the sheet a PROJECTION of the drain rather than a window: the only control
 * that took it away was *Cancel the upgrade*, so closing the window was
 * cancelling the upgrade — and since `cancelUpgradeDrain` clears the roster
 * too, both halves of that predicate went false with nothing in the UI able to
 * set them again. The owner could not get back in without starting over.
 *
 * So:
 *
 *  - **`open`** answers *am I looking at the upgrade* — the user's intent,
 *    with the drain deciding only while they have expressed none. The
 *    header control opens it; ✕ / Esc / the backdrop close it; neither touches
 *    anything the upgrade depends on.
 *  - **`roster`** answers *is a drain running* — and that is all it answers.
 *    Without one the sheet is release notes alone, which is the preview
 *    somebody wants BEFORE deciding.
 *
 * ## What still decides it on its own
 *
 * With no intent (`auto`) the rule is exactly genie#565's, unchanged: a drain
 * that is `active`, or `complete` and about to apply, puts itself on screen.
 * That gate is what stops an upgrade restarting under working agents, and a
 * dismissal is scoped to the drain it was about (`forDrain`) precisely so the
 * NEXT one still shows itself.
 *
 * A drain that is neither — rows, but not running and not complete — was
 * CANCELLED, and nothing reopens the sheet over it by itself. An EMPTY roster
 * is the same: that is what an upgrade with nothing to ask produces, and
 * flashing a modal for it would be a full-screen interruption for an upgrade
 * nobody was blocking.
 */
export function upgradeModalPlan(input: {
    drain: DrainSnapshot | null;
    /** The version being applied — the notes pane is about this. */
    latestVersion: string | null;
    /** What the user did with the window. Absent means they have not touched it. */
    view?: UpgradeViewState;
    /**
     * Is there an upgrade to look at at all — offered, downloading, or staged?
     *
     * The floor under an explicit `open`: the header control is the only thing
     * that sets one, and it is not clickable when Genie is up to date, so a
     * stale intent must not leave a sheet over nothing.
     */
    upgradePending?: boolean;
}): { open: boolean; version: string | null; roster: boolean } {
    const drain = input.drain;
    const draining =
        !!drain && (drain.rows?.length ?? 0) > 0 && (drain.active || drain.complete);
    const view = input.view ?? NO_INTENT;
    // A dismissal is about the drain that was on screen at the time. A
    // different one — or the first one after a preview was closed — is a new
    // gate and has not been dismissed at all.
    const dismissed =
        view.intent === 'closed' && view.forDrain === (drain?.startedAt ?? null);
    const open = dismissed
        ? false
        : view.intent === 'open'
          ? draining || input.upgradePending === true
          : draining;
    // The version rides along even when null: the AGENT list is the half the
    // user is being asked to decide about, and it must not wait on a notes
    // fetch that may never land.
    return { open, version: input.latestVersion ?? null, roster: draining };
}

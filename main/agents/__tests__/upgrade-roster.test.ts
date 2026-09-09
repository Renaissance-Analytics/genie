import { describe, expect, it } from 'vitest';
import { upgradeRosterPlan } from '../drain';
import { planRestoreNotice, type DrainRestoreOutcome } from '../drain-restore';

/**
 * THE RESTORE LIST IS THE APPLY'S JOB, NOT THE DRAIN'S (genie#551).
 *
 * genie#389 wrote the roster inside {@link beginUpgradeDrain}, which made *"we
 * recorded what was running"* a consequence of *"we decided to nudge the
 * agents"*. Those are different questions, and every apply that legitimately
 * skips the drain therefore tears the machine down with no list to bring it
 * back from. genie#565 closed the doors that skipped the drain by accident; one
 * that skips it ON PURPOSE remains, and must: a person who has been shown what
 * they are about to lose and says go anyway. `mobileInstallUpdate(force)` is
 * that person, from a phone, with no drain in front of them.
 *
 * So recording moves to the apply seam — and the moment it does, the GUARD
 * becomes the whole problem.
 */

describe('upgradeRosterPlan — record once, and never over a better list', () => {
    it('RECORDS when nothing has been recorded: the forced apply no drain preceded', () => {
        // genie#551 itself. `requestUpgradeRestart({ force: true })` from the
        // phone applies immediately, so `beginUpgradeDrain` never ran and no
        // roster was ever written. Every running agent goes, and nothing on the
        // other side knows any of them existed.
        expect(upgradeRosterPlan({ rosterRecorded: false })).toBe('record');
    });

    it('KEEPS a roster that already exists — the drain wrote it before the nudges', () => {
        // The drain records BEFORE the first nudge, deliberately, and by the
        // time the apply runs those agents have handed off and exited. A
        // re-record here walks a machine on which the recorded agents are gone,
        // and replaces a correct list with a thinner one.
        expect(upgradeRosterPlan({ rosterRecorded: true })).toBe('keep');
    });

    it('asks whether a ROSTER EXISTS — not whether the drain cleared', () => {
        // The distinction this function exists for. A Force Restart taken while
        // the drain is still running has `drainCleared: false` AND a correct,
        // complete roster on disk — the drain wrote it, and the agents that
        // have already gone green are exactly the ones now missing from live
        // state. A guard reading `drainCleared` would re-record there and drop
        // every agent that had answered: the same bug, entered from the other
        // side.
        //
        // Stated as data rather than prose so a future refactor to the other
        // input fails here instead of shipping.
        const forceMidDrain = { rosterRecorded: true /* drain has NOT cleared */ };
        expect(upgradeRosterPlan(forceMidDrain)).toBe('keep');
    });
});

const outcome = (
    label: string,
    status: DrainRestoreOutcome['status'],
    reason?: string,
): DrainRestoreOutcome => ({
    entry: { kind: 'agent', ref: `a-${label}`, label, workspaceId: 'ws1' },
    status,
    ...(reason ? { reason } : {}),
    at: 0,
});

/**
 * AND SAY SO WHEN IT DOES NOT COME BACK (genie#551, the second half).
 *
 * The restore's only report was a `console.log`, so an agent that failed to
 * restart was invisible until a person noticed its absence — which is how this
 * bug was found rather than reported. A person noticing an absence is the
 * slowest and least reliable monitor there is.
 */
describe('planRestoreNotice — what the user is told about a restore', () => {
    it('says nothing when every entry came back', () => {
        expect(planRestoreNotice([outcome('moic', 'started'), outcome('hand', 'started')])).toBeNull();
    });

    it('says nothing about SKIPS — they are decisions the restore made correctly', () => {
        // "You stopped it" and "it is already running" are the restore working.
        // Surfacing them would train the user to dismiss the one that matters.
        const notice = planRestoreNotice([
            outcome('web', 'skipped', 'You stopped it.'),
            outcome('queue', 'skipped', 'It is already running.'),
        ]);
        expect(notice).toBeNull();
    });

    it('names the agent and the reason when one fails', () => {
        const notice = planRestoreNotice([
            outcome('moic', 'started'),
            outcome('hand', 'failed', 'workspace ws1 no longer exists'),
        ]);
        expect(notice?.title).toContain('hand');
        expect(notice?.body).toContain('workspace ws1 no longer exists');
    });

    it('counts rather than lists once there are too many to name', () => {
        const notice = planRestoreNotice(
            ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => outcome(n, 'failed', 'boom')),
        );
        expect(notice?.title).toContain('6');
        // The first four by name, then one line saying how many are left — a
        // toast that lists twelve is a toast nobody finishes reading.
        expect(notice?.body.split('\n')).toHaveLength(5);
        expect(notice?.body).toContain('2 more');
    });
});

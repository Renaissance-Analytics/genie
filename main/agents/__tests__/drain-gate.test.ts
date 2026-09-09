import { describe, expect, it } from 'vitest';
import { restartPlanForUpgrade, shutdownReadinessPlan, upgradeRestartPlan } from '../drain';

/**
 * NO AGENT IS KILLED BY AN UPGRADE WITHOUT BEING ASKED FIRST (genie#389).
 *
 * That is the first acceptance line of the issue, and it is a property of the
 * RESTART path rather than of any one button. The header pill and the
 * staged-build banner both end at the same `updater:restart`, so a drain wired
 * only to the pill leaves the other door open — and it is the one a user
 * reaches for when they are in a hurry.
 *
 * So the decision lives here, in one pure function that path consults, rather
 * than in the button.
 */

describe('restartPlanForUpgrade', () => {
    it('DRAINS when live agents would be killed', () => {
        expect(restartPlanForUpgrade({ liveAgents: 2, drainComplete: false })).toBe('drain');
    });

    it('applies once the drain has cleared — the roster is the gate, not the count', () => {
        // The agents are still counted live at this instant: the drain has
        // finished asking, and the terminals have not been torn down yet. A
        // plan that re-read the count here would refuse to ever apply.
        expect(restartPlanForUpgrade({ liveAgents: 2, drainComplete: true })).toBe('apply');
    });

    it('applies immediately when no agent would be killed', () => {
        // A service-backed host survives the swap, so nothing is interrupted and
        // there is nothing to drain. Holding an upgrade behind an empty roster
        // would be a delay with no purpose.
        expect(restartPlanForUpgrade({ liveAgents: 0, drainComplete: false })).toBe('apply');
    });

    it('treats a missing count as "there may be agents" — the safe direction', () => {
        // The probe can fail. Guessing zero would apply the upgrade over live
        // agents, which is the exact thing being prevented; guessing "some"
        // costs at most one roster the user clears in a click.
        expect(restartPlanForUpgrade({ liveAgents: null, drainComplete: false })).toBe('drain');
    });
});

describe('shutdownReadinessPlan', () => {
    it('SKIPS the quit-time readiness ask when the drain already cleared', () => {
        // The update quit runs its own bounded readiness barrier — the same
        // agents, the same thumb, a 30-second wait. Running it after a drain
        // asks everyone a second question they have already answered, and makes
        // the user watch a half-minute timeout at the end of an upgrade they
        // just spent time draining.
        expect(shutdownReadinessPlan({ forUpdate: true, drainCleared: true })).toBe('skip');
    });

    it('still asks when the update was applied WITHOUT a drain', () => {
        // The positive control, and the important one: a service-backed host,
        // a forced apply, or any path that skipped the drain must keep the
        // barrier it has always had.
        expect(shutdownReadinessPlan({ forUpdate: true, drainCleared: false })).toBe('ask');
    });

    it('still asks on a quit that is not an update at all', () => {
        // A workstation reset or an ordinary full shutdown is a different event;
        // a drain that ran for an upgrade says nothing about it.
        expect(shutdownReadinessPlan({ forUpdate: false, drainCleared: true })).toBe('ask');
    });
});

describe('upgradeRestartPlan — the ONE door (genie#565)', () => {
    it('drains when agents are live and the user did not force', () => {
        expect(
            upgradeRestartPlan({ force: false, liveAgents: 3, drainComplete: false }),
        ).toBe('drain');
    });

    it('FORCE applies over live agents — a human act, never a clock', () => {
        // The drain deliberately never resolves on a timeout, so the only way
        // past a wedged agent is a person deciding to lose its work. That
        // decision is this flag, and nothing else may set it.
        expect(
            upgradeRestartPlan({ force: true, liveAgents: 3, drainComplete: false }),
        ).toBe('apply');
    });

    it('force does not invent a drain when there was nothing to drain', () => {
        expect(
            upgradeRestartPlan({ force: true, liveAgents: 0, drainComplete: false }),
        ).toBe('apply');
    });

    it('an unforced restart with an unreadable count still drains', () => {
        expect(
            upgradeRestartPlan({ force: false, liveAgents: null, drainComplete: false }),
        ).toBe('drain');
    });
});

describe('shutdownReadinessPlan — a forced restart is not a drained one', () => {
    it('skips the quit-time ask after a FORCED restart', () => {
        // Force means "do not wait". Running the 30-second readiness barrier
        // over agents the user just chose not to wait for is waiting, and it is
        // the same question the drain already put in their inbox.
        expect(
            shutdownReadinessPlan({ forUpdate: true, drainCleared: false, forced: true }),
        ).toBe('skip');
    });

    it('does NOT treat a forced restart as a cleared drain elsewhere', () => {
        // The positive control for the sin this guards: `drainCleared` means
        // the agents answered. A force means they did not. The two reach the
        // same skip here and must stay separate facts everywhere else.
        expect(
            shutdownReadinessPlan({ forUpdate: true, drainCleared: false, forced: false }),
        ).toBe('ask');
    });

    it('a force on a quit that is not an update keeps the barrier', () => {
        expect(
            shutdownReadinessPlan({ forUpdate: false, drainCleared: false, forced: true }),
        ).toBe('ask');
    });
});

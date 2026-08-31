import { describe, expect, it } from 'vitest';
import { notTrackingFix } from '../not-tracking-fix';

/**
 * "Tynn isn't tracking this workspace yet" must come with a way OUT.
 *
 * What shipped was advice and nothing else: *"Check that it's linked to a Tynn
 * project and that the project has repositories registered for IssueWatch."*
 * Genie already KNOWS both of those things — whether the workspace carries a
 * Tynn project id, and how many repos are enabled, which are listed a few
 * pixels above the message. So it was asking the owner to go and verify facts
 * it was holding, and offering no button for either answer.
 *
 * Worse, it was frequently wrong: on a workspace that IS linked with eleven
 * repos ticked, both suggestions are dead ends by construction.
 *
 * So this decides WHICH of the causes actually applies, from what Genie already
 * has, and returns the action for that cause. A dead end is a bug.
 */

describe('notTrackingFix', () => {
    it('sends an UNLINKED workspace to the place it gets linked', () => {
        const fix = notTrackingFix({ linked: false, enabledRepoCount: 3, needsReauth: false });
        expect(fix.cause).toBe('unlinked');
        expect(fix.action).toBe('open-workspace-settings');
        expect(fix.actionLabel).toMatch(/settings/i);
    });

    it('sends a linked workspace with NO repos to the repo list', () => {
        const fix = notTrackingFix({ linked: true, enabledRepoCount: 0, needsReauth: false });
        expect(fix.cause).toBe('no-repos');
        expect(fix.action).toBe('focus-repos');
    });

    it('offers a REFRESH when everything is configured and Tynn still has not heard', () => {
        // The case the old copy could not describe at all: linked, repos ticked,
        // and Tynn still reporting nothing. Telling this owner to "check that
        // it's linked" is worse than saying nothing.
        const fix = notTrackingFix({ linked: true, enabledRepoCount: 11, needsReauth: false });
        expect(fix.cause).toBe('server-has-not-polled');
        expect(fix.action).toBe('force-refresh');
        expect(fix.message).not.toMatch(/check that/i);
    });

    it('puts RECONNECT first when the GitHub session is dead', () => {
        // Nothing downstream can work without it, so offering a refresh here
        // would send the owner round a loop that cannot succeed.
        const fix = notTrackingFix({ linked: true, enabledRepoCount: 11, needsReauth: true });
        expect(fix.cause).toBe('github-disconnected');
        expect(fix.action).toBe('reconnect-github');
    });

    it('always returns an action — never advice alone', () => {
        // THE point. Every reachable combination has to hand back something the
        // owner can click; a state with no way forward is the bug this exists
        // to prevent, and it is worth failing on rather than reviewing for.
        for (const linked of [true, false]) {
            for (const repos of [0, 1, 11]) {
                for (const needsReauth of [true, false]) {
                    const fix = notTrackingFix({ linked, enabledRepoCount: repos, needsReauth });
                    expect(fix.action).toBeTruthy();
                    expect(fix.actionLabel.trim().length).toBeGreaterThan(0);
                    expect(fix.message.trim().length).toBeGreaterThan(0);
                }
            }
        }
    });
});

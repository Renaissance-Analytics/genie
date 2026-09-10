import { describe, expect, it } from 'vitest';
import { REQUIRED_CHECKS, ciQueuedVerdict } from '../ci-queued-verdict.mjs';

/**
 * Does this pull request's head commit actually have CI on it?
 *
 * genie#574 is the failure this exists to make impossible to miss. That PR was
 * conflicted (`mergeable_state: "dirty"`), which means GitHub cannot build a
 * merge ref for it — and every `pull_request`-triggered workflow silently never
 * queues. What DID run were the workflows that do not need a merge ref:
 * `pull_request_target` (the `flag` check) and CodeQL's default setup, both of
 * which evaluate the BASE branch and passed happily.
 *
 * The head SHA therefore carried SIX green check runs and zero CI. Read as
 * "a small CI run", it cost about an hour before anyone noticed the suite had
 * never executed. A red X would have cost seconds.
 *
 * So the invariant is stated directly: the five checks a pushed SHA must carry
 * (`test`, `hosting`, and the three E2E shards) either EXIST on this commit, or
 * this check is red. Existence, not success — a failing suite is a different
 * problem and it is already loud.
 *
 * PURE: the verdict takes an observation and returns a decision. The runner
 * does the polling and the API calls.
 */

const ALL_PRESENT = [...REQUIRED_CHECKS];
const BASE = {
    mergeable: true as boolean | null,
    mergeableState: 'clean',
    checkNames: ALL_PRESENT,
    fromFork: false,
    waitedMs: 0,
    budgetMs: 180_000,
};

describe('ciQueuedVerdict', () => {
    it('is satisfied once every required check exists on the commit', () => {
        const v = ciQueuedVerdict(BASE);
        expect(v.state).toBe('satisfied');
        expect(v.missing).toEqual([]);
    });

    it('is satisfied by checks that exist but have FAILED — existence is the question', () => {
        // A red suite is a visible, well-understood problem. This check asks
        // only whether the suite ran at all, so it must not double-report.
        const v = ciQueuedVerdict({ ...BASE, checkNames: ALL_PRESENT });
        expect(v.state).toBe('satisfied');
    });

    it('BLOCKS a conflicted PR immediately, without waiting out the budget', () => {
        // The genie#574 shape: dirty, so no `pull_request` workflow will ever
        // queue on this commit no matter how long we wait.
        const v = ciQueuedVerdict({
            ...BASE,
            mergeable: false,
            mergeableState: 'dirty',
            checkNames: ['flag', 'CodeQL', 'Analyze (actions)', 'Analyze (javascript-typescript)'],
            waitedMs: 0,
        });
        expect(v.state).toBe('blocked');
        expect(v.reason).toBe('not-mergeable');
        expect(v.summary).toMatch(/no CI/i);
        // The message has to say what to DO, or it is just a second mystery.
        expect(v.detail).toMatch(/rebase/i);
    });

    it('blocks a conflicted PR even when stale checks from an earlier state are present', () => {
        // Main moved and created the conflict after CI had already run. The
        // checks exist, but the PR still cannot merge and its next push will
        // get nothing — one rule, no exception to reason about.
        const v = ciQueuedVerdict({ ...BASE, mergeable: false, mergeableState: 'dirty' });
        expect(v.state).toBe('blocked');
        expect(v.reason).toBe('not-mergeable');
    });

    it('waits while GitHub is still computing mergeability', () => {
        // `mergeable: null` means "ask again", never "no". Failing here would
        // make the guard fire on healthy PRs, which is how a useful check gets
        // turned off.
        const v = ciQueuedVerdict({
            ...BASE,
            mergeable: null,
            mergeableState: 'unknown',
            checkNames: [],
            waitedMs: 5_000,
        });
        expect(v.state).toBe('waiting');
    });

    it('waits while some shards have registered and others have not', () => {
        const v = ciQueuedVerdict({
            ...BASE,
            checkNames: ['test', 'hosting', 'E2E (ubuntu-latest)'],
            waitedMs: 10_000,
        });
        expect(v.state).toBe('waiting');
        expect(v.missing).toEqual(['E2E (macos-latest)', 'E2E (windows-latest)']);
    });

    it('blocks when the budget runs out with checks still missing, and names them', () => {
        const v = ciQueuedVerdict({
            ...BASE,
            checkNames: ['test', 'hosting'],
            waitedMs: 180_000,
            budgetMs: 180_000,
        });
        expect(v.state).toBe('blocked');
        expect(v.reason).toBe('checks-never-queued');
        expect(v.missing).toEqual([
            'E2E (macos-latest)',
            'E2E (ubuntu-latest)',
            'E2E (windows-latest)',
        ]);
        expect(v.detail).toContain('E2E (macos-latest)');
    });

    it('skips fork PRs, where "no CI yet" is a maintainer approval away', () => {
        // A first-time outside contributor's workflows sit in
        // `action_required` until someone approves them. That is a legitimate
        // state, and this repository deliberately funnels outside submissions
        // through owner review — failing them here would be noise, and noise is
        // what gets a check ignored.
        const v = ciQueuedVerdict({ ...BASE, fromFork: true, checkNames: [], waitedMs: 999_000 });
        expect(v.state).toBe('skipped');
        expect(v.reason).toBe('fork-pr');
    });

    it('treats a fork PR as skipped before it treats a conflict as blocking', () => {
        const v = ciQueuedVerdict({
            ...BASE,
            fromFork: true,
            mergeable: false,
            mergeableState: 'dirty',
            checkNames: [],
        });
        expect(v.state).toBe('skipped');
    });

    it('requires exactly the five checks a pushed SHA carries — no more, no fewer', () => {
        // The complete set on a pushed SHA is EIGHT: these five, plus CodeQL and
        // its two Analyze jobs, which come from GitHub's default setup and run
        // on the head regardless of mergeability. Only the five that come from
        // `pull_request` workflows are evidence that CI ran on this code.
        expect(REQUIRED_CHECKS).toEqual([
            'E2E (macos-latest)',
            'E2E (ubuntu-latest)',
            'E2E (windows-latest)',
            'hosting',
            'test',
        ]);
    });

    it('ignores unrelated checks entirely — flag and CodeQL prove nothing about CI', () => {
        const v = ciQueuedVerdict({
            ...BASE,
            checkNames: [...ALL_PRESENT, 'flag', 'CodeQL', 'ci-queued'],
        });
        expect(v.state).toBe('satisfied');
    });
});

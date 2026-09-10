/**
 * Did CI actually run on this pull request's head commit?
 *
 * genie#574 is why this exists. That PR was conflicted — `mergeable_state:
 * "dirty"` — which means GitHub cannot compute a merge ref for it, and every
 * `pull_request`-triggered workflow therefore never queues. Silently: no error,
 * no annotation, no skipped run to notice.
 *
 * What still ran were the workflows that need no merge ref. `pull_request_target`
 * (the `flag` check) and CodeQL's default setup both evaluate the BASE branch,
 * and both passed. The head SHA ended up carrying SIX green check runs and zero
 * CI, which reads like a small CI configuration rather than an absent one. It
 * cost about an hour before anyone realised the suite had never executed.
 *
 * The rule this encodes: **"no CI ran" must never be mistakable for "CI passed".**
 * Either the five checks a pushed SHA carries from `pull_request` workflows exist
 * on this commit, or this check is red and says which are missing and why.
 *
 * EXISTENCE, not success. A failing suite is a different problem and it is
 * already loud; double-reporting it here would only teach people to ignore this
 * check, and an ignored check is worth less than no check.
 *
 * PURE: this takes one observation and returns one decision. `assert-ci-queued.mjs`
 * does the polling and the API calls.
 */

/**
 * The checks that come from `pull_request` workflows, and so are evidence that
 * CI ran against THIS code.
 *
 * The complete set on a pushed SHA is EIGHT. The other three — `CodeQL` and its
 * two `Analyze (…)` jobs — come from GitHub's default code-scanning setup, which
 * runs against the head commit and is unaffected by mergeability. They were
 * green on #574 while nothing had been tested, so they are deliberately NOT
 * evidence here.
 *
 * `flag` is not in the set either: it is `pull_request_target: [opened,
 * reopened]` with no `synchronize`, so it fires once at PR open and never again.
 * `flag` alone, with none of the five below, is the exact signature of the
 * failure this guards.
 *
 * Sorted, so a missing-check list reads the same way every time.
 */
export const REQUIRED_CHECKS = [
    'E2E (macos-latest)',
    'E2E (ubuntu-latest)',
    'E2E (windows-latest)',
    'hosting',
    'test',
];

/**
 * @typedef {'satisfied'|'waiting'|'blocked'|'skipped'} VerdictState
 *
 * @typedef {object} Observation
 * @property {boolean|null} mergeable     GitHub's `pull_request.mergeable`. `null`
 *                                        means "still computing" — never "no".
 * @property {string} mergeableState      `pull_request.mergeable_state`, for the message.
 * @property {string[]} checkNames        Names of the check runs present on the head SHA.
 * @property {boolean} fromFork           Head repo differs from base repo.
 * @property {number} waitedMs            How long the runner has polled so far.
 * @property {number} budgetMs            How long it is willing to poll.
 *
 * @typedef {object} Verdict
 * @property {VerdictState} state
 * @property {string} reason
 * @property {string[]} missing
 * @property {string} summary
 * @property {string} detail
 */

/**
 * @param {Observation} obs
 * @returns {Verdict}
 */
export function ciQueuedVerdict(obs) {
    const { mergeable, mergeableState, checkNames, fromFork, waitedMs, budgetMs } = obs;
    const present = new Set(checkNames);
    const missing = REQUIRED_CHECKS.filter((name) => !present.has(name));

    // A fork PR's workflows sit in `action_required` until a maintainer approves
    // them — a legitimate "no CI yet" that no amount of waiting resolves, and one
    // this repository funnels through owner review on purpose (see
    // external-submission-triage.yml). Failing it here would be noise, and a noisy
    // check is one people learn to skip past. Checked FIRST: a fork PR that is
    // also conflicted is still the maintainer's call, not a defect to shout about.
    if (fromFork) {
        return {
            state: 'skipped',
            reason: 'fork-pr',
            missing,
            summary: 'Fork PR — CI approval is a maintainer action, not a defect',
            detail:
                'Workflows on a pull request from a fork wait for maintainer approval before ' +
                'they queue, so an empty check list here is expected. Approve the run from the ' +
                'PR page (and read the `needs-owner-review` warning first).',
        };
    }

    // The genie#574 shape. A conflicted PR gets no `pull_request` run on this
    // commit and will get none on the next push either, so there is nothing to
    // wait for — fail immediately rather than burning the budget first.
    //
    // This holds even when checks ARE present, which happens when main moved and
    // created the conflict after CI had already run: those results were computed
    // against a merge that no longer exists, and the PR cannot merge regardless.
    // One rule, no exception to reason about.
    if (mergeable === false) {
        return {
            state: 'blocked',
            reason: 'not-mergeable',
            missing,
            summary: `This PR cannot be merged (mergeable_state: ${mergeableState}) — so no CI will run on it`,
            detail:
                `GitHub cannot compute a merge ref for a pull request in \`${mergeableState}\` state, ` +
                'and every `pull_request`-triggered workflow therefore never queues. This is silent: ' +
                'no error, no skipped run.\n\n' +
                'Any green ticks beside this one come from workflows that evaluate the BASE branch ' +
                '(`flag`, via `pull_request_target`) or the head commit regardless of mergeability ' +
                '(`CodeQL`, `Analyze (…)`). **None of them tested the code in this PR.**\n\n' +
                'Rebase onto `main` and force-push. The checks return on the next push.',
        };
    }

    if (missing.length === 0) {
        return {
            state: 'satisfied',
            reason: 'all-queued',
            missing,
            summary: `All ${REQUIRED_CHECKS.length} CI checks are present on this commit`,
            detail:
                'This check reports only that the suite RAN. Whether it passed is the other ' +
                'checks’ job.',
        };
    }

    // `mergeable: null` is "ask again", and a shard that has not registered yet is
    // normal for the first few seconds. Median queue time in this repository is
    // about six seconds, so the budget is generous by a wide margin — a guard that
    // fires on healthy PRs is a guard that gets switched off.
    if (waitedMs < budgetMs) {
        return {
            state: 'waiting',
            reason: mergeable === null ? 'mergeability-unknown' : 'checks-pending',
            missing,
            summary: `Waiting for ${missing.length} check(s) to register`,
            detail: `Still missing: ${missing.join(', ')}`,
        };
    }

    return {
        state: 'blocked',
        reason: 'checks-never-queued',
        missing,
        summary: `${missing.length} of ${REQUIRED_CHECKS.length} CI checks never queued for this commit`,
        detail:
            `After ${Math.round(budgetMs / 1000)}s, these checks do not exist on this commit:\n` +
            missing.map((n) => `  - ${n}`).join('\n') +
            '\n\nThe PR reports as mergeable, so the usual cause (a conflict) is not it. Look for a ' +
            'workflow file that fails to parse on this branch, a `paths:` filter that excluded the ' +
            'change, or Actions being disabled. Whatever the cause, **the code in this PR has not ' +
            'been tested** — do not read the remaining green ticks as CI.',
    };
}

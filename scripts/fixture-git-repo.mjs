/**
 * A TEST FIXTURE'S OWN GIT REPO (Tynn #732): init, git's auto-maintenance and auto-gc off, everything added, one commit.
 *
 * Why they are off: these repos are the test's own and live for one run, and git's housekeeping plays no part in what a
 * row checks. Left on, every commit starts a second git process (`git maintenance run --auto --detach`), a separate
 * executable that on a fresh Windows VM took up to 4.8 s to reach its main() the first time it ran (measured in the
 * files-watch row on Azure, queue items 1119-173835-3a5952 and 1119-180221-2b163b), inside a fixture call with a 15 s
 * bound that failed four gates with `spawnSync git ETIMEDOUT`.
 *
 * @param {(args: readonly string[]) => unknown} git runs git in the fixture's folder (its own identity and bounds)
 * @param {string} message the commit's message
 */
export function initFixtureRepo(git, message) {
    git(['init']);
    git(['config', 'maintenance.auto', 'false']);
    git(['config', 'gc.auto', '0']);
    git(['add', '.']);
    git(['commit', '-m', message]);
}

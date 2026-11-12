import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { windowsFunction } from './helpers/ci-scripts.js';

/**
 * THE WINDOWS TEST BUDGET IN CI (2026-10-22). vitest's default budget is 5 s per test, and the real-I/O suites earn it
 * on Linux and on this desktop. On GitHub's `windows-latest` runners the same suites run five to ten times slower, and
 * one day's PRs failed on SIX DIFFERENT ones, each "Test timed out in 5000ms", each on a path the PR did not touch:
 * envelope-fork-build (the beta.37 release, 5019 ms), tynn-agent-token (#1113, 5151 ms), thread-writes-settle (#1114,
 * 6098 ms against 462–706 ms on three other Windows runs), the knowledge-store suites (#1126), turn-renumber (#1116),
 * v1-services-adopt (#1128). Per-test budgets were added one suite at a time and the next suite failed the next day.
 *
 * So the two Windows jobs that run the suite — CI's `unit (windows)` and the release's Windows publish — give vitest a
 * 30 s budget. A hang still fails (30 s is not forever); a slow runner no longer does. Linux and local runs keep the 5 s
 * default, so a test that is genuinely slow is still caught where the machine is not the excuse. This file holds both
 * workflows to it, because a budget that quietly disappears from one job is found by the release, after the tag.
 */

const BUDGET = '--testTimeout=30000';
// Comments are stripped BY LINE first: a budget mentioned in a comment is not a budget (the source-guard rule).
const code = (yaml: string) => yaml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

describe('the Windows unit row runs vitest with a 30 s budget', () => {
    it("scripts/ci/windows.ps1's unit row", () => {
        expect(windowsFunction('Row-unit')).toContain(`npm test -- ${BUDGET}`);
    });
    it('the release runs no tests at all: GitHub builds, signs and publishes (the owner, 2026-11-11)', () => {
        const release = code(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
        expect(release).not.toMatch(/run: npm test\b/);
        expect(release).not.toMatch(/run: npm run verify:/);
        // CONTROL: the release is read, and it still builds.
        expect(release).toMatch(/run: npm run build\b/);
    });
});

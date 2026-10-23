import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHAT CI KEEPS AND WHAT IT BUILDS (the owner, 2026-10-23, after the estimate of what this repo would cost private:
 * ~$230 a month at October's pace, ~$40 of it artifact storage and most of the compute Windows packaging).
 *
 * - Every artifact CI uploads is kept 7 days, not GitHub's default 90: 162 GB of installers and screenshots were live,
 *   and nobody reaches for a PR's installer after a week — a release builds its own (release.yml).
 * - The installers are built on pushes to main only, not on every PR push: the release workflow builds and verifies
 *   them for every tag, and main's build catches a packaging break the day it merges.
 * - A PR's superseded runs are cancelled (already true: `cancel-in-progress` for pull requests) — held here so it stays.
 *
 * Comments are stripped by line first: a setting named in a comment is not a setting.
 */

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

describe('CI keeps less and builds installers where they are used', () => {
    it('every upload-artifact step keeps its files 7 days', () => {
        const uploads = ci.split('uses: actions/upload-artifact').slice(1).map((s) => s.slice(0, s.search(/\n\s+- (uses|name|run):|\n {2}[a-z-]+:\n/) + 1 || undefined));
        expect(uploads.length).toBeGreaterThanOrEqual(3);
        for (const u of uploads) expect(u).toMatch(/retention-days: 7\b/);
    });

    it('the packaging job runs on pushes to main, not on pull requests', () => {
        const job = ci.slice(ci.indexOf('\n  package:'), ci.indexOf('\n  ', ci.indexOf('\n  package:') + 12));
        expect(ci.slice(ci.indexOf('\n  package:'), ci.indexOf('runs-on', ci.indexOf('\n  package:')))).toMatch(/if: github\.event_name == 'push'/);
        expect(job.length).toBeGreaterThan(0);
    });

    it('a pull request’s superseded runs are cancelled', () => {
        expect(ci).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    });
});

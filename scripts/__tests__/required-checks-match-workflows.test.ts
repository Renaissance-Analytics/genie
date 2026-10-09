import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_CHECKS } from '../ci-queued-verdict.mjs';

const REPO = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/**
 * REQUIRED_CHECKS IS A COPY OF THE WORKFLOWS, SO SOMETHING HAS TO COMPARE IT TO THEM.
 *
 * `ci-queued` asserts that a set of named check runs exists on a PR's head commit, and the
 * set is a hand-maintained list in `ci-queued-verdict.mjs`. Dropping macOS from `e2e.yml`'s
 * matrix (owner's call, 2026-10-09) left `E2E (macos-latest)` in that list, so the guard
 * went red on a PR whose E2E had in fact passed on both remaining platforms — and its
 * message said *"the code in this PR has not been tested"*, which was false.
 *
 * The test that was supposed to catch this could not: it asserted `REQUIRED_CHECKS` equalled
 * a hardcoded copy of itself, in the same file, so it only ever noticed someone editing the
 * list. It would have stayed green with no E2E job in the repo at all. A test naming "the
 * checks a pushed SHA carries" has to read the thing that produces them.
 *
 * So these derive the names from the workflow files. The failure mode they close is
 * one-directional and nasty: a matrix change makes the guard red for EVERY subsequent PR,
 * and because `pr-ci-queued.yml` runs on `pull_request_target` it executes the BASE branch's
 * copy of the script — so the PR that causes it cannot be the PR that fixes it. The desync
 * has to be caught here, in `npm test`, before it merges.
 */

/** The check-run names `e2e.yml` will produce, from its job name template and its matrix. */
function e2eCheckNames(yaml: string): string[] {
    const nameLine = /^[ \t]*name:[ \t]*(.*\$\{\{[ \t]*matrix\.os[ \t]*\}\}.*?)[ \t]*\r?$/m.exec(yaml);
    if (!nameLine) {
        throw new Error('e2e.yml: no job `name:` templated on matrix.os — the check-name shape changed');
    }
    const osLine = /^[ \t]*os:[ \t]*\[([^\]]+)\][ \t]*\r?$/m.exec(yaml);
    if (!osLine) {
        throw new Error('e2e.yml: no inline `os: [...]` matrix — the matrix shape changed');
    }
    return osLine[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((os) => nameLine[1].replace(/\$\{\{[ \t]*matrix\.os[ \t]*\}\}/g, os));
}

/**
 * A job's key IS its check-run name unless the job sets `name:`. Asserted here rather than
 * assumed: a `name:` on one of these jobs would rename its check and break the guard the
 * same way the matrix did.
 */
function jobCheckNames(yaml: string, file: string): string[] {
    const body = yaml.split(/^jobs:[ \t]*\r?$/m)[1];
    if (!body) throw new Error(`${file}: no \`jobs:\` block`);
    const keys = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*\r?$/gm)].map((m) => m[1]);
    for (const key of keys) {
        const job = body.split(new RegExp(`^ {2}${key}:[ \\t]*\\r?$`, 'm'))[1]?.split(/^ {2}[A-Za-z0-9_-]+:/m)[0] ?? '';
        const renamed = /^ {4}name:[ \t]*(.+?)[ \t]*\r?$/m.exec(job);
        if (renamed) {
            throw new Error(
                `${file}: job \`${key}\` sets \`name: ${renamed[1]}\`, so its check is not called "${key}". ` +
                    'Update REQUIRED_CHECKS and this parser together.',
            );
        }
    }
    return keys;
}

describe('REQUIRED_CHECKS vs the workflows that produce the checks', () => {
    it('is exactly the set of checks ci.yml and e2e.yml will produce', () => {
        const e2e = e2eCheckNames(read('.github/workflows/e2e.yml'));
        const ci = jobCheckNames(read('.github/workflows/ci.yml'), 'ci.yml');

        // A parser that silently matched nothing would make the comparison below vacuous in
        // the one direction that matters. Counts, so a wrong count is named, not just falsy.
        expect(e2e.length).toBeGreaterThan(0);
        expect(ci.length).toBeGreaterThan(0);

        expect([...REQUIRED_CHECKS].sort()).toEqual([...e2e, ...ci].sort());
    });

    it('POSITIVE CONTROL: the matrix parser reads the matrix, it does not return a constant', () => {
        // Two fixed samples differing ONLY in the matrix. If the parser returned a constant —
        // or the repo's real list by accident — these two could not disagree.
        const two = [
            'jobs:',
            '  e2e:',
            '    name: E2E (${{ matrix.os }})',
            '    strategy:',
            '      matrix:',
            '        os: [windows-latest, ubuntu-latest]',
            '',
        ].join('\n');
        const three = two.replace(
            'os: [windows-latest, ubuntu-latest]',
            'os: [windows-latest, ubuntu-latest, macos-latest]',
        );

        expect(e2eCheckNames(two)).toEqual(['E2E (windows-latest)', 'E2E (ubuntu-latest)']);
        expect(e2eCheckNames(three)).toEqual([
            'E2E (windows-latest)',
            'E2E (ubuntu-latest)',
            'E2E (macos-latest)',
        ]);
    });

    it('POSITIVE CONTROL: a renamed job is reported, not silently accepted', () => {
        const yaml = ['jobs:', '  test:', '    name: Unit tests', '    runs-on: ubuntu-latest', ''].join('\n');
        expect(() => jobCheckNames(yaml, 'sample.yml')).toThrow(/sets `name: Unit tests`/);
    });

    it('both workflows are pull_request-triggered — that is the whole reason they are evidence', () => {
        // `ci-queued` exists because `pull_request` workflows do not queue on a conflicted PR.
        // A check from some other trigger proves nothing about THIS code, so if either of
        // these stopped being `pull_request`-triggered the guard would be asserting the wrong
        // thing — quietly, and in the direction that reads as success.
        for (const file of ['ci.yml', 'e2e.yml']) {
            expect(read(`.github/workflows/${file}`)).toMatch(/^ {2}pull_request:[ \t]*\r?$/m);
        }
    });
});

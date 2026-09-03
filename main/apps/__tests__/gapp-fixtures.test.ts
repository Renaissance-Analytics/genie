import path from 'path';
import { describe, expect, it } from 'vitest';
import { checkApp } from '../checkup';
import { fsCheckProbe } from '../check-fs';
import { formatCheckReport } from '../findings';
import type { AppFinding } from '../findings';

/**
 * Real GApp folders, broken in specific ways, run through the REAL filesystem
 * (genie#245 follow-on).
 *
 * `checkup.test.ts` drives the suite through a fake probe, which is how every
 * branch gets asserted. This file exists for the two things a fake cannot answer:
 *
 *   1. Does the FILESYSTEM half work — the walker, the reader, the path joining
 *      that behaves differently on Windows than it reads on the page?
 *   2. Does the OUTPUT actually help? Every fixture below is a mistake somebody
 *      will really make, and the assertions are about what the developer READS.
 *      A checker that fails for the right reason with a useless message has done
 *      the easy half and none of the useful one.
 *
 * The `sound` fixture is the positive control. Without it, every negative here
 * would go on passing against a suite that had stopped working entirely — "X is
 * absent" passes just as well on a corpse.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'gapps');

const checkFixture = (name: string) =>
    checkApp(path.join(FIXTURES, name), fsCheckProbe({ slugTaken: () => false }));

/** The finding, or a failure that PRINTS the report — the thing under test. */
function findingIn(name: string, id: string): AppFinding {
    const report = checkFixture(name);
    const finding = report.findings.find((f) => f.check === id);
    expect(
        finding,
        `the "${name}" fixture should have tripped "${id}".\n\n` +
            formatCheckReport(report, name),
    ).toBeDefined();
    return finding!;
}

describe('a sound app — the positive control', () => {
    it('passes cleanly, so every failure below means something', () => {
        const report = checkFixture('sound');

        expect(report.ok, formatCheckReport(report, 'sound')).toBe(true);
        expect(report.findings).toEqual([]);
    });

    it('really did look — at the manifest, the window, the roster and the service', () => {
        // The other half of a positive control: a suite that skipped everything
        // would also report no findings.
        const report = checkFixture('sound');

        expect(report.ran).toEqual(
            expect.arrayContaining([
                'install-gate',
                'frontend.no-index',
                'frontend.window-genie',
                'agents.unreachable',
                'service.entry-missing',
            ]),
        );
    });
});

describe('a declared agent with no persona — genie#245 itself', () => {
    it('names the agent, the file, and both ways out', () => {
        const finding = findingIn('missing-persona', 'agents.persona-missing');

        expect(finding.severity).toBe('error');
        expect(finding.where).toContain(path.join('.agents', 'strategist.md'));
        expect(finding.problem).toContain('Strategist');
        // Both ways out, because either is legitimate: ship the file, or stop
        // promising the agent.
        expect(finding.fix).toMatch(/add the file/i);
        expect(finding.fix).toMatch(/drop|remove/i);
    });
});

describe('an app that installs and opens on nothing', () => {
    it('says the window will be EMPTY, not that a file is absent', () => {
        // "index.html not found" is a fact. "The window opens on an empty page"
        // is the thing the developer is about to be confused by.
        const finding = findingIn('blank-window', 'frontend.no-index');

        expect(finding.where).toMatch(/index\.html$/);
        expect(finding.problem).toMatch(/empty page/i);
        expect(finding.fix).toContain('frontend.serve.root');
    });

    it('catches the front end reaching for `window.genie`, and names the file', () => {
        const finding = findingIn('blank-window', 'frontend.window-genie');

        expect(finding.where).toMatch(/app\.js$/);
        expect(finding.problem).toContain('window.genie');
        expect(finding.fix).toContain('window.genieApp');
        expect(finding.fix).toContain('@genie/app-sdk');
    });
});

describe('a roster the window cannot run', () => {
    it('does the arithmetic and names who never starts', () => {
        const finding = findingIn('stranded-agents', 'agents.unreachable');

        expect(finding.severity).toBe('error');
        expect(finding.problem).toContain('3');
        expect(finding.problem).toContain('Reviewer');
        expect(finding.problem).toContain('Reporter');
        // Never "Strategist" as stranded — it is the one that DOES run.
        expect(finding.fix).toContain('panels.agents');
        expect(finding.fix).toContain('3');
    });
});

describe('a service whose entry file was renamed', () => {
    it('gives the path it looked at, so a wrong `repo` is visible', () => {
        const finding = findingIn('missing-service-entry', 'service.entry-missing');

        expect(finding.where).toBe(path.join(FIXTURES, 'missing-service-entry', 'service', 'server.py'));
        expect(finding.problem).toContain('api');
        expect(finding.problem).toContain('server.py');
    });

    it('also notices the runtime it never declared', () => {
        const finding = findingIn('missing-service-entry', 'service.runtime-undeclared');

        expect(finding.severity).toBe('advice');
        expect(finding.fix).toContain('"tool": "python"');
    });
});

describe('a tab pointed at somebody else’s origin', () => {
    it('is refused by the manifest validator, and the reason survives to the report', () => {
        // A tab is Genie chrome wearing this app's name. This is the one check the
        // suite must NOT own a copy of — it is a security rule, and it lives in the
        // real validator.
        const finding = findingIn('offsite-tab', 'manifest.schema');

        expect(finding.problem).toContain('tabs[0].path');
        expect(finding.problem).toMatch(/app'?’?s own site/i);
    });
});

describe('a capability no app may ever have', () => {
    it('says so, says why, and does not send the developer hunting', () => {
        const finding = findingIn('ungrantable-capability', 'manifest.schema');

        expect(finding.problem).toContain('submitFeedback');
        expect(finding.problem).toMatch(/no app may use/i);
        expect(finding.problem).toMatch(/in their name/i);
    });
});

describe('the report a developer actually reads', () => {
    it('leads with the app, then the errors, then what to do about each', () => {
        const report = checkFixture('blank-window');
        const text = formatCheckReport(report, path.join(FIXTURES, 'blank-window'));

        expect(text).toContain('Blank Window 1.0.0');
        expect(text).toContain('ERRORS');
        expect(text).toContain('[frontend.no-index]');
        expect(text).toMatch(/→ /);
        // Nothing is left as a bare boolean anywhere in it.
        expect(text).not.toMatch(/expected .* to be/);
    });

    it('does not drown the reader — every line stays readable in a terminal', () => {
        // The folder is a SHORT LITERAL here, not `path.join(FIXTURES, …)`.
        //
        // `formatCheckReport` puts the folder verbatim on its first line, so the
        // original form measured the DEVELOPER'S ABSOLUTE PATH rather than the
        // report's own formatting. Identical code passed in a normal checkout and
        // failed in a git worktree, whose prefix is ~40 characters longer
        // (genie#359) — so every agent working in a worktree met a red suite it
        // had not caused, on every run, and had to learn to ignore it.
        //
        // A caller's deep path is not a formatting defect, and truncating it
        // inside `formatCheckReport` would be worse: a half-printed path is no
        // use to the person the report is FOR. So the test controls its own input
        // and measures the only thing it can be responsible for — the lines the
        // report composes itself.
        const report = checkFixture('stranded-agents');
        const text = formatCheckReport(report, '/fixtures/stranded-agents');

        // POSITIVE CONTROL. "every line is short" passes perfectly against an
        // empty report, so prove there is something to measure first.
        expect(report.findings.length).toBeGreaterThan(0);
        expect(text.split('\n').length).toBeGreaterThan(3);

        for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(120);
    });
});

describe('the filesystem probe itself', () => {
    it('does not walk into node_modules, which would take minutes and find nothing', () => {
        // The cap that keeps this usable on a real front-end repo. A suite that
        // takes a minute is one nobody runs twice.
        const probe = fsCheckProbe({ slugTaken: () => false });
        const files = probe.listFiles(path.join(FIXTURES, 'sound'));

        expect(files.length).toBeGreaterThan(0);
        expect(files.every((f) => !f.includes(`${path.sep}node_modules${path.sep}`))).toBe(true);
    });

    it('answers null for a file that is not there, rather than throwing', () => {
        const probe = fsCheckProbe({ slugTaken: () => false });
        expect(probe.readText(path.join(FIXTURES, 'sound', 'nope.txt'))).toBeNull();
    });
});

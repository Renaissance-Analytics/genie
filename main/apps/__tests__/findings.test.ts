import { describe, expect, it } from 'vitest';
import {
    findingLine,
    formatCheckReport,
    type AppFinding,
} from '../findings';

/**
 * The FORM every check answer takes, and how it reads (genie#245 follow-on).
 *
 * The suite's deliverable is not the checks — it is what a developer reads when one
 * fails. `expected true, got false` is what they got before; the failure this whole
 * thing exists to prevent (a GApp that installs, opens, and shows an empty terminal
 * with no error) is invisible unless the message says WHAT is wrong, WHERE, and WHAT
 * TO DO about it. So the shape enforces all three, and the formatter is tested like
 * any other output people depend on.
 */

const error = (over: Partial<AppFinding> = {}): AppFinding => ({
    check: 'agents.persona-missing',
    severity: 'error',
    where: 'C:/src/trader/.agents/reviewer.md',
    problem: 'The agent "Reviewer" is declared, but its persona file is not there.',
    fix: 'Create the file, or drop "Reviewer" from `agents`.',
    ...over,
});

describe('one finding, as a single line', () => {
    it('carries the fix, because a problem without one is half a sentence', () => {
        // This is what the legacy `errors: string[]` list is built from, and what
        // every caller that joins those strings ends up showing the user.
        expect(findingLine(error())).toBe(
            'The agent "Reviewer" is declared, but its persona file is not there. ' +
                'Create the file, or drop "Reviewer" from `agents`.',
        );
    });
});

describe('the whole report, as a developer reads it', () => {
    const report = (findings: AppFinding[]) => ({
        ok: findings.every((f) => f.severity !== 'error'),
        findings,
        ran: ['manifest.schema', 'agents.persona-missing'],
        app: { id: 'com.example.trader', slug: 'trader', name: 'Trader', version: '1.0.0' },
    });

    it('names the app, the folder, and how much was checked', () => {
        const text = formatCheckReport(report([]), 'C:/src/trader');

        expect(text).toContain('Trader 1.0.0');
        expect(text).toContain('C:/src/trader');
        expect(text).toContain('2 checks');
    });

    it('says so plainly when there is nothing to fix', () => {
        const text = formatCheckReport(report([]), 'C:/src/trader');

        expect(text).toMatch(/ready to install/i);
        // Nothing that reads as a problem when there is none.
        expect(text).not.toMatch(/\bERROR\b/);
    });

    it('prints WHAT, WHERE and WHAT TO DO for every failure', () => {
        const text = formatCheckReport(report([error()]), 'C:/src/trader');

        // The check id, so it can be looked up, filtered, and asserted on.
        expect(text).toContain('agents.persona-missing');
        // WHERE.
        expect(text).toContain('C:/src/trader/.agents/reviewer.md');
        // WHAT.
        expect(text).toContain('The agent "Reviewer" is declared');
        // WHAT TO DO — visibly separated, not buried at the end of the sentence.
        expect(text).toMatch(/→\s*Create the file/);
    });

    it('keeps advice UNDER a heading of its own, never mixed into the errors', () => {
        // Merging them trains people to skim both, and the one that gets skimmed is
        // always the one that mattered.
        const text = formatCheckReport(
            report([
                error(),
                error({
                    check: 'permissions.high-risk',
                    severity: 'advice',
                    where: 'genie-app.json → permissions.capabilities',
                    problem: '“Run commands” is a high-risk permission.',
                    fix: 'Make sure the app still works without it.',
                }),
            ]),
            'C:/src/trader',
        );

        const errorsAt = text.indexOf('agents.persona-missing');
        const adviceAt = text.indexOf('permissions.high-risk');
        expect(errorsAt).toBeGreaterThanOrEqual(0);
        expect(adviceAt).toBeGreaterThan(errorsAt);
        expect(text).toMatch(/second thought/i);
    });

    it('wraps long text instead of emitting one unreadable line', () => {
        const text = formatCheckReport(
            report([
                error({
                    problem: 'x'.repeat(40) + ' ' + 'y'.repeat(40) + ' ' + 'z'.repeat(40),
                }),
            ]),
            'C:/src/trader',
        );

        for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    });
});

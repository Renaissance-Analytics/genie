import { describe, expect, it } from 'vitest';
import { runGappCheck, type CheckCliIO } from '../check-cli';
import type { AppCheckReport } from '../checkup';
import type { AppFinding } from '../findings';

/**
 * The command a developer (or the agent building their app) actually runs.
 *
 * The decisions here are small and they are exactly the ones a CI job depends on:
 * which folder, what gets printed, and — the only part a pipeline can see — what
 * the exit code is. A CLI that printed a perfect report and exited 0 on a broken
 * app would be worse than no CLI, because it would be trusted.
 */

const finding = (severity: AppFinding['severity']): AppFinding => ({
    check: severity === 'error' ? 'frontend.no-index' : 'permissions.high-risk',
    severity,
    where: 'somewhere',
    problem: 'something',
    fix: 'do something about it',
});

const io = (report: Partial<AppCheckReport> = {}): CheckCliIO & { out: string[] } => {
    const out: string[] = [];
    return {
        out,
        cwd: () => 'C:/current',
        check: (folder) => ({
            ok: true,
            findings: [],
            ran: ['install-gate'],
            app: { id: 'com.example.x', slug: 'x', name: folder, version: '1.0.0' },
            ...report,
        }),
        write: (text) => out.push(text),
    };
};

describe('which folder it checks', () => {
    it('takes the one named on the command line', () => {
        const cli = io();
        runGappCheck(['C:/src/trader'], cli);

        expect(cli.out.join('')).toContain('C:/src/trader');
    });

    it('falls back to the working directory, which is where a developer already is', () => {
        const cli = io();
        runGappCheck([], cli);

        expect(cli.out.join('')).toContain('C:/current');
    });
});

describe('what a pipeline sees', () => {
    it('exits 0 when the app is sound', () => {
        expect(runGappCheck(['C:/src/trader'], io())).toBe(0);
    });

    it('exits 1 on an error, so a broken app cannot be merged green', () => {
        expect(
            runGappCheck(['C:/src/trader'], io({ ok: false, findings: [finding('error')] })),
        ).toBe(1);
    });

    it('exits 0 on advice, because advice is not a failure', () => {
        expect(runGappCheck(['C:/src/trader'], io({ findings: [finding('advice')] }))).toBe(0);
    });

    it('fails on advice too when asked to — for a project that wants the bar there', () => {
        expect(
            runGappCheck(['C:/src/trader', '--strict'], io({ findings: [finding('advice')] })),
        ).toBe(1);
    });
});

describe('what it prints', () => {
    it('writes the report a person reads, by default', () => {
        const cli = io({ ok: false, findings: [finding('error')] });
        runGappCheck(['C:/src/trader'], cli);

        const text = cli.out.join('');
        expect(text).toContain('[frontend.no-index]');
        expect(text).toContain('→ do something about it');
    });

    it('writes machine-readable findings on --json, for an agent to act on', () => {
        const cli = io({ ok: false, findings: [finding('error')] });
        runGappCheck(['C:/src/trader', '--json'], cli);

        const parsed = JSON.parse(cli.out.join(''));
        expect(parsed.ok).toBe(false);
        expect(parsed.folder).toBe('C:/src/trader');
        expect(parsed.findings[0]).toMatchObject({
            check: 'frontend.no-index',
            severity: 'error',
            fix: 'do something about it',
        });
    });

    it('never mixes the two — JSON out has to parse', () => {
        // A stray banner on stdout is what turns "pipe it to jq" into a bug report.
        const cli = io();
        runGappCheck(['C:/src/trader', '--json'], cli);

        expect(() => JSON.parse(cli.out.join(''))).not.toThrow();
    });
});

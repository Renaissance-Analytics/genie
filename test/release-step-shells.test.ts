import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A RELEASE STEP WRITTEN IN BASH SAYS SO. Measured on the 2.0.0-beta.20 release run (2026-10-13): the publish step had
 * become bash (`tag="${GITHUB_REF_NAME#v}"`, `case … esac`) and the Windows runner ran it in its DEFAULT shell,
 * PowerShell — `ParserError … line 3` — so the Windows installer was never built while the Linux job (bash by default)
 * passed. CI's packaging jobs never run the publish step, so nothing caught it before a release. Every step of a job that
 * runs on Windows whose script uses bash syntax must declare `shell: bash`.
 */
const wf = readFileSync('.github/workflows/release.yml', 'utf8').replace(/\r\n/g, '\n');

/** The `run:` steps of the build-and-publish job (the one whose matrix includes windows-latest), each with its own text. */
function windowsSteps(): Array<{ name: string; text: string }> {
    const jobStart = wf.search(/\n  [a-z-]+:\n(?:(?!\n  [a-z-]+:\n)[\s\S])*?windows-latest/);
    expect(jobStart).toBeGreaterThan(-1);
    const rest = wf.slice(jobStart + 1);
    const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
    const job = next === -1 ? rest : rest.slice(0, next + 1);
    return job.split(/\n      - /).slice(1).map((s) => ({ name: (s.match(/name:\s*(.+)/) ?? [, '(unnamed)'])[1]!.trim(), text: s }));
}
const BASH_ONLY = /\$\{[A-Za-z_]+#|\bcase\b[\s\S]*\besac\b|\bfi\b\s*$|\[\[ /m;

describe('the release workflow on Windows', () => {
    it('every step whose script is bash declares shell: bash — counted, so an offender is named', () => {
        const steps = windowsSteps();
        expect(steps.length).toBeGreaterThan(3);
        const bashSteps = steps.filter((s) => /\brun:/.test(s.text) && BASH_ONLY.test(s.text));
        // Positive control: the scan does find the bash-syntax steps (the publish step is one).
        expect(bashSteps.map((s) => s.name)).toContain('publish');
        expect(bashSteps.filter((s) => !/\n\s+shell:\s*bash\b/.test(s.text)).map((s) => s.name)).toEqual([]);
    });
});

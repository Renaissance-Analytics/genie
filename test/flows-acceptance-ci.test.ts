import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE FLOWS ACCEPTANCE SUITE IS WIRED (the owner, 2026-10-27: test every trigger and node "only when we make changes to
 * flows"). It lives in test/flows-acceptance/ as `*.accept.ts`, run by `npm run verify:flows` and by CI's `flows acceptance`
 * job when a change touches Flows. This file holds the wiring: the script, the job, and the job's idea of "touches Flows" —
 * run against real paths, so a pattern that silently matches nothing (or everything) is caught here, in the default suite.
 */

// Comments stripped by line first: a step mentioned in a comment is not a step.
const code = (yaml: string) => yaml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
const ci = code(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const job = ci.slice(ci.indexOf('\n  flows:'), ci.indexOf('\n  test-windows:'));

describe('the Flows acceptance suite', () => {
    it('`npm run verify:flows` runs its own config, which includes only the acceptance files — `npm test` does not pick them up', () => {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
        expect(pkg.scripts['verify:flows']).toBe('vitest run -c vitest.flows.config.mts');
        const config = readFileSync(new URL('../vitest.flows.config.mts', import.meta.url), 'utf8');
        expect(config).toContain("include: ['test/flows-acceptance/**/*.accept.ts']");
        expect('test/flows-acceptance/triggers.accept.ts').not.toMatch(/\.test\.(ts|tsx)$/);
    });

    it('CI has a `flows acceptance` job that always reports and runs the suite only when Flows changed', () => {
        expect(job).toContain('name: flows acceptance');
        // No job-level `if:` and no `on.paths` filter: a required check that never reports blocks every other PR.
        expect(job).not.toMatch(/\n {4}if:/);
        expect(ci).not.toMatch(/\n\s+paths:/);
        expect(job).toMatch(/- run: npm run verify:flows\n\s+if: steps\.changed\.outputs\.flows == 'true'/);
    });

    it('its path rule: flow sources, the editor, the schedule and file-trigger cores, the suite — nothing else; and the fancy-flow dependency', () => {
        const rule = /grep -qE '([^']+)'/.exec(job)![1]!;
        // The rule is a POSIX ERE written so it reads the same as a JavaScript RegExp (nothing whose meaning differs).
        const matches = (path: string) => new RegExp(rule).test(path);
        for (const path of ['src/main/flow-runner.ts', 'src/main/flow-tools.ts', 'src/core/flow-canvas.ts', 'src/renderer/components/FlowEditorWindow.tsx', 'src/main/v1-flows.ts', 'src/core/cron.ts', 'src/core/file-trigger.ts', 'test/flows-acceptance/harness.ts', 'vitest.flows.config.mts']) {
            expect(matches(path), path).toBe(true);
        }
        for (const path of ['src/main/compose.ts', 'src/main/process-supervisor.ts', 'test/flows.test.ts', 'README.md', 'package.json']) {
            expect(matches(path), path).toBe(false);
        }
        expect(job).toContain(`-- package.json | grep -qE '^[+-].*"@particle-academy/fancy-flow"'`);
        expect(job).toContain(`-- package-lock.json | grep -qE '^[+-].*fancy-flow-[0-9]'`);
    });
});

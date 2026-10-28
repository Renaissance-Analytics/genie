import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WINDOW_PATH, flowsDependencySet, importGraph, runtimeImports, srcFiles } from '../scripts/flows-paths.mjs';

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

    it('its rule covers every file Flows are made of — not only the files named flow (genie#1302 broke the editor through core/address.ts, and the job never ran)', () => {
        const rule = new RegExp(/grep -qE '([^']+)'/.exec(job)![1]!);
        expect(flowsDependencySet().filter((path) => !rule.test(path))).toEqual([]);
    });
});

/**
 * WHAT FLOWS ARE MADE OF (scripts/flows-paths.mjs): the flow files, the editor window's route, everything they import at
 * run time, and the files that import a flow file. Walked from the code, so it is checked here against the code.
 */
describe('the Flows dependency set', () => {
    const set = flowsDependencySet();
    const graph = importGraph();
    const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

    it('the walker sees every run-time import under src/ — no relative import it cannot resolve to a file', () => {
        expect(srcFiles().flatMap((f) => runtimeImports(f).unresolved)).toEqual([]);
        // Positive controls, one of each shape: a plain import, a multi-line one, a dynamic import(), an `export … from`.
        expect(graph.get('src/main/flow-runner.ts')).toContain('src/main/flow-executors.ts');
        expect(source('src/renderer/components/FlowEditorWindow.tsx')).toMatch(/^import \{\r?\n[^}]*\} from '\.\.\/\.\.\/core\/flow-canvas\.js'/m);
        expect(graph.get('src/renderer/components/FlowEditorWindow.tsx')).toContain('src/core/flow-canvas.ts');
        expect(source('src/main/entry.ts')).toContain("import('./main.js')");
        expect(graph.get('src/main/entry.ts')).toContain('src/main/main.ts');
        // serve-config.ts reaches gen-name.ts only by re-exporting from it.
        expect(source('src/core/serve-config.ts')).toMatch(/^export \{ genHost \} from '\.\/gen-name\.js'/m);
        expect(graph.get('src/core/serve-config.ts')).toContain('src/core/gen-name.ts');
    });

    it('`import type` is not a run-time edge', () => {
        // flow-scheduler.ts imports flow-store.ts for its types only, and cron.ts for code.
        expect(source('src/main/flow-scheduler.ts')).toMatch(/^import type \{[^}]*\} from '\.\/flow-store\.js'/m);
        expect(graph.get('src/main/flow-scheduler.ts')).not.toContain('src/main/flow-store.ts');
        expect(graph.get('src/main/flow-scheduler.ts')).toContain('src/core/cron.ts');
    });

    it('holds the flow files, what they run, the editor window\'s route and the files Flows are wired in by', () => {
        for (const path of [
            // named flow
            'src/main/flow-runner.ts', 'src/main/flow-store.ts', 'src/main/mcp-tools-flows.ts', 'src/main/v1-flows.ts', 'src/renderer/components/FlowEditorWindow.tsx',
            // what they run: the schedule, the file trigger, and every Genie tool a tool step can call
            'src/core/cron.ts', 'src/core/file-trigger.ts', 'src/main/mcp-registrations.ts', 'src/main/mcp-tools.ts',
            // the editor window's route and window (genie#1302)
            'src/core/address.ts', 'src/core/route.ts', 'src/core/window-activation.ts', 'src/core/view-requests.ts', 'src/main/preload.ts',
            // wiring: the files that import a flow file
            'src/main/compose.ts', 'src/main/feature-ipc.ts', 'src/main/main.ts', 'src/renderer/App.tsx', 'src/renderer/components/FeatureSurfaces.tsx',
        ]) expect(set, path).toContain(path);
        // …and not the rest of Genie: the hubs' own imports are not followed.
        for (const path of ['src/main/terminal-host.ts', 'src/main/process-supervisor.ts', 'src/core/toolchain.ts', 'src/renderer/components/TakeOverWindow.tsx', 'src/renderer/Shell.tsx']) {
            expect(set, path).not.toContain(path);
        }
        expect(set.length).toBeLessThan(srcFiles().length / 4);
    });

    it('the editor window\'s path is what App.tsx and main.ts really use to route and open it', () => {
        expect(WINDOW_PATH).toEqual(['src/core/address.ts', 'src/core/route.ts', 'src/core/window-activation.ts', 'src/core/view-requests.ts', 'src/main/preload.ts']);
        expect(graph.get('src/renderer/App.tsx')).toEqual(expect.arrayContaining(['src/core/address.ts', 'src/core/route.ts', 'src/renderer/components/FlowEditorWindow.tsx']));
        expect(graph.get('src/main/main.ts')).toEqual(expect.arrayContaining(['src/core/window-activation.ts', 'src/core/view-requests.ts']));
        const main = source('src/main/main.ts');
        const open = main.slice(main.indexOf('function openFlowEditorWindow('), main.indexOf('function closeWindowAt('));
        expect(open).toContain("preload: join(here, 'preload.cjs')");
        expect(source('vite.preload.config.ts')).toContain("preload: 'src/main/preload.ts'");
        // Each one handles the flow route in code, not in a comment.
        const codeOf = (path: string) => source(path).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(codeOf('src/core/address.ts')).toMatch(/'flow'/);
        expect(codeOf('src/core/route.ts')).toMatch(/case 'flow'/);
        expect(codeOf('src/core/window-activation.ts')).toContain("'genie://flow/'");
        expect(codeOf('src/core/view-requests.ts')).toMatch(/export function viewReaches/);
    });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WINDOW_PATH, flowsDependencySet, importGraph, runtimeImports, srcFiles, touchedFlows } from '../scripts/flows-paths.mjs';

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
const repo = fileURLToPath(new URL('..', import.meta.url));

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

    it('it asks scripts/flows-paths.mjs which changed files touch Flows (not a rule on names), and checks the fancy-flow dependency', () => {
        expect(job).toContain('git diff --name-only "$BASE" HEAD > "$RUNNER_TEMP/changed.txt"');
        expect(job).toContain('node scripts/flows-paths.mjs --touched "$RUNNER_TEMP/changed.txt" > "$RUNNER_TEMP/touched.txt"');
        expect(job).toMatch(/if \[ -s "\$RUNNER_TEMP\/touched\.txt" \]; then [^\n]*flows=true; fi/);
        expect(job).toContain(`git diff "$BASE" HEAD -- package.json > "$RUNNER_TEMP/package.diff"`);
        expect(job).toContain(`if grep -qE '^[+-].*"@particle-academy/fancy-flow"' "$RUNNER_TEMP/package.diff"; then flows=true; fi`);
        expect(job).toContain(`git diff "$BASE" HEAD -- package-lock.json > "$RUNNER_TEMP/package-lock.diff"`);
        expect(job).toContain(`if grep -qE '^[+-].*fancy-flow-[0-9]' "$RUNNER_TEMP/package-lock.diff"; then flows=true; fi`);
        // Nothing piped into grep: `grep -q` exits at its first match, the writer dies of SIGPIPE, and pipefail reads a
        // match as none — the suite would be skipped exactly when the dependency changed.
        expect(job).not.toMatch(/\|\s*grep/);
        // node makes the decision, so node is set up before it — for every change, not only the ones that touch Flows.
        const setup = job.indexOf('uses: actions/setup-node@v4');
        expect(setup).toBeGreaterThan(-1);
        expect(setup).toBeLessThan(job.indexOf('node scripts/flows-paths.mjs'));
        expect(job.slice(setup, job.indexOf('- name: did this change touch Flows?'))).not.toContain('if:');
    });

    it('its decision covers every file Flows are made of — not only the files named flow (genie#1302 broke the editor through core/address.ts, and the job never ran)', () => {
        const set = flowsDependencySet();
        expect(touchedFlows(set)).toEqual(set);
        expect(touchedFlows(['README.md', 'src/core/address.ts'])).toEqual(['src/core/address.ts']);
        // The suite, its config and the script that decides; and a flow file that was DELETED (it is in no graph).
        for (const path of ['test/flows-acceptance/harness.ts', 'vitest.flows.config.mts', 'scripts/flows-paths.mjs', 'src/main/flow-gone.ts']) {
            expect(touchedFlows([path]), path).toEqual([path]);
        }
        // Not the rest of Genie, not the unit tests (the default suite runs them), not package.json by itself.
        expect(touchedFlows(['src/main/terminal-host.ts', 'src/renderer/Shell.tsx', 'test/flows.test.ts', 'README.md', 'package.json', ''])).toEqual([]);
    });

    it('`--touched <file>` prints the paths that touch Flows, one per line, and nothing when none do', () => {
        const dir = mkdtempSync(join(tmpdir(), 'flows-paths-'));
        try {
            const list = join(dir, 'changed.txt');
            const touched = (paths: string[]) => {
                writeFileSync(list, `${paths.join('\n')}\n`);
                return execFileSync(process.execPath, ['scripts/flows-paths.mjs', '--touched', list], { cwd: repo, encoding: 'utf8' });
            };
            expect(touched(['README.md', 'src/core/address.ts', 'src/core/route.ts'])).toBe('src/core/address.ts\nsrc/core/route.ts\n');
            expect(touched(['README.md', 'src/main/terminal-host.ts'])).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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

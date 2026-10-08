import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as simpleGitModule from 'simple-git';
import { codeOnly } from './support/code-only';

/**
 * EVERY `simple-git` IMPORT MUST BE NAMED — and this guard exists because nothing else could
 * have caught it (genie#842).
 *
 * simple-git 4.x removed the default export. `main/issue-watch/index.ts` used
 * `import simpleGit from 'simple-git'`, which after the upgrade is `undefined` at runtime, so
 * `simpleGit(p).getRemotes(true)` would throw *"simpleGit is not a function"* the first time
 * IssueWatch resolved a remote.
 *
 * **Three layers failed to see it:**
 *
 * 1. **`typecheck:main` PASSED.** `esModuleInterop` synthesises a default for a CommonJS
 *    module whether or not one exists, so the compiler accepted an import that resolves to
 *    `undefined`. Measured directly: `require('simple-git').default` is `undefined` in 4.0.2
 *    while `.simpleGit` is a function.
 * 2. **The issue-watch suite PASSED, 80 tests.** Its four files do
 *    `vi.mock('simple-git', () => ({ default: … }))` — they mock the very shape that no longer
 *    exists, so the mock kept the old contract alive in tests while production lost it.
 * 3. **The upgrade itself was silent.** No install warning, no deprecation.
 *
 * A breaking change that a typecheck, a mocked suite and the package manager all miss is one
 * that reaches a user. So the assertions below are deliberately of two different kinds:
 * the first reads the REAL module (no mock can reach this file), the second reads SOURCE.
 */

const MAIN = join(__dirname, '..');

describe('the simple-git module really exports what we import', () => {
    it('exports `simpleGit` as a function', () => {
        // The real module, unmocked. This is the assertion the mocked suites cannot make.
        expect(typeof simpleGitModule.simpleGit).toBe('function');
    });

    it('has NO default export, which is why the named form is mandatory', () => {
        /**
         * The positive control for the source guard below: it proves the rule is a response to
         * the package's actual shape rather than a style preference. If a future version
         * restores a default export this goes red, and the guard can be reconsidered on
         * purpose instead of drifting.
         */
        expect((simpleGitModule as Record<string, unknown>)['default']).toBeUndefined();
    });
});

describe('no source file uses the default import', () => {
    /**
     * Walked rather than listed: a hard-coded list of the ten call sites would pass while an
     * eleventh file reintroduced the broken form. Comments stripped via `codeOnly` (CRLF-safe)
     * so the prose above — which contains the forbidden line verbatim — cannot trip it.
     */
    function sourceFiles(dir: string): string[] {
        const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
        const out: string[] = [];
        for (const entry of readdirSync(dir)) {
            if (entry === 'node_modules' || entry === 'dist') continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
            else if (/\.(ts|tsx|mjs)$/.test(entry)) out.push(full);
        }
        return out;
    }

    const files = sourceFiles(MAIN);

    it('walks a real tree, so the guard cannot pass by finding nothing', () => {
        // Without this, a broken walk would report every file clean.
        expect(files.length).toBeGreaterThan(100);
        expect(files.some((f) => f.includes('issue-watch'))).toBe(true);
    });

    it('imports simple-git by NAME everywhere', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const code = codeOnly(readFileSync(file, 'utf8'));
            // `import simpleGit from 'simple-git'` / `import x, { y } from 'simple-git'` —
            // anything binding the module's default. A named-only import has `{` first.
            if (/import\s+[A-Za-z_$][\w$]*\s*(,\s*\{[^}]*\})?\s*from\s*['"]simple-git['"]/.test(code)) {
                offenders.push(file.slice(MAIN.length + 1));
            }
        }
        expect(
            offenders,
            `simple-git 4.x has no default export; these resolve to undefined at runtime: ${offenders.join(', ')}`,
        ).toEqual([]);
    });

    it('and no test mocks a default export that does not exist', () => {
        /**
         * The second half of the failure. Four issue-watch suites mocked
         * `{ default: … }`, which is what kept 80 tests green over a module that had lost its
         * default — a mock asserting a contract the real package had dropped.
         *
         * A mock may legitimately shape itself however the consumer imports, so this is pinned
         * to the one key that is now always wrong.
         */
        const offenders: string[] = [];
        for (const file of files) {
            const code = codeOnly(readFileSync(file, 'utf8'));
            const mocks = code.match(/vi\.mock\(\s*['"]simple-git['"][\s\S]{0,200}?\)\s*;/g) ?? [];
            if (mocks.some((m) => /\bdefault\s*:/.test(m))) offenders.push(file.slice(MAIN.length + 1));
        }
        expect(
            offenders,
            `these mock a simple-git default export, which no longer exists: ${offenders.join(', ')}`,
        ).toEqual([]);
    });
});

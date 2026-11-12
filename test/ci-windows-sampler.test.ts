import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { windowsFunction } from './helpers/ci-scripts.js';

/*
 * THE SAMPLER BESIDE `unit (windows)` IS OBSERVE-ONLY (scripts/ci/proc-sampler.ps1). It changes no test and no budget,
 * writes only its own samples (uploaded as an artifact), prints a short summary only when the suite failed, and never
 * outlives the step: stopped in a `finally`, and bounded by its own deadline inside the job's.
 */
const job = windowsFunction('Row-unit');
const sampler = readFileSync(new URL('../scripts/ci/proc-sampler.ps1', import.meta.url), 'utf8');

describe('the Windows unit row\'s sampler (scripts/ci/windows.ps1)', () => {
    it('runs the same suite with the same budget, and only adds a results file', () => {
        expect(job).toMatch(/npm test -- --testTimeout=30000 --reporter=default --reporter=json "--outputFile\.json=\$results"/);
    });
    it('is stopped when the suite ends, whatever happened', () => {
        expect(job).toMatch(/try \{[^]*npm test[^]*\} finally \{\s*Stop-Process -Id \$sampler\.Id -Force/);
    });
    it('prints its summary only for a failed suite, and the step keeps the suite\'s own exit code', () => {
        expect(job).toMatch(/if \(\$code -ne 0\) \{ node scripts\/ci\/proc-sampler-summary\.mjs \$samples \$results \}/);
        expect(job).toMatch(/if \(\$code -ne 0\) \{ throw "npm test failed \(exit \$code\)" \}/);
    });
    it('ends itself on its own even if nothing stops it, and the row stops it first', () => {
        expect(Number(/\[int\]\$Seconds = (\d+)/.exec(sampler)?.[1])).toBeGreaterThan(0);
        expect(job).toMatch(/finally \{\s*Stop-Process -Id \$sampler\.Id -Force/);
    });
});

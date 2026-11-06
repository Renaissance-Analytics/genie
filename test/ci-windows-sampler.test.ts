import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * THE SAMPLER BESIDE `unit (windows)` IS OBSERVE-ONLY (scripts/ci/proc-sampler.ps1). It changes no test and no budget,
 * writes only its own samples (uploaded as an artifact), prints a short summary only when the suite failed, and never
 * outlives the step: stopped in a `finally`, and bounded by its own deadline inside the job's.
 */
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const job = ci.slice(ci.indexOf('name: unit (windows)'), ci.indexOf('\n  zip64:'));
const sampler = readFileSync(new URL('../scripts/ci/proc-sampler.ps1', import.meta.url), 'utf8');

describe('the Windows unit job\'s sampler', () => {
    it('runs the same suite with the same budget, and only adds a results file', () => {
        expect(job).toMatch(/npm test -- --testTimeout=30000 --reporter=default --reporter=json "--outputFile\.json=\$results"/);
    });
    it('is stopped when the suite ends, whatever happened', () => {
        expect(job).toMatch(/try \{[^]*npm test[^]*\} finally \{\s*Stop-Process -Id \$sampler\.Id -Force/);
    });
    it('prints its summary only for a failed suite, and the step keeps the suite\'s own exit code', () => {
        expect(job).toMatch(/if \(\$code -ne 0\) \{ node scripts\/ci\/proc-sampler-summary\.mjs \$samples \$results \}\s*exit \$code/);
    });
    it('uploads its samples whatever the outcome', () => {
        expect(job).toMatch(/name: the sampler's samples\s+if: always\(\)\s+uses: actions\/upload-artifact@v4/);
    });
    it('ends itself inside the job\'s time even if nothing stops it', () => {
        const seconds = Number(/\[int\]\$Seconds = (\d+)/.exec(sampler)?.[1]);
        const minutes = Number(/timeout-minutes: (\d+)/.exec(job)?.[1]);
        expect(seconds).toBeGreaterThan(0);
        expect(seconds).toBeLessThan(minutes * 60);
    });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * EVERY WINDOWS SMOKE GATES THE JOB (found 2026-10-21 on genie#1050: the "a real window (windows)" job PASSED while its
 * log said "FAIL 3. CONTROL: a real provider process exists for it" and "Codex app-server startup failed"). In pwsh a
 * native command that exits non-zero does not stop the script, and the step's result is the LAST command's exit code —
 * so of the three smokes run in a row only the last one ever gated; agents-hold-no-pty and smoke-cdp could fail in plain
 * sight on a green job. Each smoke now ends the step when it fails. (Bash on Linux runs `-e`: each line already gates.)
 */

const ci = readFileSync('.github/workflows/ci.yml', 'utf8').split(/\r?\n/);

describe('the Windows real-window step', () => {
    const runs = ci.map((line, i) => ({ line, i })).filter(({ line }) => /^\s+node scripts\/[a-z-]+\.mjs\s*$/.test(line));
    const windows = runs.filter(({ i }) => ci.slice(0, i).reverse().find((l) => /^\s+shell:/.test(l))?.includes('pwsh'));

    it('runs the three smokes (COUNTED, so a removed smoke is not a quiet pass)', () => {
        expect(windows.map(({ line }) => line.trim())).toEqual(['node scripts/agents-hold-no-pty-cdp.mjs', 'node scripts/smoke-cdp.mjs', 'node scripts/layout-sweep.mjs']);
    });

    it('each is followed by a check that ends the step on its failure', () => {
        for (const { line, i } of windows) {
            expect(ci[i + 1] ?? '', `after ${line.trim()}`).toMatch(/^\s+if \(\$LASTEXITCODE -ne 0\) \{ throw "[^"]+ failed \(exit \$LASTEXITCODE\)" \}\s*$/);
        }
    });
});

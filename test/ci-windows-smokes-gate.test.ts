import { describe, expect, it } from 'vitest';
import { windowsFunction, windowsPs1 } from './helpers/ci-scripts.js';

/**
 * EVERY WINDOWS SMOKE GATES THE JOB (found 2026-10-21 on genie#1050: the "a real window (windows)" job PASSED while its
 * log said "FAIL 3. CONTROL: a real provider process exists for it" and "Codex app-server startup failed"). In pwsh a
 * native command that exits non-zero does not stop the script, and the step's result is the LAST command's exit code —
 * so of the three smokes run in a row only the last one ever gated; agents-hold-no-pty and smoke-cdp could fail in plain
 * sight on a green job. Each smoke now ends the step when it fails. (Bash on Linux runs `-e`: each line already gates.)
 */

// THE GATE NOW (Tynn #692): scripts/ci/windows.ps1 runs each smoke as its own row through `Run '<name>' { node … }`, which
// throws when the command exits non-zero; a row that throws is a FAIL and the run's exit is 1.
const smokes = ['agents-hold-no-pty-cdp', 'smoke-cdp', 'layout-sweep', 'trust-step-cdp', 'safe-mode-cdp', 'hang-cdp', 'renderer-crash-cdp'];

describe('the Windows real-window rows', () => {
    it('runs the smokes (COUNTED, so a removed smoke is not a quiet pass)', () => {
        const run = [...windowsPs1.matchAll(/Run '([a-z-]+)' \{ node scripts\/([a-z-]+)\.mjs \}/g)].map((m) => m[2]!);
        for (const smoke of smokes) expect(run.filter((x) => x === smoke), smoke).toHaveLength(1);
    });

    it('each ends its row on its failure: Run throws on a non-zero exit, naming the command', () => {
        expect(windowsFunction('Run')).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ throw "\$what failed \(exit \$LASTEXITCODE\)" \}/);
        for (const smoke of smokes) expect(windowsPs1, smoke).toMatch(new RegExp(`Run '${smoke}' \\{ node scripts/${smoke}\\.mjs \\}`));
    });
});

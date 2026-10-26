import { describe, expect, it } from 'vitest';
import { systemProcessTree } from '../src/core/process-tree.js';
import { listProcessesAsync } from '../src/main/process-list.js';

/**
 * THE ASYNCHRONOUS READINGS, AGAINST THE REAL MACHINE (genie#1201). READ-ONLY: nothing is killed. On Windows this is the
 * PowerShell `Get-CimInstance Win32_Process` reading run with execFile instead of execFileSync — the one a quit or an
 * install now takes without holding main — so it runs on the Windows test VM too. Proves each reading still finds
 * this very process (the positive control every absence claim rides on) and leaves its own scanner out.
 */
describe('real readings, taken asynchronously', () => {
    it('the process tree reads the machine, and this process is in it', async () => {
        const rows = await systemProcessTree.read!();
        expect(rows).not.toBeNull();
        expect(rows!.some((r) => r.pid === process.pid && r.started > 0 && r.name.length > 0)).toBe(true);
        // The scanner it spawned (powershell / ps) is not reported as one of this process's children.
        expect(rows!.some((r) => r.ppid === process.pid && /^(powershell(\.exe)?|ps)$/i.test(r.name))).toBe(false);
    }, 60_000);

    it('the upgrade’s listing by path finds this process’s own executable', async () => {
        const rows = await listProcessesAsync();
        expect(rows.some((r) => r.pid === process.pid && r.executable.toLowerCase() === process.execPath.toLowerCase())).toBe(true);
    }, 60_000);

    it('while a reading runs, the event loop keeps turning (it is not execFileSync)', async () => {
        let turns = 0;
        const timer = setInterval(() => { turns += 1; }, 5);
        await systemProcessTree.read!();
        clearInterval(timer);
        expect(turns).toBeGreaterThan(0);
    }, 60_000);
});

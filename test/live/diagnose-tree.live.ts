/**
 * What the process tree actually looks like around a live session, over time.
 *
 * Written because the reaper did not reap: after `stop()` two processes were still alive,
 * and two guesses about why (snapshot timing, `taskkill /T` coverage) are two guesses.
 * This prints the facts instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import { systemProcessTree } from '../../src/core/process-tree.js';

const dir = mkdtempSync(join(tmpdir(), 'genie2-diag-'));

function snap(label: string): readonly number[] {
    const pids = systemProcessTree.descendantsOf(process.pid);
    console.log(`${label.padEnd(26)} ${pids.length} descendant(s): ${pids.join(', ') || '(none)'}`);
    return pids;
}

async function main(): Promise<void> {
    const before = snap('before start');

    const driver = new ClaudeDriver(
        { cwd: dir, binary: 'claude', permissionMode: 'plan' },
        { onUpdate: () => {}, onExit: (c, s) => console.log(`driver exited code=${c} signal=${s}`) },
    );
    driver.start();

    snap('immediately after start');
    await new Promise((r) => setTimeout(r, 2_000));
    const settled = snap('after 2s');

    driver.prompt('Reply with exactly: ok');
    await new Promise((r) => setTimeout(r, 8_000));
    const midTurn = snap('mid-turn');

    const owned = midTurn.filter((p) => !before.includes(p));
    console.log(`\nowned (mid-turn minus baseline): ${owned.join(', ') || '(none)'}`);
    console.log(`settled-minus-baseline was:      ${settled.filter((p) => !before.includes(p)).join(', ') || '(none)'}`);

    driver.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 3_000));
    const afterKill = snap('after driver.kill');

    const survivors = afterKill.filter((p) => !before.includes(p));
    console.log(`\nSURVIVORS after driver.kill: ${survivors.join(', ') || '(none)'}`);

    if (survivors.length > 0) {
        systemProcessTree.killTree(survivors);
        await new Promise((r) => setTimeout(r, 2_000));
        const afterReap = snap('after killTree(survivors)');
        console.log(`\nstill alive after reap: ${afterReap.filter((p) => !before.includes(p)).join(', ') || '(none)'}`);
    }

    rmSync(dir, { recursive: true, force: true });
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

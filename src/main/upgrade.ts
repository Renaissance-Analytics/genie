import { isInside } from './paths.js';

/**
 * UPGRADES — §7, and two of the eight failures that ended the previous build.
 *
 * ## §0.6 — the upgrade that jammed on 31 orphans
 *
 * An upgrade stopped dead on **31 orphaned `OpenConsole.exe` processes, with no error message
 * at all.** The installer could not replace files those processes held open; the processes
 * were children of a Genie that had already exited; and nothing in the product knew they
 * existed. The user saw an update that simply never finished.
 *
 * Two things follow, and the first is structural: **the install directory is not the runtime
 * directory** (`paths.ts`), so nothing Genie spawns can hold an install file open in the first
 * place. The second is this module: before applying an update, find **every process running
 * from the install directory — not just the one with a pidfile** — and report it.
 *
 * ## §0.8 — the updater that could never see a release
 *
 * Every release publishes as a prerelease, `allowPrerelease` defaults to false, and it was
 * never set. "Check for updates" had never worked, for the entire life of the product.
 */

/** A process, as any lister can describe one. Narrow on purpose: this is the seam. */
export interface RunningProcess {
    pid: number;
    /** Absolute path to the executable. */
    executable: string;
    /** The parent's pid, or `null` when the lister could not tell. */
    parentPid: number | null;
}

/**
 * How many orphans a message names before it summarises.
 *
 * The cap is on the REPORT, never on the list. A teardown that killed only the first ten would
 * leave the rest holding files open, and the upgrade would jam exactly as it did before.
 */
export const ORPHAN_REPORT_LIMIT = 12;

/**
 * Every process running from the install directory, except our own TREE.
 *
 * Our own executable lives there too, and a teardown that killed the process performing the
 * upgrade would be an impressive way to fail. So would killing its children: Electron's
 * renderer, GPU and utility processes are the same executable under other pids, and on
 * 2026-10-10 the installed app's teardown named its own three and stopped them — the window
 * went blank mid-install. Descent is followed through `parentPid`; a process whose parent the
 * lister could not name stays IN, because an unplaceable process still holds our files. The
 * sibling-prefix check is `isInside`'s, so `…/Genie2` is never mistaken for `…/Genie` — that
 * mistake would reach into a different installation during our upgrade.
 */
export function orphansUnder(
    processes: readonly RunningProcess[],
    installDir: string,
    ownPid: number,
    caseInsensitive: boolean = process.platform === 'win32',
): readonly RunningProcess[] {
    const ours = new Set<number>([ownPid]);
    // Children can be listed before their parents, so walk until nothing new joins.
    let grew = true;
    while (grew) {
        grew = false;
        for (const p of processes) {
            if (!ours.has(p.pid) && p.parentPid !== null && ours.has(p.parentPid)) { ours.add(p.pid); grew = true; }
        }
    }
    return processes.filter((p) => !ours.has(p.pid) && isInside(p.executable, installDir, caseInsensitive));
}

/**
 * A sentence for a human, naming what was found.
 *
 * §7.2 requires the teardown to **report what was killed** — including when that is nothing,
 * because "we looked and found none" is a report and silence is not. The 31 orphans produced
 * no message at all, which is why nobody could act on them.
 */
export function orphanReport(orphans: readonly RunningProcess[]): string {
    if (orphans.length === 0) return 'No processes were running from the install directory.';

    const named = orphans.slice(0, ORPHAN_REPORT_LIMIT).map((p) => `${p.pid} ${p.executable}`);
    const rest = orphans.length - named.length;

    return [
        `${orphans.length} process${orphans.length === 1 ? '' : 'es'} were running from the install directory and had to be stopped:`,
        ...named,
        ...(rest > 0 ? [`…and ${rest} more.`] : []),
    ].join('\n');
}

/**
 * The updater's channel settings — a function of the UPDATE CHANNEL now (the owner, 2026-10-12:
 * "stable and dev update channels"; `src/core/update-channel.ts`).
 *
 * **`allowPrerelease` and how a tag publishes are a PAIR, per channel**, and
 * `test/update-channels.test.ts` and `test/upgrade.test.ts` assert both halves:
 *
 * - dev → `allowPrerelease: true` ↔ a suffixed tag (`v2.0.0-beta.20`) publishes as a prerelease
 *   (electron-builder.yml's `releaseType: prerelease` default);
 * - stable → `allowPrerelease: false` ↔ a plain tag (`v2.0.0`) publishes as a full release
 *   (`.github/workflows/release.yml` overrides the default with `--config.publish.releaseType` (electron-builder's documented dot-notation override)).
 *
 * Asserting only the flag lets somebody change the publish side later and leave a flag that now
 * does nothing — true, inert and reassuring. Asserting only the publish side lets somebody drop
 * the flag. The pair is what keeps either from going stale. `autoDownload` is `false` on every
 * channel: nothing downloads before a human has said yes.
 */
export { updaterConfigFor } from '../core/update-channel.js';

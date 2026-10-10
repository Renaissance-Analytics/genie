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
}

/**
 * How many orphans a message names before it summarises.
 *
 * The cap is on the REPORT, never on the list. A teardown that killed only the first ten would
 * leave the rest holding files open, and the upgrade would jam exactly as it did before.
 */
export const ORPHAN_REPORT_LIMIT = 12;

/**
 * Every process running from the install directory, except our own.
 *
 * Our own executable lives there too, and a teardown that killed the process performing the
 * upgrade would be an impressive way to fail. The sibling-prefix check is `isInside`'s, so
 * `…/Genie2` is never mistaken for `…/Genie` — that mistake would reach into a different
 * installation during our upgrade.
 */
export function orphansUnder(
    processes: readonly RunningProcess[],
    installDir: string,
    ownPid: number,
    caseInsensitive: boolean = process.platform === 'win32',
): readonly RunningProcess[] {
    return processes.filter(
        (p) => p.pid !== ownPid && isInside(p.executable, installDir, caseInsensitive),
    );
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
 * The updater's channel settings.
 *
 * **`allowPrerelease` and `electron-builder.yml`'s `releaseType: prerelease` are a PAIR**, and
 * `test/upgrade.test.ts` asserts both. Asserting only the flag lets somebody change the
 * publish channel later and leave a flag that now does nothing — true, inert and reassuring.
 * Asserting only the channel lets somebody drop the flag. The pair is what keeps either from
 * going stale.
 */
export const updaterChannel = {
    /**
     * Genie publishes prereleases, so the updater must be willing to see them.
     *
     * This defaults to FALSE in `electron-updater`, and the previous build never set it. Every
     * release it ever shipped was invisible to its own updater.
     */
    allowPrerelease: true,
    /**
     * Never download before a human has said yes.
     *
     * An update that downloads itself is an update that applies on next quit, which on a
     * machine running a dozen agents is a surprise rather than a convenience.
     */
    autoDownload: false,
} as const;

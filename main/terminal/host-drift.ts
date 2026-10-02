/**
 * IS THE RUNNING TERMINAL HOST THE ONE THIS BUILD SHIPS?
 *
 * The detached pty host survives a Genie update on purpose — that is why an
 * upgrade does not kill your terminals, and it is the behaviour people want. The
 * cost nobody was paying attention to: **its code only changes when it crashes
 * or someone restarts it by hand.**
 *
 * So a Genie that ships a newer `fancy-term-host` can run indefinitely against
 * an older one, silently. Observed: on 2026-09-30 the live host had been started
 * at 12:28 by a CRASH RECOVERY, and two upgrades later it was still that process.
 * It happened to match the shipped version — by luck, not because anything
 * checked.
 *
 * That matters beyond tidiness. A fix inside the host package cannot reach a
 * machine that never restarts its host, and the host is exactly where the
 * remaining terminal work lives (one process owns every terminal, so a native
 * fault takes them all). A host-side fix would ship, install, and change nothing.
 *
 * This is the check. It compares the key the running host's SCRIPT PATH was
 * materialized under with the key this build would use — the same
 * `fth<version>-npty<version>` directory name that `hostKeyFor` produces — and
 * says whether they differ.
 *
 * ## Why the script path, and not a version the host reports
 *
 * Because the script path is what the host actually LOADED. A version it
 * reported would be a claim about itself; the path is evidence of which copy is
 * mapped into the process, which is the thing that decides its behaviour. The
 * same reasoning as `detachedModePinsInstallTree`, which is careful to identify
 * the live pid AND its script rather than trusting a marker word.
 *
 * PURE. The caller supplies both facts; nothing here reads a file or a process.
 */

export interface HostDrift {
    /** The key this build would materialize a host under. */
    expected: string;
    /** The key the RUNNING host was materialized under, or null when unreadable. */
    running: string | null;
    /**
     * They differ, and both are known. Never true on an unreadable running key —
     * "we could not tell" must not be reported as "it is stale", or the notice
     * cries wolf on every machine whose marker predates this check.
     */
    drifted: boolean;
}

/**
 * The `fth…-npty…` directory a host script was materialized under.
 *
 * Returns null for anything that is not under a recognisable key — a host
 * running from the install tree or a repo checkout has no key, and inventing one
 * would manufacture a drift that is not there.
 */
export function hostKeyFromScriptPath(scriptPath: string | null | undefined): string | null {
    if (!scriptPath) return null;
    // Both separators: the marker is written on the host's platform and may be
    // read on another (tests, a copied user-data dir).
    const segments = scriptPath.split(/[\\/]+/);
    const key = segments.find((s) => /^fth[^-]*-npty/.test(s));
    return key ?? null;
}

/** Compare what is running with what this build ships. */
export function hostDrift(
    expectedKey: string,
    runningScriptPath: string | null | undefined,
): HostDrift {
    const running = hostKeyFromScriptPath(runningScriptPath);
    return {
        expected: expectedKey,
        running,
        drifted: running !== null && running !== expectedKey,
    };
}

/**
 * What to tell the owner, or null when there is nothing to say.
 *
 * Names BOTH versions and what it costs, because "your host is out of date" with
 * no consequence attached is a notice people learn to dismiss. The restart is
 * offered, never taken: it kills every terminal and every running process on the
 * machine, which is a decision for a person who knows what is mid-flight.
 */
export function hostDriftNotice(drift: HostDrift): string | null {
    if (!drift.drifted) return null;
    return (
        `Your terminal host is still running ${drift.running}; this build ships ` +
        `${drift.expected}. The host deliberately survives updates, so it keeps the ` +
        'older code until it is restarted — which means host-level fixes in this ' +
        'update have not reached this machine. Restarting it ends every terminal ' +
        'and background process, so it is not done for you.'
    );
}

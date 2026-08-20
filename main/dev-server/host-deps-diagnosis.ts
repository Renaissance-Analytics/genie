/**
 * PURE. Why a host-native site's dev server died on its first breath (genie#227).
 *
 * Reported from a workspace migrating off container hosting: the site failed
 * instantly with
 *
 *     'vite' is not recognized as an internal or external command
 *
 * which names the binary and says nothing about the cause. The dependencies had
 * only ever been installed INSIDE the Linux sandbox, so `node_modules/.bin` held
 * POSIX shims and no `.cmd`/`.ps1` — invisible to a Windows host process. A
 * host-side `npm install` fixed it in seconds, once the reporter knew that was the
 * question.
 *
 * Every workspace moving from container hosting to host-native hits this, and the
 * error points at the wrong thing every time.
 *
 * Silence is the default. A confident wrong diagnosis is worse than none, so this
 * speaks only when the log says a binary was missing AND the shim layout actually
 * explains it.
 */

/** The two spellings of "that binary is not on PATH". */
const MISSING_BINARY =
    /is not recognized as an internal or external command|command not found|: not found|\bENOENT\b/i;

/** A Windows host can only run these; a POSIX host can only run the extensionless ones. */
const WINDOWS_SHIM = /\.(cmd|ps1|bat|exe)$/i;

export interface HostSpawnFailure {
    /** The dev server's captured output. */
    log: string;
    platform: NodeJS.Platform | string;
    /**
     * What is in `node_modules/.bin`, or null when there is no such directory.
     * Null and empty mean different things: nothing installed vs installed and
     * unusable.
     */
    binEntries: string[] | null;
}

export function diagnoseHostSpawnFailure(failure: HostSpawnFailure): string | null {
    if (!failure.log.trim() || !MISSING_BINARY.test(failure.log)) return null;

    if (failure.binEntries === null) {
        return (
            'This site runs on the HOST, so it needs its dependencies installed on this machine — ' +
            'there is no `node_modules` here. Run `npm install` in the site’s repo and start it again.'
        );
    }

    const windows = failure.platform === 'win32';
    const hasWindowsShims = failure.binEntries.some((e) => WINDOWS_SHIM.test(e));
    const hasPosixShims = failure.binEntries.some((e) => !WINDOWS_SHIM.test(e));

    // The shim layout has to actually explain the failure. A Windows box with
    // `.cmd` files present, or a POSIX box with extensionless ones, means the
    // binary was missing for some OTHER reason and this has nothing useful to add.
    const mismatched = windows ? !hasWindowsShims && hasPosixShims : hasWindowsShims && !hasPosixShims;
    if (!mismatched) return null;

    const theirs = windows ? 'POSIX' : 'Windows';
    const ours = windows ? 'Windows' : 'POSIX';
    return (
        `Its \`node_modules\` was installed for ANOTHER PLATFORM: \`node_modules/.bin\` holds ${theirs} ` +
        `launchers and no ${ours} ones, so this machine cannot run them — which is why the binary reads as ` +
        'missing rather than broken. This is the usual result of a repo whose dependencies were only ever ' +
        'installed inside a container. Run `npm install` in the site’s repo ON THIS MACHINE and start it again.'
    );
}

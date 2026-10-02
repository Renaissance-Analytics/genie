/**
 * Give a restarted pty host the environment the MACHINE has now, not the one
 * Genie inherited when it started.
 *
 * The owner: *"we have to reboot the machine to make stuff like that apply."*
 * They are right, and the reason is structural rather than a bug anyone wrote:
 *
 *   - the detached host is spawned with `...process.env` — GENIE's environment,
 *     captured at Genie's startup — and every terminal inherits it;
 *   - an installer that extends `PATH` writes the REGISTRY (Windows) or a shell
 *     profile (posix). It cannot reach into a process that is already running;
 *   - so restarting the host changes nothing: it is respawned from the same
 *     stale `process.env`;
 *   - and restarting Genie changes nothing either, when Genie itself started
 *     before the install — it inherited the old PATH from its own parent.
 *
 * A reboot is the only thing that reliably replaces the whole chain. This module
 * replaces the one link that matters instead.
 *
 * Pure on purpose. Reading the registry is I/O and belongs to the caller; the
 * part worth testing is what the new environment should BE, because every
 * mistake available here is severe: strip PATH and no terminal can spawn
 * anything, duplicate it and it grows without bound, take the OS copy verbatim
 * and you silently delete the toolchain Genie injected at runtime.
 */

/** Case-insensitive on Windows, where `C:\Program Files\Git` and
 *  `C:\PROGRAM FILES\GIT` are one directory. The separator tells us which OS we
 *  are on without a second argument: only Windows uses `;`. */
function dedupeKey(entry: string, sep: string): string {
    return sep === ';' ? entry.toLowerCase() : entry;
}

/**
 * Merge the PATH Genie is holding with the one the OS reports now.
 *
 * FRESH ENTRIES WIN THE ORDER. The OS is the authority on what is installed, so
 * an inherited entry that outranked it would keep an old version of a tool
 * winning after an in-place upgrade.
 *
 * INHERITED-ONLY ENTRIES ARE KEPT. Genie injects per-workspace and toolchain
 * directories into its own PATH at runtime; those appear in no registry key, so
 * taking the OS copy verbatim would strip the toolchain Genie had just installed
 * — trading an invisible-tool bug for a worse one.
 */
export function mergePathEntries(
    inherited: readonly string[],
    fresh: readonly string[],
    sep: string,
): string {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of [...fresh, ...inherited]) {
        const trimmed = entry.trim();
        // An empty segment (a trailing `;` is common on Windows) resolves as the
        // CURRENT DIRECTORY for some spawners — never propagate one.
        if (!trimmed) continue;
        const key = dedupeKey(trimmed, sep);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out.join(sep);
}

export interface RefreshedHostEnvInput {
    /** The environment the host would otherwise be spawned with. */
    inherited: Record<string, string | undefined>;
    /** PATH as the OS reports it NOW, or null when it could not be read. */
    osPath: string | null;
    /** The key PATH actually lives under in `inherited` — `PATH` or `Path`. */
    pathKey: string;
    /** `;` on Windows, `:` elsewhere. */
    sep: string;
}

/**
 * The environment to spawn the refreshed host with.
 *
 * Returns the inherited environment UNCHANGED when the OS path cannot be read or
 * is empty. "Cannot tell" must never mean "wipe PATH": a failed registry read
 * that emptied the host's PATH would leave a machine where no terminal can spawn
 * anything at all, which is far worse than a tool being invisible for a while.
 */
export function refreshedHostEnv(
    input: RefreshedHostEnvInput,
): Record<string, string | undefined> {
    if (!input.osPath || !input.osPath.trim()) return input.inherited;

    const current = input.inherited[input.pathKey] ?? '';
    const merged = mergePathEntries(
        current.split(input.sep),
        input.osPath.split(input.sep),
        input.sep,
    );
    // Written back under the key the environment ALREADY uses. Windows env vars
    // are case-insensitive but a plain JS object is not — adding `PATH` beside an
    // existing `Path` yields two keys, and which one a spawned process honours is
    // luck.
    return { ...input.inherited, [input.pathKey]: merged };
}

/** Find PATH's actual key in an environment, whatever its casing. Returns the
 *  platform default when there is none to match. */
export function pathKeyOf(
    env: Record<string, string | undefined>,
    platform: string,
): string {
    const found = Object.keys(env).find((k) => k.toLowerCase() === 'path');
    return found ?? (platform === 'win32' ? 'Path' : 'PATH');
}

/**
 * The argv that asks the OS what PATH is NOW.
 *
 * Windows keeps the authoritative value in two registry hives — Machine then
 * User — and composes them at logon. That composition is what a new process
 * gets and what a running one has already missed, so both are read and joined in
 * that order (machine first, matching Windows' own).
 *
 * On posix there is no registry: PATH comes from the login shell's own startup
 * files, so the shell is asked to report its own. `-l` is what makes it read
 * them; without it this returns the PATH we already have and the whole exercise
 * is a no-op that looks like it worked.
 *
 * Returned as argv rather than run here so the caller owns the process spawn and
 * this module stays pure and testable.
 */
export function osPathArgv(platform: string, shell: string | undefined): {
    command: string;
    args: string[];
} {
    if (platform === 'win32') {
        return {
            command: 'powershell.exe',
            args: [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                // Machine first, then User — the order Windows itself composes
                // them in, so a user entry cannot shadow a machine one differently
                // here than it would in a fresh console.
                "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + " +
                    "[Environment]::GetEnvironmentVariable('Path','User')",
            ],
        };
    }
    return {
        command: shell || '/bin/sh',
        // `-l` is load-bearing: without a LOGIN shell the profile that defines
        // the new tool's PATH is never sourced, and this reports back exactly the
        // PATH we started with.
        args: ['-l', '-c', 'printf %s "$PATH"'],
    };
}

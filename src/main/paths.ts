import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * WHERE THINGS LIVE — and why the answer is two directories, not one.
 *
 * > **The install directory must not be the runtime directory.**
 *
 * This is §7.1, and it is first on that list because of a real upgrade that **jammed on 31
 * orphaned `OpenConsole.exe` processes with no error message at all.** The installer could
 * not replace files that running processes held open, the processes were children of a
 * previous Genie that had exited, and nothing in the product knew they existed. The user saw
 * an update that simply never finished.
 *
 * The rule follows directly: **anything Genie spawns that could outlive it runs from a
 * separate location** — console hosts, websocket servers, helper daemons, the pty host. Then
 * a locked file in the runtime directory cannot block an install, because the installer never
 * touches that directory.
 *
 * ## Why this is a module with a test and not three lines inline
 *
 * Because the mistake is not writing the wrong path — it is writing `process.execPath`'s
 * directory *by accident*, in one helper, eighteen months later, and nothing noticing. A
 * named function with a test that asserts the two directories do not overlap is a thing that
 * keeps failing until someone fixes it.
 *
 * Both functions take their inputs as arguments rather than reading `app` directly, so they
 * can be tested without Electron. The caller passes `app.getPath('userData')` and
 * `process.execPath`.
 */

/**
 * Where Genie keeps its data: `~/.genie`, on every version.
 *
 * Owner, 2026-10-10: "genie's data is supposed to be in ~/.genie no matter what version we are
 * on." Electron's `userData` is per app NAME — `%APPDATA%\\genie2` here, `%APPDATA%\\genie` for
 * the previous build — so keyed on it, every major starts empty and no version can find what
 * another wrote. The runtime (§7.1) and the sessions live under this; Chromium's own caches
 * stay in `userData`, which is Electron's business rather than Genie's.
 */
export function genieHome(home: string = homedir()): string {
    return join(home, '.genie');
}

/**
 * THE ONE DATA ROOT (the host split, P7): `GENIE_HOME` when it is set, `~/.genie` when it is not. The host, the browser
 * process and the updater helper read it here and only here (a source guard, test/p7-one-data-root.test.ts); every path
 * of theirs derives from it. The window does not read GENIE_HOME: its root is `genieHome()`, and it passes that to the
 * host as GENIE_HOME (engine-launch.ts).
 */
export function genieRoot(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): string {
    const set = env['GENIE_HOME'];
    return set !== undefined && set.length > 0 ? set : genieHome(home);
}

/**
 * The Genie OSA's home: `<root>/osa`. The OSA belongs to the whole workstation, not a workspace; Genie writes its
 * baked-in instructions and skills here (core/osa-home.ts) and runs it here. Always given the root (P7): a default here
 * was `homedir()/.genie` whatever GENIE_HOME said.
 */
export function osaHomeDir(root: string): string {
    return join(root, 'osa');
}

/**
 * Genie's scratch: `<root>/cache/tmp`, never the OS temp folder. One folder per process under it (main/scratch-area.ts),
 * the folders of processes that are gone swept after start. A login's throwaway folder and an Import from Git's clone wait
 * here.
 */
export function scratchDir(root: string): string {
    return join(root, 'cache', 'tmp');
}

/** The directory the installer owns. Read-only at runtime, as far as Genie is concerned. */
export function installDir(execPath: string): string {
    return join(execPath, '..');
}

/**
 * The directory Genie writes to and spawns from. Under `userData`, never under the install.
 *
 * `userData` survives an upgrade, which is correct: a pty host's socket, a service's pidfile
 * and a session's thread are not install artifacts and should not be replaced by one.
 */
export function runtimeDir(userData: string): string {
    return join(userData, 'runtime');
}

/** Where provider sessions and their threads persist. One per workspace, under the runtime. */
export function sessionsDir(userData: string): string {
    return join(runtimeDir(userData), 'sessions');
}

/**
 * Whether a path lies inside a directory — the check that keeps the rule honest.
 *
 * The separator is appended before comparing so that `…/Genie2` does not read as being inside
 * `…/Genie`. That sibling-prefix bug is the classic way a containment check passes while
 * being wrong, and here it would report a new install's runtime as sitting inside the old one.
 *
 * ## `caseInsensitive` is a PARAMETER, and that is the fix for a real CI failure
 *
 * It used to read `process.platform === 'win32'` inline — correct in production and
 * untestable in principle. The same Windows fixture that passed on the owner's machine failed
 * on CI's ubuntu runner, because the behaviour was ambient rather than stated. Both modes are
 * now asserted on every platform, which is the only way the Windows branch is ever exercised
 * by the Linux runner that gates merges.
 *
 * The default still follows the host, because `C:\Program Files\Genie` and
 * `c:/program files/genie` are one directory there, and a case-sensitive comparison would
 * cheerfully report a runtime path as safely outside the install it is sitting in. On POSIX
 * they are two directories and must stay two.
 */
export function isInside(
    child: string,
    parent: string,
    caseInsensitive: boolean = process.platform === 'win32',
): boolean {
    const norm = (p: string): string => {
        const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
        return caseInsensitive ? slashed.toLowerCase() : slashed;
    };

    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(`${p}/`);
}

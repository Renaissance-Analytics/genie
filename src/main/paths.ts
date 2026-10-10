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
 * Case-insensitive on Windows, where `C:\Program Files\Genie` and `c:\program files\genie`
 * are the same directory and a case-sensitive comparison would cheerfully report that a
 * runtime path is safely outside the install.
 *
 * The separator is appended before comparing so that `…/Genie2` does not read as being inside
 * `…/Genie`. That sibling-prefix bug is the classic way a containment check passes while
 * being wrong.
 */
export function isInside(child: string, parent: string): boolean {
    const norm = (p: string): string => {
        const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
        return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
    };

    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(`${p}/`);
}

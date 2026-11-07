/**
 * The switches a window copies into the launch it publishes (genie-host starts the updater helper and a relaunched window
 * from it): only the window's OWN — those an Electron needs to start here at all (the sandbox, the display, the password
 * store), and a debugger port or inspector the window itself was started with, so a relaunch is the launch it replaces
 * (Tynn #386's real-app hang row reads the relaunched window through them). Nothing is ever added or invented: a switch
 * the window was not started with is not in its argv. Anyone able to start Genie with a debug port already had it.
 * The updater helper drops the debugger ones (updates-host.ts `helperLaunch`): it runs beside the window.
 */
const KEPT = /^--(no-sandbox$|ozone-platform=|password-store=|remote-debugging-port=\d+$|inspect=[\w.:[\]-]+$)/;

export function windowLaunchFlags(argv: readonly string[]): string[] {
    return argv.filter((a) => KEPT.test(a));
}

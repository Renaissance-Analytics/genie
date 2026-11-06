/**
 * The switches a window copies into the launch it publishes (genie-host starts the updater helper and a relaunched window
 * from it): only the window's own, those an Electron needs to start here at all (the sandbox, the display, the password
 * store).
 */
const KEPT = /^--(no-sandbox$|ozone-platform=|password-store=)/;

export function windowLaunchFlags(argv: readonly string[]): string[] {
    return argv.filter((a) => KEPT.test(a));
}

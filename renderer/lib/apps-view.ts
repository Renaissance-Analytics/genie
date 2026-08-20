/**
 * PURE. What the Apps panel says about an installed Genie App (Tynn #250).
 *
 * These sentences ARE the security UX. A user who cannot tell at a glance what an
 * app was allowed to do has not really consented to anything, and a count alone
 * cannot carry that: "3 of 4 granted" reads identically whether the third is
 * "Open files for you" or "Run any command on this machine, as you".
 *
 * Pure both because the renderer has no DOM harness and because the panel should
 * render these strings rather than compose its own — one place decides what an
 * app's state is called.
 */

import type { InstalledAppView, AppRequirementView } from './genie';

/** The collapsed row's one line. */
export function appSummaryLine(app: InstalledAppView): string {
    const where = app.homeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const base = `v${app.version} · ${where}`;
    // A revoked app looks identical to a working one everywhere else. If the row
    // does not say so, the user's next stop is a bug report.
    return app.revoked ? `Turned off · ${base}` : base;
}

/** What the app may do, in the fewest words that are still true. */
export function permissionSummary(app: InstalledAppView): string {
    const asked = app.permissions.length;
    if (asked === 0) return 'This app asked for no permissions.';

    const granted = app.permissions.filter((p) => p.granted);
    if (granted.length === 0) return 'Nothing granted — it cannot call Genie.';

    const high = granted.filter((p) => p.risk === 'high').map((p) => p.label);
    const count = `${granted.length} of ${asked} permissions granted`;
    // Name the dangerous ones. A count hides exactly the thing worth seeing.
    return high.length > 0 ? `${count} — including ${high.join(', ')}` : count;
}

/** How far the app can reach, in words that match how wide it actually is. */
export function reachLabel(scope: InstalledAppView['scope'], workspaces: string[]): string {
    if (scope === 'workstation') return 'Every workspace on this machine';
    if (scope === 'workspaces') {
        return `Its own workspace and ${workspaces.length} other${workspaces.length === 1 ? '' : 's'}`;
    }
    return 'Only its own workspace';
}

/**
 * The uninstall confirmation.
 *
 * It has to say what STAYS. Uninstall removes the grant, not the files, and a
 * confirmation that implied otherwise would be asking the user to agree to
 * something untrue — then leaving a folder they thought was gone.
 */
export function uninstallConfirmation(app: InstalledAppView): string {
    return (
        `Uninstall “${app.name}”?\n\n` +
        'It loses every permission immediately and stops being a Genie App. ' +
        'Its window closes.\n\n' +
        `Its files stay where they are — ${app.installPath} — as an ordinary workspace ` +
        'you can keep or delete like any other.'
    );
}

/**
 * One runtime the app needs, as a line the user can act on.
 *
 * The app's own reason travels with it: "install rust" is an instruction, while
 * "rust — compiles the engine" is a decision someone can actually make.
 */
export function requirementLine(requirement: AppRequirementView): string {
    const what = requirement.version
        ? `${requirement.tool} ${requirement.version}`
        : requirement.tool;
    return requirement.reason ? `${what} — ${requirement.reason}` : what;
}

/**
 * The banner for runtimes Genie cannot provide on this machine.
 *
 * Null when there are none, so the panel renders nothing rather than an empty
 * warning. When there ARE some it has to be prominent: a backend that never comes
 * up looks like a broken app — or a broken Genie — until something says the
 * machine is missing a tool.
 */
export function missingRuntimesNote(missing: AppRequirementView[]): string | null {
    if (missing.length === 0) return null;
    const count = `${missing.length} ${missing.length === 1 ? 'runtime' : 'runtimes'}`;
    return (
        `This app needs ${count} Genie cannot install on this machine. ` +
        'Anything that depends on them will not start until you install them yourself.'
    );
}

/**
 * PURE. The App Tray — the pills left of the Genie header icons (Tynn #250).
 *
 * It grows LEFTWARD from the icons, so this order runs from the icons outward.
 * Ordering is by NAME rather than install time on purpose: the tray shifts every
 * time something is added, and ordering by recency would shove whichever pill the
 * user reaches for by muscle memory somewhere new.
 *
 * A tray pill is deliberately quieter than a workspace sidebar row — no IssueWatch
 * pill, none of the other furniture. It is a launcher, and the things a row carries
 * are things a workspace has and an app does not.
 */

import type { InstalledAppView } from './genie';

export interface AppTrayPill {
    id: string;
    name: string;
    /** The first letter, for the icon Genie draws when the app supplies none. */
    initial: string;
    /** Turned off: it stays in the tray, but it can do nothing. */
    disabled: boolean;
    /** Running from the developer's own folder, with dev tools. */
    dev: boolean;
    title: string;
}

export function appTrayPills(apps: InstalledAppView[]): AppTrayPill[] {
    return [...apps]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((app) => ({
            id: app.id,
            name: app.name,
            initial: (app.name.trim()[0] ?? '?').toUpperCase(),
            // Kept in the tray rather than hidden: hiding it would make "where did
            // my app go?" the next question. It is still installed — it just
            // cannot do anything until it is turned back on.
            disabled: app.revoked,
            dev: app.devMode,
            title: trayPillTitle(app),
        }));
}

/**
 * The hover text.
 *
 * A turned-off pill does nothing when clicked, so the tooltip is the only place
 * that can explain why BEFORE the click rather than after it.
 */
export function trayPillTitle(app: InstalledAppView): string {
    if (app.revoked) {
        return `${app.name} is turned off — its permissions were revoked, so it cannot run. Turn it back on in its permissions.`;
    }
    const dev = app.devMode ? ' · in development, running from your own folder' : '';
    return `${app.name}${dev}`;
}

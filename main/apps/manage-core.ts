/**
 * PURE. Changing what an installed app may do (Tynn #250).
 *
 * The permissions screen is the second place a grant can change, and it is the one
 * that is NOT behind an OS modal — it is ordinary UI in Genie's own renderer. So
 * it has to enforce in code what the consent modal enforces structurally: a grant
 * is only ever a SUBSET of what the manifest declared.
 *
 * That is not defence against the user; it is their machine and their choice. It
 * is defence against everything in between — a bug in the screen, a stale list
 * after an update that asked for less, a renderer made to send something it
 * should not. An app that never asked for `secrets` cannot be given `secrets` by
 * anything short of a reinstall, where the user is asked properly.
 */

import { APP_CAPABILITIES, type AppCapability } from './capabilities';

/**
 * The capabilities to show on an app's permissions screen: what it DECLARED,
 * riskiest first.
 *
 * Risk order because a list that buries "Run commands" under "Open files for you"
 * is a list that got skimmed. Unknown names are dropped — an app installed under an
 * older Genie can name a capability this build no longer has, and an unrecognised
 * toggle would be a switch wired to nothing.
 */
export function grantableCapabilities(declared: readonly string[]): AppCapability[] {
    return APP_CAPABILITIES.filter((c) => declared.includes(c.key)).sort((a, b) => {
        if (a.risk !== b.risk) return a.risk === 'high' ? -1 : 1;
        return APP_CAPABILITIES.indexOf(a) - APP_CAPABILITIES.indexOf(b);
    });
}

/**
 * The grant a change may actually produce: the requested set, intersected with
 * what the manifest declared, in the catalogue's own order.
 *
 * Catalogue order rather than the caller's, so a stored grant is comparable
 * between reads and a reordered payload is not a different grant.
 */
export function narrowGrant(
    declared: readonly string[],
    requested: readonly string[],
): string[] {
    const asked = new Set(requested.filter((c): c is string => typeof c === 'string' && c !== ''));
    return APP_CAPABILITIES.filter((c) => declared.includes(c.key) && asked.has(c.key)).map(
        (c) => c.key,
    );
}

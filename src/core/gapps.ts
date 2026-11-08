/**
 * GAPPS, AS THE GAPP STORE SHOWS THEM (GApps D5, Tynn #468; spec .ai/plans/specs/adf-sdk.md) — pure. The flyout opened by
 * the title-bar GApps icon lists what the person has: each installed app, and a launcher for each workspace that builds
 * one. This is Genie 2's own view of them, not an app's manifest: the install book (D2) fills it.
 */
export interface GAppListing {
    /** Unique in the list: an installed app's id, or the launcher's workspace. */
    readonly id: string;
    readonly name: string;
    /** `null` for a launcher of an app still being built (no released version). */
    readonly version: string | null;
    readonly state: 'installed' | 'off';
    /** A launcher of a workspace that builds the app, as Genie knows it: always ribboned. */
    readonly dev: boolean;
    /** A dev launcher's workspace, by name. */
    readonly workspace?: string;
}

/**
 * A dev launcher's ribbon, from `dev` alone: whatever an app declares, nothing it ships can remove it, so a person can
 * always tell an app being built from an installed one. `null` for an installed app.
 */
export function gappRibbon(listing: GAppListing): 'Dev' | null {
    return listing.dev === true ? 'Dev' : null;
}

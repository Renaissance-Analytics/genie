/**
 * GAPPS, AS THE GAPP STORE SHOWS THEM (GApps D5, Tynn #468; spec .ai/plans/specs/adf-sdk.md) — pure. The flyout opened by
 * the title-bar GApps icon lists what the person has: each installed app, and a launcher for each workspace that builds
 * one. This is Genie 2's own view of them, not an app's manifest: the install book (D2) fills it.
 */
import type { GrantScope, ReviewItem } from './gapp-grants.js';

/** What a window can ask of the GApp book (V7), its own window's, never another machine's. */
export const GAPP_METHODS = ['gapps.list', 'gapps.review', 'gapps.install', 'gapps.setOn', 'gapps.uninstall'] as const;
export type GAppMethod = (typeof GAPP_METHODS)[number];
export const isGappMethod = (method: unknown): method is GAppMethod => typeof method === 'string' && (GAPP_METHODS as readonly string[]).includes(method);

/** What the person reads before an app is installed or updated. */
export interface GAppReview {
    readonly packageId: string;
    readonly name: string;
    readonly version: string;
    readonly digest: string;
    /** The signing key's id, or `unverified`. */
    readonly publisher: string;
    /** An update to an installed app (its grant is the baseline). */
    readonly update: boolean;
    /** Whether the person must consent: always for a new app; for an update, only when it asks for something new. */
    readonly consent: boolean;
    /** What the person reads: each element by Genie's catalog name, each host, a new publisher. */
    readonly items: readonly ReviewItem[];
}

export interface GAppsApi {
    list(): Promise<readonly GAppListing[]>;
    /** What installing this folder would ask of the person. Rejects with the host's reason. */
    review(folder: string): Promise<GAppReview>;
    /** Install or update from this folder; `consent` must be the person's to exactly that review. */
    install(folder: string, options: { scope: GrantScope; consent?: { digest: string; items: readonly ReviewItem[] } }): Promise<GAppListing>;
    setOn(id: string, on: boolean): Promise<void>;
    uninstall(id: string): Promise<void>;
}

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

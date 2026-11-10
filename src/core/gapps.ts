/**
 * GAPPS, AS THE GAPP STORE SHOWS THEM (GApps D5, Tynn #468; spec .ai/plans/specs/adf-sdk.md) — pure. The flyout opened by
 * the title-bar GApps icon lists what the person has: each installed app, and a launcher for each workspace that builds
 * one. This is Genie 2's own view of them, not an app's manifest: the install book (D2) fills it.
 */
import type { GrantScope, ReviewItem } from './gapp-grants.js';

/** What a window can ask of the GApp book (V7), its own window's, never another machine's. */
export const GAPP_METHODS = ['gapps.list', 'gapps.review', 'gapps.install', 'gapps.setOn', 'gapps.uninstall', 'gapps.open', 'gapps.preview', 'gapps.allowPreviewNetwork'] as const;
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
    /** Open the app's own window, or bring it to the front. Rejects with why it could not. */
    open(id: string): Promise<void>;
    /** Run a workspace's preview of this app in its own window; its first run asks the person on the Deck (V8). */
    preview(packageId: string): Promise<void>;
    /** Let an Unverified preview reach its hosts, or take that back. */
    allowPreviewNetwork(packageId: string, allowed: boolean): Promise<void>;
    /** The book changed, here or in another window: read the list again. Returns the function that stops listening. */
    onChanged(listener: () => void): () => void;
}

/** What the host's book does; opening and listening are the window's own. */
export type GAppBookApi = Omit<GAppsApi, 'open' | 'onChanged' | 'preview'>;

/** The review, as the Deck says it: everything it asks for, in Genie's words, and where it would act. */
export function gappInstallDetail(review: GAppReview, where: string): string {
    const asks = review.items.map((item) => (item.kind === 'element' ? `${item.name} (${item.description})` : item.kind === 'network' ? `network access to ${item.host}` : `a new publisher, ${item.to}, was ${item.from}`));
    const who = review.publisher === 'unverified' ? 'Unverified: no publisher has signed it' : `signed by ${review.publisher}`;
    return `${review.name} ${review.version}, ${who}, to act in ${where}. It asks for: ${asks.length === 0 ? 'nothing' : asks.join('; ')}`;
}

/** One window of one app, from the host to the process that opens it. The token never reaches a Genie page. */
export interface GAppSessionInfo {
    readonly packageId: string;
    readonly url: string;
    readonly channel: string;
    readonly token: string;
    readonly window: Readonly<Record<string, unknown>>;
}

export interface GAppSessionsApi {
    open(packageId: string, options?: { preview?: boolean }): Promise<GAppSessionInfo>;
    close(token: string): void;
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
    /** A dev launcher's app (its `id` is the launcher's own). */
    readonly packageId?: string;
    /** A dev launcher not signed as it is now: no network until the person allows it. */
    readonly unverified?: boolean;
    readonly networkAllowed?: boolean;
}

/**
 * A dev launcher's ribbon, from `dev` alone: whatever an app declares, nothing it ships can remove it, so a person can
 * always tell an app being built from an installed one. `null` for an installed app.
 */
export function gappRibbon(listing: GAppListing): 'Dev' | null {
    return listing.dev === true ? 'Dev' : null;
}

/**
 * WHAT THE GAPP STORE LISTS — and, load-bearing, what cannot change how an entry
 * is marked.
 *
 * A developer building a GApp is also a user who installs the released one, and
 * both are meant to exist at once. So the store lists BOTH in one list: the apps
 * installed on this machine, and a launcher for every workspace that BUILDS one.
 * A launcher is the developer's preview — the same app, run against working
 * source, not installed — which makes the two rows look almost identical while
 * being different things. The RIBBON is the only thing keeping them apart, so a
 * developer must not be able to take it off.
 *
 * That boundary is STRUCTURAL rather than a convention anybody has to remember,
 * the same way workspace chrome's is (see `./workspace-kind`):
 *
 *  1. An entry's kind comes from WHICH first-party list it came out of — Genie's
 *     app registry, or {@link gappLaunchTarget} reading two Genie-owned database
 *     columns. Nothing in a manifest is consulted, so there is no field a
 *     developer could travel in.
 *  2. {@link gappStoreRibbon} is a lookup into a frozen table, never a
 *     concatenation and never a passthrough. Its range is one class name and
 *     `null`, so no value a developer writes can become a class name.
 *
 * WHICH VOCABULARY THE RIBBON BELONGS TO. Three marks are now in play and they
 * say different things. Amber says "this app BUILD is a dev build" — a fact about
 * an installed app, and it keeps its own meaning in the Installed rows. Pink
 * (`--gapp-dev`) says "an app is BUILT here" — a fact about a workspace. A
 * launcher entry exists only because a GDW exists; it is derived from the
 * workspace row, and what it says — "this launches your working source, not an
 * install" — is downstream of "an app is built here". So it is PINK. Amber would
 * have been actively wrong: an installed app in dev mode already wears amber in
 * this very list, and two different things in one colour is the confusion the
 * ribbon exists to prevent.
 *
 * Kept out of the component because the renderer's test environment has no DOM,
 * and a decision inside a component is a decision nobody checks.
 */

import { gappLaunchTarget, type GappLaunchRow, type GappLaunchTarget } from './gapp-launch';
import type { InstalledAppView } from './genie';

/** What a store entry IS — which of the two first-party lists produced it. */
export type GappStoreEntryKind = 'installed' | 'dev-launcher';

/** The mark an entry wears: a first-party class name and what it says out loud. */
export interface GappStoreRibbon {
    className: string;
    label: string;
}

/**
 * The ONLY ribbon a store entry can wear, keyed by kind.
 *
 * Frozen — the table AND the ribbon inside it — so a future in-process surface
 * cannot unribbon itself by writing here, which is the same reason the lookup
 * exists at all.
 */
export const GAPP_STORE_RIBBON: Readonly<Record<GappStoreEntryKind, GappStoreRibbon | null>> =
    Object.freeze({
        // An install needs no ribbon: it is what the list is FOR, and marking the
        // ordinary case teaches nobody anything.
        installed: null,
        'dev-launcher': Object.freeze({ className: 'store-gapp-dev', label: 'dev launcher' }),
    });

/** The ribbon for a kind — `null` when there is nothing to mark. */
export function gappStoreRibbon(kind: GappStoreEntryKind): GappStoreRibbon | null {
    return GAPP_STORE_RIBBON[kind] ?? null;
}

/** One row of the store's list. */
export type GappStoreEntry =
    | {
          kind: 'installed';
          /** Unique across BOTH kinds — see the note on {@link gappStoreEntries}. */
          key: string;
          name: string;
          ribbon: GappStoreRibbon | null;
          app: InstalledAppView;
      }
    | {
          kind: 'dev-launcher';
          key: string;
          name: string;
          ribbon: GappStoreRibbon | null;
          /** The workspace and the folder its preview opens over. */
          target: GappLaunchTarget;
      };

/**
 * Sorting reads the NAME, and an app names itself. Coerced rather than trusted:
 * `localeCompare` is a string method, so a non-string that reached the registry
 * would throw here and take the whole list down with it. The list must survive
 * anything a developer writes — that is the entire premise of this module.
 */
function sortName(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
}

/** Installs sort above their launchers when the names tie. */
const KIND_RANK: Readonly<Record<GappStoreEntryKind, number>> = Object.freeze({
    installed: 0,
    'dev-launcher': 1,
});

/**
 * The store's one list: everything installed, plus a launcher per workspace that
 * builds an app.
 *
 * TWO ENTRIES, NOT ONE ROW WITH TWO BUTTONS. They are different objects with
 * different lifecycles — an install has permissions, updates, a revoke switch and
 * an uninstall; a launcher has a folder and a launch — and Genie cannot reliably
 * pair them anyway: the install carries a manifest slug, the workspace carries a
 * name and a path, and the same source can be installed under either. Merging
 * them would also say "these are one app in two modes", which is exactly the
 * thing the user is not supposed to have to guess about.
 *
 * ORDERED BY NAME, installs first on a tie, so an install and its launcher land
 * next to each other and a new install never shoves the row somebody aims at —
 * the same rule, for the same reason, as the App Tray's.
 *
 * KEYS ARE NAMESPACED. An app id and a workspace id are minted by different
 * things and nothing stops them being equal; two entries sharing a React key
 * would silently drop one, which is the one failure a user could not diagnose.
 */
export function gappStoreEntries(
    apps: readonly InstalledAppView[],
    rows: readonly GappLaunchRow[],
): GappStoreEntry[] {
    const entries: GappStoreEntry[] = [];

    for (const app of apps) {
        entries.push({
            kind: 'installed',
            key: `installed:${app.id}`,
            name: sortName(app.name),
            ribbon: gappStoreRibbon('installed'),
            app,
        });
    }

    for (const row of rows) {
        // Delegated, never re-derived: the store must not be able to offer a
        // launch the workspace row and the Command Window refuse, which is the
        // failure mode of three affordances that each decide for themselves.
        const target = gappLaunchTarget(row);
        if (!target) continue;
        entries.push({
            kind: 'dev-launcher',
            key: `dev:${target.id}`,
            name: sortName(target.name),
            ribbon: gappStoreRibbon('dev-launcher'),
            target,
        });
    }

    return entries.sort(
        (a, b) =>
            a.name.localeCompare(b.name) ||
            KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
            a.key.localeCompare(b.key),
    );
}

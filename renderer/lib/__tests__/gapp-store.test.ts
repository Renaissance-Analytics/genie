import { describe, expect, it } from 'vitest';
import {
    GAPP_STORE_RIBBON,
    gappStoreEntries,
    gappStoreRibbon,
    type GappStoreEntryKind,
} from '../gapp-store';
import type { GappLaunchRow } from '../gapp-launch';
import type { InstalledAppView } from '../genie';

/**
 * WHAT THE GAPP STORE LISTS — installed apps AND the launchers for the apps
 * being built here, in ONE list.
 *
 * A developer building a GApp is also a user who installs the released one, and
 * both are meant to exist at once. That makes the list's job harder than showing
 * things: it has to show two almost-identical rows and leave nobody wondering
 * which one they just opened. So the ribbon is not decoration — it is the only
 * thing separating "the copy you installed" from "your working source".
 *
 * Which means a developer must not be able to take it off. The guarantee is the
 * same structural one workspace chrome has (renderer/lib/workspace-kind.test.ts):
 * the kind is decided by WHICH first-party list a row came out of, and the ribbon
 * is a lookup into a frozen table — never a concatenation, never a passthrough.
 * Nothing a manifest can carry reaches either.
 */

const app = (over: Partial<InstalledAppView> = {}): InstalledAppView => ({
    id: 'com.example.weather',
    name: 'Weather',
    slug: 'weather',
    version: '1.0.0',
    workspaceId: 'ws-app',
    installPath: 'C:/apps/weather.agi',
    scope: 'self',
    workspaces: [],
    revoked: false,
    devMode: false,
    source: { kind: 'folder', origin: 'C:/src/weather' },
    homeUrl: 'https://weather.gen/',
    installedAt: '2026-01-01T00:00:00.000Z',
    permissions: [],
    ...over,
});

const GDW: GappLaunchRow = {
    id: 'ws-1',
    project_name: 'Weather',
    path: 'C:/work/weather',
    gapp_dev: 1,
};

describe('what the store lists', () => {
    it('lists nothing when there is neither an install nor a workspace building one', () => {
        expect(gappStoreEntries([], [])).toEqual([]);
    });

    it('lists an installed app', () => {
        const entries = gappStoreEntries([app()], []);
        expect(entries.map((e) => e.kind)).toEqual(['installed']);
        expect(entries[0]!.name).toBe('Weather');
    });

    it('lists a launcher for a workspace that BUILDS an app, with nothing installed', () => {
        // The point of "as if installed": a developer who has not released yet
        // still finds their app in the same place a user finds theirs.
        const entries = gappStoreEntries([], [GDW]);
        expect(entries.map((e) => e.kind)).toEqual(['dev-launcher']);
        expect(entries[0]!.name).toBe('Weather');
    });

    it('carries the folder on a launcher, so the launch never re-resolves it', () => {
        const entry = gappStoreEntries([], [GDW])[0]!;
        expect(entry.kind).toBe('dev-launcher');
        if (entry.kind !== 'dev-launcher') throw new Error('unreachable');
        expect(entry.target.path).toBe('C:/work/weather');
        expect(entry.target.id).toBe('ws-1');
    });

    it('lists no launcher for an ordinary workspace — POSITIVE CONTROL', () => {
        expect(gappStoreEntries([], [{ ...GDW, gapp_dev: 0 }])).toEqual([]);
        // The control: the same call DOES produce a launcher for the GDW above, so
        // the empty result is a filter and not a reader that lists nothing at all.
        expect(gappStoreEntries([], [GDW])).toHaveLength(1);
    });

    it('lists no launcher for a workspace that merely HOSTS an installed app', () => {
        // Delegated to `gappLaunchTarget` rather than re-derived, so the store can
        // never offer a launch the workspace row and the palette refuse. Launching
        // there would open a second copy of somebody else's app.
        expect(gappStoreEntries([], [{ ...GDW, app_kind: 'app' }])).toEqual([]);
        expect(gappStoreEntries([], [{ ...GDW, app_kind: 'app-preview' }])).toEqual([]);
    });
});

describe('when the SAME app is both installed and being built', () => {
    // The case the whole feature exists for: a developer ships v1, installs it
    // like everyone else, and keeps working on v2.
    const both = () => gappStoreEntries([app()], [GDW]);

    it('shows BOTH, as two entries — neither replaces the other', () => {
        expect(both().map((e) => e.kind)).toEqual(['installed', 'dev-launcher']);
    });

    it('ribbons the launcher and NOT the install — with a positive control', () => {
        const [installed, launcher] = both();

        // POSITIVE CONTROL first: the ribbon IS produced by this call, so the
        // `null` below is a decision and not a list that ribbons nothing.
        expect(launcher!.ribbon).not.toBeNull();
        expect(launcher!.ribbon?.className).toBe('store-gapp-dev');
        expect(launcher!.ribbon?.label).toBe('dev launcher');

        expect(installed!.ribbon).toBeNull();
    });

    it('keeps them apart by key, even when an app id and a workspace id collide', () => {
        // Nothing stops a workspace id from equalling an app id — they are minted
        // by different things. Two entries sharing a React key would drop one of
        // them, which is the one failure the user could not diagnose.
        const entries = gappStoreEntries([app({ id: 'same' })], [{ ...GDW, id: 'same' }]);
        expect(entries).toHaveLength(2);
        expect(new Set(entries.map((e) => e.key)).size).toBe(2);
    });
});

describe('the order the list comes out in', () => {
    it('orders by NAME, so a new install never shoves the row you aim at', () => {
        // The same rule the App Tray sorts by, and for the same reason: ordering
        // by install time moves everything each time anything arrives.
        const entries = gappStoreEntries(
            [app({ id: 'z', name: 'Zeta' }), app({ id: 'a', name: 'Alpha' })],
            [{ ...GDW, project_name: 'Mid' }],
        );
        expect(entries.map((e) => e.name)).toEqual(['Alpha', 'Mid', 'Zeta']);
    });

    it('puts the INSTALL above its launcher when the names match', () => {
        // Adjacent, so the pair reads as one app in two states — and the released
        // copy first, because that is the one a user means by "the app". Asserted
        // from BOTH input orders: a tie broken by argument order rather than by
        // rule would pass one way round and flip the other.
        expect(gappStoreEntries([app()], [GDW]).map((e) => e.kind)).toEqual([
            'installed',
            'dev-launcher',
        ]);
        expect(gappStoreEntries([app({ id: 'other' })], [GDW]).map((e) => e.kind)).toEqual([
            'installed',
            'dev-launcher',
        ]);
    });
});

describe('the manifest boundary', () => {
    it('nothing a manifest can carry adds, removes or restyles a ribbon — with a positive control', () => {
        // POSITIVE CONTROL, first and deliberately: the ribbon IS alive and DOES
        // land on a launcher. Without it every "no ribbon" assertion below would
        // pass just as happily against a build that never ribbons anything.
        expect(gappStoreEntries([], [GDW])[0]!.ribbon?.className).toBe('store-gapp-dev');
        expect(gappStoreEntries([app()], [])[0]!.ribbon).toBeNull();

        // Everything below is a field a DEVELOPER writes: the manifest's name,
        // slug and version, the dev-mode flag Genie derives from the install
        // route, and the origin it was installed from. These are the whole surface
        // a manifest has to cross to reach this list.
        const hostile: unknown[] = [
            'store-gapp-dev',
            'ws-gapp-dev',
            'dev launcher',
            '#ec4899',
            'background: red',
            '<span class="store-gapp-dev">',
            true,
            {},
            ['store-gapp-dev'],
        ];

        for (const value of hostile) {
            const installed = gappStoreEntries(
                [
                    app({
                        name: value as string,
                        slug: value as string,
                        version: value as string,
                        devMode: value as unknown as boolean,
                        source: { kind: 'folder', origin: value as string },
                    }),
                ],
                [],
            );
            // An install never wears the launcher's ribbon, whatever it says about
            // itself — including saying the class name verbatim.
            expect(installed).toHaveLength(1);
            expect(installed[0]!.ribbon).toBeNull();
            expect(installed[0]!.kind).toBe('installed');

            // …and the same values fed through the two Genie-owned columns that
            // decide a launcher never mint one either.
            expect(gappStoreEntries([], [{ ...GDW, app_kind: value, gapp_dev: value }])).toEqual([]);
        }

        // …and the control STILL holds after the hostile pass, so nothing above
        // mutated the frozen table on its way through.
        expect(gappStoreEntries([], [GDW])[0]!.ribbon?.className).toBe('store-gapp-dev');
    });

    it('every ribbon comes from ONE frozen, first-party table', () => {
        // The structural guarantee: `gappStoreRibbon` is a lookup, never a
        // concatenation or a passthrough, so its range is finite and auditable.
        expect(Object.isFrozen(GAPP_STORE_RIBBON)).toBe(true);
        expect(GAPP_STORE_RIBBON).toEqual({
            installed: null,
            'dev-launcher': { className: 'store-gapp-dev', label: 'dev launcher' },
        });

        const kinds: GappStoreEntryKind[] = ['installed', 'dev-launcher'];
        const allowed = new Set([null, 'store-gapp-dev']);
        for (const kind of kinds) {
            expect(allowed.has(gappStoreRibbon(kind)?.className ?? null)).toBe(true);
        }
    });

    it('a frozen table cannot be reassigned into — nor the ribbon inside it', () => {
        // Belt and braces. A GApp renders in its own renderer with its own globals,
        // but a future in-process surface must not be able to unribbon itself by
        // writing to this table.
        const before = GAPP_STORE_RIBBON['dev-launcher'];
        try {
            (GAPP_STORE_RIBBON as Record<string, unknown>)['dev-launcher'] = null;
        } catch {
            // strict mode throws; non-strict silently ignores. Either is fine.
        }
        expect(GAPP_STORE_RIBBON['dev-launcher']).toBe(before);

        try {
            (GAPP_STORE_RIBBON['dev-launcher'] as { className: string }).className = 'ws-app';
        } catch {
            // as above
        }
        expect(GAPP_STORE_RIBBON['dev-launcher']?.className).toBe('store-gapp-dev');
    });
});

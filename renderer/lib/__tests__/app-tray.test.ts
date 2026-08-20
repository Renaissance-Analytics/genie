import { describe, expect, it } from 'vitest';
import { appTrayPills, trayPillTitle } from '../app-tray';
import type { InstalledAppView } from '../genie';

/**
 * The App Tray — the pills left of the Genie header icons (Tynn #250).
 *
 * It grows LEFTWARD from the icons, so the order in the array is the order from
 * the icons outward. That matters: the newest app should not silently displace
 * whichever one the user reaches for by muscle memory, so the order is stable and
 * by name rather than by install time.
 *
 * A tray pill is deliberately quieter than a workspace sidebar row — no IssueWatch
 * pill, none of the other row furniture. It is an app launcher, and the things a
 * row carries are things a workspace has and an app does not.
 */

const app = (over: Partial<InstalledAppView> = {}): InstalledAppView => ({
    id: 'com.example.trader',
    name: 'Example Trader',
    slug: 'trader',
    version: '1.0.0',
    workspaceId: 'ws-app',
    installPath: 'C:/apps/trader.agi',
    scope: 'self',
    workspaces: [],
    revoked: false,
    devMode: false,
    source: { kind: 'folder', origin: 'C:/src/trader' },
    homeUrl: 'https://trader.gen/',
    installedAt: '2026-01-01T00:00:00.000Z',
    permissions: [],
    ...over,
});

describe('what the tray shows', () => {
    it('is empty when nothing is installed, so the header stays clean', () => {
        expect(appTrayPills([])).toEqual([]);
    });

    it('gives every installed app a pill', () => {
        const pills = appTrayPills([app(), app({ id: 'b', name: 'Beta', slug: 'beta' })]);
        expect(pills).toHaveLength(2);
    });

    it('orders by NAME, not by when it was installed', () => {
        // The tray grows leftward from the icons. Ordering by install time would
        // shove every pill along each time something new arrived, and the one the
        // user reaches for by muscle memory would move.
        const pills = appTrayPills([
            app({ id: 'c', name: 'Zeta', slug: 'zeta', installedAt: '2020-01-01' }),
            app({ id: 'a', name: 'Alpha', slug: 'alpha', installedAt: '2026-01-01' }),
        ]);
        expect(pills.map((p) => p.name)).toEqual(['Alpha', 'Zeta']);
    });

    it('keeps a turned-off app in the tray, marked', () => {
        // Hiding it would make "where did my app go?" the next question. It is
        // still installed; it just cannot do anything.
        const pills = appTrayPills([app({ revoked: true })]);
        expect(pills[0]?.disabled).toBe(true);
    });

    it('marks one you are building', () => {
        expect(appTrayPills([app({ devMode: true })])[0]?.dev).toBe(true);
    });
});

describe('what a pill says on hover', () => {
    it('names the app and where it serves', () => {
        const title = trayPillTitle(app());
        expect(title).toContain('Example Trader');
        expect(title).toContain('trader.gen');
    });

    it('says a turned-off app is turned off, and how to fix it', () => {
        // Clicking it does nothing; the tooltip is the only place that can explain
        // why before the click rather than after.
        const title = trayPillTitle(app({ revoked: true }));
        expect(title).toMatch(/turned off/i);
        expect(title).toMatch(/permission/i);
    });

    it('says when it is running from your own folder', () => {
        expect(trayPillTitle(app({ devMode: true }))).toMatch(/development/i);
    });
});

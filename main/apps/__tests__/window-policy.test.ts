import { describe, expect, it } from 'vitest';
import {
    appWindowOptions,
    appPartitionFor,
    decideAppNavigation,
    APP_PRELOAD_FILENAME,
} from '../window-policy';

/**
 * The GApp window's isolation, decided in one place (Tynn #250).
 *
 * A GApp's front end is developer-authored web content — the whole point of the
 * SDK — served from its own `<slug>.gen` origin and shown in a dedicated window.
 * It is therefore THIRD-PARTY CODE running inside Genie's process tree, and the
 * only reason that is acceptable is that the window it gets is a locked one.
 *
 * These are pure: Electron's window can't be constructed in a unit test, but the
 * OPTIONS it is constructed from can be asserted exactly. That matters more than
 * it sounds — every one of these flags is a single boolean between "sandboxed web
 * page" and "third-party code with Node".
 */

const app = { id: 'com.example.trader', slug: 'trader' };

describe('the window a GApp gets', () => {
    const opts = appWindowOptions(app, '/genie/app-preload.js');

    it('has no Node, and no way to reach Genie’s own preload', () => {
        expect(opts.webPreferences?.nodeIntegration).toBe(false);
        expect(opts.webPreferences?.contextIsolation).toBe(true);
        expect(opts.webPreferences?.sandbox).toBe(true);
        // A DEDICATED preload. Genie's own exposes the full desktop API; loading
        // it here would hand a third-party page everything at once.
        expect(opts.webPreferences?.preload).toContain(APP_PRELOAD_FILENAME);
        expect(opts.webPreferences?.preload).not.toMatch(/[/\\]preload\.js$/);
    });

    it('keeps web security and the same-origin rules on', () => {
        expect(opts.webPreferences?.webSecurity).toBe(true);
        expect(opts.webPreferences?.allowRunningInsecureContent).toBeFalsy();
        expect(opts.webPreferences?.experimentalFeatures).toBeFalsy();
    });

    it('runs in its OWN storage partition', () => {
        // Two apps must not share cookies, localStorage or service workers, and
        // neither may read Genie's. The partition is the boundary that makes
        // uninstall mean something.
        expect(opts.webPreferences?.partition).toBe(appPartitionFor(app.id));
        expect(appPartitionFor('com.example.trader')).not.toBe(appPartitionFor('com.other.app'));
        expect(appPartitionFor(app.id)).toMatch(/^persist:/);
    });

    it('names the app in its own title, and does not claim to be Genie', () => {
        // The window chrome is Genie-drawn and not themeable — the structural half
        // of anti-impersonation. The title is where the user reads whose window
        // this is.
        expect(opts.title).toContain('trader');
        expect(opts.title?.toLowerCase().startsWith('genie')).toBe(false);
    });
});

describe('where a GApp window may navigate', () => {
    const home = 'https://trader.gen/';

    it('moves freely inside its own site', () => {
        expect(decideAppNavigation(home, 'https://trader.gen/settings').allow).toBe(true);
        expect(decideAppNavigation(home, 'https://trader.gen/a/b?c=d#e').allow).toBe(true);
    });

    it('refuses to navigate to ANOTHER app', () => {
        // Same-origin is what keeps one app out of another's session; a GApp that
        // could load `other.gen` in its own window would be inside that app's
        // partitioned storage.
        expect(decideAppNavigation(home, 'https://other.gen/').allow).toBe(false);
    });

    it('refuses to navigate off to the web in-window', () => {
        const d = decideAppNavigation(home, 'https://example.com/login');
        expect(d.allow).toBe(false);
        // But it is a reasonable thing for an app to want, so it opens where links
        // belong — the user's browser, visibly, outside this window's session.
        expect(d.openExternally).toBe(true);
    });

    it('refuses a scheme that is not the web', () => {
        // `file:` reads the disk; the others execute. None of them is a page.
        for (const url of [
            'file:///C:/Users/glenn/.ssh/id_ed25519',
            'javascript:fetch("/x")',
            'data:text/html,<script>alert(1)</script>',
        ]) {
            const d = decideAppNavigation(home, url);
            expect(d.allow, url).toBe(false);
            // And never handed to the OS, which would just move the problem.
            expect(d.openExternally, url).toBeFalsy();
        }
    });

    it('refuses plain http even to its own name', () => {
        // Genie serves .gen over https and rewrites http to it. Accepting http here
        // would reopen the downgrade the hosting layer exists to close.
        expect(decideAppNavigation(home, 'http://trader.gen/').allow).toBe(false);
    });

    it('refuses a URL it cannot parse, rather than guessing', () => {
        expect(decideAppNavigation(home, 'not a url').allow).toBe(false);
        expect(decideAppNavigation(home, '').allow).toBe(false);
    });

    it('is not fooled by a name that merely ends with the app’s', () => {
        // `nottrader.gen` and `trader.gen.evil.com` both contain the app's host as
        // a substring. Origin comparison, never string containment.
        expect(decideAppNavigation(home, 'https://nottrader.gen/').allow).toBe(false);
        expect(decideAppNavigation(home, 'https://trader.gen.evil.com/').allow).toBe(false);
    });
});

describe('a window for an app you are BUILDING', () => {
    it('gets dev tools, which a normal app does not', () => {
        // The developer needs to inspect their own app. Everyone else's window
        // stays closed, so a third-party page cannot be talked into opening one.
        expect(appWindowOptions(app, '/genie/app-preload.js').webPreferences?.devTools).toBe(false);
        expect(
            appWindowOptions(app, '/genie/app-preload.js', { devMode: true }).webPreferences
                ?.devTools,
        ).toBe(true);
    });

    it('relaxes NOTHING else', () => {
        // Dev mode is one switch, not a mode. Sandbox, isolation, Node and web
        // security are identical — a developer's window is not a place to find out
        // that the isolation only worked because of a flag.
        const dev = appWindowOptions(app, '/p.js', { devMode: true }).webPreferences;
        const normal = appWindowOptions(app, '/p.js').webPreferences;

        expect(dev?.sandbox).toBe(normal?.sandbox);
        expect(dev?.contextIsolation).toBe(normal?.contextIsolation);
        expect(dev?.nodeIntegration).toBe(normal?.nodeIntegration);
        expect(dev?.webSecurity).toBe(normal?.webSecurity);
        expect(dev?.partition).toBe(normal?.partition);
    });

    it('says so in the title, since the user should know which windows these are', () => {
        expect(appWindowOptions(app, '/p.js', { devMode: true }).title).toMatch(/development/i);
    });
});

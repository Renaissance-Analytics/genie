import { describe, expect, it, vi } from 'vitest';
import { attachAppTabViews, appViewBounds, type AppViewDeps } from '../app-views';
import { appWindowTabs } from '../window-tabs';
import { validateAppManifest, type AppManifest } from '../manifest';

/**
 * The views a GApp's own tabs live in (Tynn #250, App Tray pivot).
 *
 * The window is Genie's: Genie draws the frame, the tab strip, and the Agent tab.
 * The app's surfaces are embedded views inside it — which creates the one mistake
 * that would quietly undo the whole model.
 *
 * **The bridge identifies a caller by its webContents.** Register the wrong one and
 * `gapp:call` starts answering for it. The Genie SHELL must therefore never be
 * registered as the app: it runs Genie's own preload with the whole desktop API,
 * and handing it the app's grant would let the app's identity be spoken with
 * Genie's privileges. Only the app's own views are registered, and this file exists
 * to keep that true.
 */

const manifest = (over: Record<string, unknown> = {}): AppManifest => {
    const result = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: [] },
        ...over,
    });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.value;
};

const deps = (over: Partial<AppViewDeps> = {}): AppViewDeps => ({
    makeView: vi.fn((prefs) => ({
        id: `wc-${Math.random().toString(36).slice(2, 8)}`,
        prefs,
        loaded: [] as string[],
        navigations: [] as string[],
        bounds: null as unknown,
    })),
    register: vi.fn(),
    loadURL: vi.fn(),
    guardNavigation: vi.fn(),
    preloadPath: '/genie/app-preload.js',
    ...over,
});

const twoTabs = () =>
    manifest({
        tabs: [
            { title: 'Board', path: '/' },
            { title: 'Settings', path: '/settings' },
        ],
    });

describe('which webContents get the app’s identity', () => {
    it('registers EVERY app view as the app', () => {
        const d = deps();
        const views = attachAppTabViews(twoTabs(), appWindowTabs(twoTabs()), d);

        expect(views).toHaveLength(2);
        expect(d.register).toHaveBeenCalledTimes(2);
        for (const call of (d.register as ReturnType<typeof vi.fn>).mock.calls) {
            expect(call[1]).toBe('com.example.trader');
        }
    });

    it('creates NO view for the Agent tab', () => {
        // It is Genie's own renderer. Giving it a view would mean giving it the
        // app's preload and the app's grant — the exact confusion this guards.
        const d = deps();
        attachAppTabViews(manifest(), appWindowTabs(manifest()), d);

        expect(d.makeView).toHaveBeenCalledTimes(1); // the one app tab, not the agent
    });

    it('registers only what it CREATED, so the shell can never be included', () => {
        // Structural: the manager has no way to name a webContents it did not make.
        const d = deps();
        const views = attachAppTabViews(twoTabs(), appWindowTabs(twoTabs()), d);
        const registered = (d.register as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

        expect(registered).toEqual(views.map((v) => v.view));
    });
});

describe('what each view is built with', () => {
    it('gets the APP’s preferences, not the shell’s', () => {
        const d = deps();
        attachAppTabViews(manifest(), appWindowTabs(manifest()), d);
        const prefs = (d.makeView as ReturnType<typeof vi.fn>).mock.calls[0]![0];

        expect(prefs.sandbox).toBe(true);
        expect(prefs.nodeIntegration).toBe(false);
        expect(prefs.contextIsolation).toBe(true);
        expect(prefs.preload).toContain('app-preload');
        expect(prefs.partition).toMatch(/^persist:gapp-/);
    });

    it('loads the tab’s own url', () => {
        const d = deps();
        attachAppTabViews(twoTabs(), appWindowTabs(twoTabs()), d);
        const urls = (d.loadURL as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);

        expect(urls).toEqual(['https://trader.gen/', 'https://trader.gen/settings']);
    });

    it('guards navigation on every view', () => {
        // Same-origin only, and an external link opens in the real browser. A view
        // without this is a frame that can be walked somewhere else.
        const d = deps();
        attachAppTabViews(twoTabs(), appWindowTabs(twoTabs()), d);

        expect(d.guardNavigation).toHaveBeenCalledTimes(2);
        expect((d.guardNavigation as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
            'https://trader.gen/',
        );
    });

    it('opens dev tools only for an app being built', () => {
        const dev = deps();
        attachAppTabViews(manifest(), appWindowTabs(manifest()), dev, { devMode: true });
        expect((dev.makeView as ReturnType<typeof vi.fn>).mock.calls[0]![0].devTools).toBe(true);

        const normal = deps();
        attachAppTabViews(manifest(), appWindowTabs(manifest()), normal);
        expect((normal.makeView as ReturnType<typeof vi.fn>).mock.calls[0]![0].devTools).toBe(false);
    });
});

describe('where a view sits in the window', () => {
    it('fills the window below the tab strip', () => {
        expect(appViewBounds({ width: 1000, height: 700 }, 40)).toEqual({
            x: 0,
            y: 40,
            width: 1000,
            height: 660,
        });
    });

    it('never gives a negative size on a window smaller than its own chrome', () => {
        // A collapsed or mid-animation window must not hand Electron a negative
        // height — it throws, and it would take the whole shell down with it.
        const bounds = appViewBounds({ width: 0, height: 10 }, 40);
        expect(bounds.height).toBeGreaterThanOrEqual(0);
        expect(bounds.width).toBeGreaterThanOrEqual(0);
    });
});

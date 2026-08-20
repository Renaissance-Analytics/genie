import { describe, expect, it } from 'vitest';
import { appWindowTabs } from '../window-tabs';
import { validateAppManifest, type AppManifest } from '../manifest';

/**
 * What a GApp window's tab strip holds (Tynn #250, App Tray pivot).
 *
 * The window is Genie-drawn now. Its FIRST tab is a clone of TheFloor's panel
 * management — terminals and files, exactly as a workspace has them — and the
 * app's own surfaces sit to the right of it.
 *
 * The order is not decoration. The Agent tab is the one surface Genie owns
 * outright and the app cannot draw, so it is where anything the user must be able
 * to trust belongs. Putting it first, always, is what makes "am I looking at Genie
 * or at the app?" answerable at a glance.
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

describe('the tab strip', () => {
    it('always leads with the Agent tab, which Genie owns', () => {
        const tabs = appWindowTabs(manifest());

        expect(tabs[0]?.kind).toBe('agent');
        expect(tabs[0]?.title).toMatch(/agent/i);
    });

    it('gives an app that declared no tabs ONE surface of its own', () => {
        // Every GApp serves something; an app that did not enumerate its tabs
        // still gets its front page, or the window would be Genie and nothing else.
        const tabs = appWindowTabs(manifest());

        expect(tabs).toHaveLength(2);
        expect(tabs[1]).toMatchObject({ kind: 'app', url: 'https://trader.gen/' });
    });

    it('renders declared tabs to the RIGHT, in the order the app listed them', () => {
        const tabs = appWindowTabs(
            manifest({
                tabs: [
                    { title: 'Board', path: '/' },
                    { title: 'Settings', path: '/settings' },
                ],
            }),
        );

        expect(tabs.map((t) => t.title)).toEqual(['Agent', 'Board', 'Settings']);
        expect(tabs[2]?.url).toBe('https://trader.gen/settings');
    });

    it('resolves every app tab against the app’s OWN origin', () => {
        // The manifest already refuses an absolute path, and this is the second
        // half of that promise: whatever it declared lands on <slug>.gen and
        // nowhere else.
        const tabs = appWindowTabs(manifest({ tabs: [{ title: 'X', path: '/deep/page?q=1' }] }));

        expect(new URL(tabs[1]!.url!).origin).toBe('https://trader.gen');
        expect(tabs[1]?.url).toBe('https://trader.gen/deep/page?q=1');
    });
});

describe('the Agent tab’s panels', () => {
    it('carries the panel count the app asked for', () => {
        const tabs = appWindowTabs(manifest({ panels: { agents: 3 } }));
        expect(tabs[0]?.panels?.agents).toBe(3);
    });

    it('carries one when the app said nothing', () => {
        expect(appWindowTabs(manifest())[0]?.panels?.agents).toBe(1);
    });
});

describe('what an app tab is NOT allowed to be', () => {
    it('never produces a tab off the app’s origin', () => {
        // The origin comes from the MANIFEST and nowhere else — there is no base
        // url a caller could pass to steer a tab somewhere unexpected.
        for (const tab of appWindowTabs(manifest({ tabs: [{ title: 'X', path: '/a' }] }))) {
            if (tab.url) expect(new URL(tab.url).origin).toBe('https://trader.gen');
        }
    });

    it('gives the Agent tab no url at all — it is not web content', () => {
        // It is Genie's own renderer. A url here would be a surface an app could
        // one day be pointed at.
        expect(appWindowTabs(manifest())[0]?.url).toBeUndefined();
    });
});

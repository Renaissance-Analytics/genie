import { describe, expect, it } from 'vitest';
import { gappHomeUrl, gappHostname, gappOrigin } from '../hostname';
import { appInstallPlan } from '../install-plan';
import { appWindowTabs } from '../window-tabs';
import { previewSitePlan, previewManifest } from '../preview';
import { validateAppManifest, type AppManifest } from '../manifest';

function manifest(over: Record<string, unknown> = {}): AppManifest {
    const parsed = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self', capabilities: [] },
        ...over,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.value;
}

describe('gappHostname', () => {
    it('names the site, the origin and the home page consistently', () => {
        expect(gappHostname('trader')).toBe('trader.gen');
        expect(gappOrigin('trader')).toBe('https://trader.gen');
        expect(gappHomeUrl('trader')).toBe('https://trader.gen/');
    });

    it('is always https', () => {
        // Genie serves `.gen` over TLS and rewrites http to it. This string is
        // also what `decideAppNavigation` compares a target origin against, so a
        // wrong scheme would not merely look wrong — it would decide same-origin
        // wrongly and either strand the app or let it out.
        expect(gappOrigin('anything')).toMatch(/^https:\/\//);
    });
});

/**
 * The point of the seam.
 *
 * A GApp's address used to be concatenated in four places. Four copies of one fact
 * is survivable only while the fact is permanent, and it is not: hosted GApp sites
 * are moving to `.gapp`. These assertions are what make that a ONE-line change —
 * if any builder stops agreeing with `gappHostname`, this fails rather than
 * shipping an app whose site is at one address and whose tabs point at another.
 */
describe('every place a GApp address is built agrees', () => {
    it('the installed site config', () => {
        expect(appInstallPlan('ws', manifest()).site.genName).toBe(gappHostname('trader'));
    });

    it('the origin a window’s tabs resolve against', () => {
        const tabs = appWindowTabs(manifest({ tabs: [{ title: 'Trade', path: '/trade' }] }));
        const app = tabs.find((t) => t.kind === 'app');

        expect(app?.url).toBe(`${gappOrigin('trader')}/trade`);
    });

    it('a preview’s site config', () => {
        const preview = previewManifest(manifest());

        expect(previewSitePlan('ws', preview, 'staging').site.genName).toBe(gappHostname('trader.preview'));
    });

    it('and the preview’s address is still one the installed app cannot hold', () => {
        // The seam must not quietly undo the collision-freedom: whatever the TLD
        // becomes, a preview's name has a label an installed slug cannot contain.
        expect(gappHostname('trader.preview')).not.toBe(gappHostname('trader'));
    });
});

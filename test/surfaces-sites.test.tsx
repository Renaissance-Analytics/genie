import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import type { SiteInfo } from '../src/main/site-manager.js';

/**
 * THE SITES TAB OVER DECLARED SITES (§6.6) — every site a workspace's envelope declares is a row. A running
 * one offers Stop; one that is listed but not running (disabled, its workspace asleep, stopped by you)
 * offers Start; one Genie 2 cannot serve says WHY and offers nothing to click. A site never started shows
 * no port rather than a made-up one.
 */

const site = (over: Partial<SiteInfo> & Pick<SiteInfo, 'id' | 'host' | 'state'>): SiteInfo =>
    ({ name: over.host.replace(/\.gen$/, ''), workspaceId: 'acme', repoPath: '/w/acme', serve: { mode: 'proxy' }, port: null, processIds: [], problem: null, ...over }) as SiteInfo;

const render = (sites: SiteInfo[]) =>
    renderToStaticMarkup(<HostingSurface data={{ ...EMPTY_FEATURES, hosting: { sites, processes: [], adding: null, frontDoor: { running: false, reason: 'off' } } } as FeatureData} onAction={() => {}} onNavigate={() => {}} />);

const row = (html: string, id: string) => {
    const m = new RegExp(`<li[^>]*data-site="${id}"[^>]*>([\\s\\S]*?)</li>`).exec(html);
    expect(m, `a row for ${id}`).not.toBeNull();
    return m![1]!;
};

describe('the Sites tab', () => {
    const html = render([
        site({ id: 'site_shop', host: 'shop.gen', state: 'running', port: 4101, processIds: ['site_shop'] }),
        site({ id: 'site_docs', host: 'docs.gen', state: 'stopped' }),
        site({ id: 'site_acme_aaaa000000000005', host: 'wallet.gen', state: 'unservable', serve: null, problem: 'it runs inside the workspace container (runMode "explicit"); Genie 2 serves sites host-native only, so it is not started here' }),
    ]);

    it('a running site shows its port and offers Stop', () => {
        const r = row(html, 'site_shop');
        expect(r).toContain('127.0.0.1:4101');
        expect(r).toMatch(/>Stop</);
        expect(r).not.toMatch(/>Start</);
    });

    it('a listed site that is not running offers Start, and no port it does not have', () => {
        const r = row(html, 'site_docs');
        expect(r).toMatch(/>Start</);
        expect(r).not.toMatch(/>Stop</);
        expect(r).not.toContain('127.0.0.1:');
    });

    it('a site Genie 2 cannot serve says why, with nothing to click', () => {
        const r = row(html, 'site_acme_aaaa000000000005');
        expect(r).toContain('data-site-problem');
        expect(r).toMatch(/host-native only/);
        expect(r).not.toMatch(/<button/);
    });
});

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteRow } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction, HostedSite } from '../src/renderer/features.js';
import type { SiteInfo } from '../src/main/site-manager.js';

/**
 * THE SITE ROW WHILE A SITE WAITS FOR ITS PORT, AND WHEN IT NEVER ANSWERED (parity audit 2026-10-30, top-15 #9; Genie 1
 * `main/dev-server/site-manager.ts` reported a start as not ready, with the reason, rather than as up).
 */
const site = (over: Partial<SiteInfo> & Pick<SiteInfo, 'id' | 'host' | 'state'>): HostedSite =>
    ({ name: over.host.replace(/\.gen$/, ''), workspaceId: 'acme', repoPath: '/w/acme', serve: { mode: 'proxy' }, port: 4101, processIds: [over.id], problem: null, ...over }) as HostedSite;
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement(node)) return [];
    const el = node as ReactElement<Record<string, unknown>>;
    return [el, ...elements(el.props.children as ReactNode)];
}

describe('the site row', () => {
    it('a starting site says "starting…", offers Stop, and nothing to Open yet (it does not answer)', () => {
        const html = renderToStaticMarkup(<SiteRow site={site({ id: 'site_web', host: 'web.gen', state: 'starting' })} editing={null} onAction={() => {}} />);
        expect(html).toMatch(/starting…/);
        expect(buttons(html)).toContain('Stop');
        expect(buttons(html)).not.toContain('Open');
        expect(buttons(html)).not.toContain('Start');
    });

    it('a site whose port never answered shows the reason and Retry, which restarts it', () => {
        const failed = site({ id: 'site_web', host: 'web.gen', state: 'failed', problem: 'web.gen did not answer on 127.0.0.1:4101 within 15 s' });
        const html = renderToStaticMarkup(<SiteRow site={failed} editing={null} onAction={() => {}} />);
        expect(html).toMatch(/did not answer on 127\.0\.0\.1:4101 within 15 s/);
        expect(buttons(html)).toContain('Retry');
        const sent: FeatureAction[] = [];
        const retry = elements(SiteRow({ site: failed, editing: null, onAction: (a) => sent.push(a) })).find((e) => e.props['data-site-action'] === 'retry');
        expect(retry).toBeDefined();
        (retry!.props.onClick as () => void)();
        expect(sent).toEqual([{ kind: 'hosting.restartSite', siteId: 'site_web' }]);
    });
});

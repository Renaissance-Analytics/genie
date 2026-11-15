import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { browserSiteLabels, siteLabel } from '../src/core/browser-sites.js';
import { BrowserSitesRow } from '../src/renderer/components/BrowserSitesRow.js';

/**
 * A SITE CHIP NEVER READS AN ID (Tynn #709; the owner's screenshot showed a chip reading a 26-character workspace id
 * followed by .mail.gen). main/host names each site by its workspace, and the chip draws that.
 */
const ULID = '01kx1y6g4ba9dymjbq5f9st5wh';
const names = { [ULID]: 'Atlas', '01abcdefghjkmnpqrstvwxyz12': 'Orbit' };

describe('browserSiteLabels', () => {
    it('a served site is its workspace name; a workspace with several adds the site name', () => {
        const labels = browserSiteLabels(['atlas.gen', 'orbit.gen', 'orbit-docs.gen'], [
            { host: 'atlas.gen', workspaceId: ULID, name: 'web' },
            { host: 'orbit.gen', workspaceId: '01abcdefghjkmnpqrstvwxyz12', name: 'app' },
            { host: 'orbit-docs.gen', workspaceId: '01abcdefghjkmnpqrstvwxyz12', name: 'docs' },
        ], names);
        expect(labels['atlas.gen']).toBe('Atlas');
        expect(labels['orbit.gen']).toBe('Orbit · app');
        expect(labels['orbit-docs.gen']).toBe('Orbit · docs');
    });
    it('a service host named by the workspace id is the workspace name and the service', () => {
        const labels = browserSiteLabels([`${ULID}.mail.gen`], [], names);
        expect(labels[`${ULID}.mail.gen`]).toBe('Atlas · mail');
        expect(Object.values(labels).join('|')).not.toContain(ULID);
    });
    it('an id-like host with no known workspace is never shown as the id', () => {
        const labels = browserSiteLabels([`${ULID}.mail.gen`, `${ULID}.gen`], [], {});
        expect(labels[`${ULID}.mail.gen`]).toBe('mail');
        expect(labels[`${ULID}.gen`]).toBe('Workspace site');
    });
    it('CONTROL: a plain host keeps its own name', () => {
        expect(browserSiteLabels(['tynn.gen'], [], {})['tynn.gen']).toBe('tynn');
    });
});

describe('siteLabel never returns an id', () => {
    it('drops an id-like leading label', () => {
        expect(siteLabel(`${ULID}.mail.gen`)).toBe('mail');
        expect(siteLabel(`${ULID}.gen`)).toBe('Workspace site');
    });
    it('CONTROL: a short or ordinary label stays', () => {
        expect(siteLabel('tynn.gen')).toBe('tynn');
        expect(siteLabel('api.tynn.gen')).toBe('api.tynn');
    });
});

describe('the row', () => {
    const host = `${ULID}.mail.gen`;
    it('shows the workspace name main gave it and never the id', () => {
        const h = renderToStaticMarkup(<BrowserSitesRow sites={[host]} current={null} labels={{ [host]: 'Atlas · mail' }} onOpen={() => {}} fit={1} />);
        expect(h).toContain('Atlas · mail');
        expect(h).not.toContain(`>${ULID}`);
        expect(h).not.toMatch(new RegExp(`>[^<]*${ULID}`));
    });
    it('with no label from main, still never the id', () => {
        const h = renderToStaticMarkup(<BrowserSitesRow sites={[host]} current={null} onOpen={() => {}} fit={1} />);
        expect(h).toContain('>mail<');
        expect(h).not.toMatch(new RegExp(`>[^<]*${ULID}`));
    });
    it('the » menu items are labelled the same way', () => {
        const h = renderToStaticMarkup(<BrowserSitesRow sites={['a.gen', host]} current={host} labels={{ [host]: 'Atlas · mail' }} onOpen={() => {}} fit={1} />);
        expect(h).toMatch(/data-browser-sites-more=""[^>]*aria-label="1 more site"/);
        expect(h).not.toContain(ULID.slice(0, 12) + '.mail');
    });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE MCP TRANSPORT, VERIFIED AT BOOT, ON SCREEN (§6.4 "native transport verified at boot", §6.9). Settings →
 * Workstation says where Genie's own MCP server listens and whether a real `server/discover` through its own
 * door answered at boot — the revision it serves, or the reason it did not. Nothing listening is said in a
 * sentence, never a dash.
 */

const integrations = (mcp: NonNullable<FeatureData['integrations']>['mcp']): NonNullable<FeatureData['integrations']> => ({
    tynnSignedIn: false,
    github: { steps: [{ id: 'authorize', done: false }, { id: 'install', done: false }], blocking: true, blockedBy: 'authorize', missingRepos: ['this workstation'], signal: { label: 'GitHub permissions are blocking features', route: 'genie://settings/github' } } as never,
    gated: [],
    lastSync: null,
    mcp,
});
const render = (mcp: NonNullable<FeatureData['integrations']>['mcp']) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: null, integrations: integrations(mcp) }} onAction={() => {}} onNavigate={() => {}} group="workstation" workspaces={[]} />);

describe('the MCP server line', () => {
    it('verified: the URL and the revision the probe answered', () => {
        const html = render({ url: 'http://127.0.0.1:41234/', verified: { ok: true, versions: ['2026-07-28'] } });
        expect(html).toContain('data-mcp-status="verified"');
        expect(html).toMatch(/127\.0\.0\.1:41234/);
        expect(html).toMatch(/2026-07-28/);
        expect(html).toMatch(/verified at boot/i);
    });

    it('listening but the probe failed: the reason in words', () => {
        const html = render({ url: 'http://127.0.0.1:41234/', verified: { ok: false, reason: 'server/discover answered 401' } });
        expect(html).toContain('data-mcp-status="unverified"');
        expect(html).toMatch(/server\/discover answered 401/);
    });

    it('nothing listening: a sentence, no dash, no URL', () => {
        const html = render({ url: null, verified: null });
        expect(html).toContain('data-mcp-status="off"');
        expect(html).toMatch(/not listening/i);
        expect(html).not.toMatch(/127\.0\.0\.1/);
    });
});

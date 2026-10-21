import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { routeOfAddress } from '../src/core/address.js';
import { railSurfacesFor } from '../src/core/rail-view.js';
import { parseRoute } from '../src/core/route.js';
import { EMPTY_SNAPSHOT, SERVABLE, type GenieSnapshot } from '../src/renderer/bridge.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * TOOLCHAIN LIVES IN SETTINGS (beta.33 item 20). The owner: "Tool chain is a Settings thing, it should not be its own
 * page in the menu." The Toolchain is the Settings sidebar's Toolchain section (System — this workstation's own tools),
 * drawn there in full; the menu row is gone; every old link to the page lands on that section.
 */
const SNAP: GenieSnapshot = { ...EMPTY_SNAPSHOT, agents: [], workspaces: [{ id: 'tynn', path: '/w/tynn', agentsKnown: true }], deckItems: [], workstation: { name: 'alphar', healthy: true } };
const tools: NonNullable<FeatureData['toolchain']> = { tools: [{ tool: 'node', installed: '22.1.0', latest: '22.1.0', tone: 'up-to-date', source: null }], checkedAt: 1 } as unknown as NonNullable<FeatureData['toolchain']>;
const render = (route: string, features: Partial<FeatureData> = {}) => renderToStaticMarkup(
    <Shell route={route} snapshot={SNAP} servable={SERVABLE} agentDetail={null} agentResolved={false} selectedRowId={null} chatThread={null} pinned={null}
        features={{ ...EMPTY_FEATURES, settings: { values: {} }, ...features }}
        onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}} onSend={() => {}} onCloseChat={() => {}}
        answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}} onFeature={() => {}} />,
);

describe('the old page’s links land on the Settings section', () => {
    it('genie://toolchain is Settings → Toolchain', () => {
        expect(parseRoute('genie://toolchain')).toMatchObject({ surface: 'settings', section: 'toolchain' });
    });

    it('the address genie://{workstation}/toolchain too', () => {
        const route = routeOfAddress('genie://alphar/toolchain', { workstation: 'alphar', workspaces: [], agents: [] } as never);
        expect(route === null ? null : parseRoute(route)).toMatchObject({ surface: 'settings', section: 'toolchain' });
    });
});

describe('no menu row', () => {
    it('the rail offers no Toolchain row — COUNTED against the rows it does offer', () => {
        const rows = railSurfacesFor(SERVABLE);
        expect(rows).not.toContain('toolchain');
        expect(rows).toContain('settings');
        const html = render('genie://dashboard');
        expect(html).not.toContain('data-nav="genie://toolchain"');
        expect(html).toContain('data-nav="genie://settings"');
    });
});

describe('the Settings section IS the Toolchain', () => {
    it('Settings → Toolchain draws the toolchain itself, not a button to another page', () => {
        const html = render('genie://settings/toolchain', { toolchain: tools });
        expect(html).toContain('data-surface="settings"');
        const section = html.slice(html.indexOf('data-surface="settings"'));
        expect(section).toContain('data-surface="toolchain"');
        expect(section).toContain('22.1.0');
        expect(html).not.toContain('data-action="open-toolchain"');
    });

    it('an old link renders the same section', () => {
        const html = render('genie://toolchain', { toolchain: tools });
        expect(html).toContain('data-surface="settings"');
        expect(html).toContain('data-surface="toolchain"');
    });
});

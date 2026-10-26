import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * A SETTING'S WORDS GET THE ROW; ITS CONTROL GETS A FIXED COLUMN (the owner, 2026-10-26, of a workspace Settings tab
 * whose "Default agent" description ran one word per line while its dropdown stretched across the page: "clean up our
 * workstation settings UI. I see several pages with smashed text columns and badly placed inputs"). The row was
 * `flex` with the words `flex-1` (min-width auto) beside a control that grows to fill: the control won, the words were
 * crushed. Now the words column may shrink (`min-w-0 flex-1`) and every control sits in one fixed-width, non-shrinking
 * column, right-aligned — the same on the workspace's Settings and the workstation's.
 */

const rowsOf = (html: string, attr: string) => [...html.matchAll(new RegExp(`<li[^>]*${attr}="[^"]+"[^>]*>([\\s\\S]*?)</li>`, 'g'))].map((m) => m[0]);
const laidOut = (row: string) => {
    expect(row).toMatch(/<div class="min-w-0 flex-1">/);
    expect(row).toMatch(/data-setting-control=""[^>]*class="[^"]*\bw-64\b[^"]*\bshrink-0\b/);
};

describe('the workspace’s Settings', () => {
    const ops: WorkspaceOpsProps = {
        asleep: false, agentCount: 1, removePreview: false, lastOutcome: null,
        onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
        settings: { values: { approval_gates: 'writes', agent_cap: '2', inbox_access: 'self' }, overridden: [], onSet: () => {}, onReset: () => {} },
        defaultAgent: { agents: [{ id: 'a1', name: 'tynn' }], current: 'a1', onSet: () => {} },
    } as WorkspaceOpsProps;
    it('every row, the default agent’s included: words that may shrink, the control in its fixed column', () => {
        const html = renderToStaticMarkup(<Workspace view="settings" workspace={{ id: 'tynn', name: 'tynn', path: '/w/tynn' }} terminals={NO_TERMINALS} ops={ops} />);
        const rows = [...rowsOf(html, 'data-ws-setting'), ...rowsOf(html, 'data-ws-default-agent')];
        expect(rows.length).toBeGreaterThan(3);
        rows.forEach(laidOut);
    });
});

describe('the workstation’s Settings', () => {
    it('every row on a page, and every search result, the same', () => {
        const data = { ...EMPTY_FEATURES, settings: { ...EMPTY_FEATURES.settings, values: {} } };
        const page = renderToStaticMarkup(<SettingsSurface data={data} onAction={() => {}} onNavigate={() => {}} section="workspace-defaults" />);
        const rows = rowsOf(page, 'data-setting');
        expect(rows.length).toBeGreaterThan(3);
        rows.forEach(laidOut);
        const found = renderToStaticMarkup(<SettingsSurface data={data} onAction={() => {}} onNavigate={() => {}} section={null} query="sync" />);
        const results = rowsOf(found, 'data-setting');
        expect(results.length).toBeGreaterThan(0);
        results.forEach(laidOut);
    });
});

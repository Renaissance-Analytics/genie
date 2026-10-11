import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * SETTINGS SEARCH (§6.9: "settings in four groups with search"). A query flattens the four groups
 * into one result list across all of them, each row naming its group; no match says so in a
 * sentence; an empty query shows the four tabs as before. The search box is always there.
 */

const render = (query: string | undefined) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} } }} onAction={() => {}} onNavigate={() => {}} group="general" {...(query === undefined ? {} : { query })} />);

describe('settings search', () => {
    it('the box is always present; without a query the four group tabs render', () => {
        const html = render(undefined);
        expect(html).toContain('data-settings-search');
        expect(html).toMatch(/Workstation/);
        expect(html).not.toContain('data-settings-results');
    });

    it('a query lists matches across ALL groups, each row naming its group, and hides the tabs', () => {
        const html = render('sound');
        expect(html).toContain('data-settings-results');
        expect(html).toContain('data-setting="notification_sounds"');
        expect(html).toMatch(/data-setting-group="general"/);
        expect(html).toContain('data-setting="sound_');
        expect(html).not.toContain('data-setting="theme"');
        const cross = render('agent');
        expect(cross).toContain('data-setting="restore_agents_on_launch"');
    });

    it('no match says so in a sentence naming the query, never an empty list', () => {
        const html = render('zzzqqq');
        expect(html).toMatch(/No setting matches “zzzqqq”/);
        expect(html).not.toContain('data-setting=');
    });
});

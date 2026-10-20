import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * SETTINGS SEARCH (§6.9). A query flattens every page into one result list, each row naming the page it lives on
 * (Genie 1's sidebar, core/settings-nav.ts); no match says so in a sentence; an empty query shows the page. The search
 * box is always there.
 */

const render = (query: string | undefined) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} } }} onAction={() => {}} onNavigate={() => {}} section="general" {...(query === undefined ? {} : { query })} />);

describe('settings search', () => {
    it('the box is always present; without a query the page renders', () => {
        const html = render(undefined);
        expect(html).toContain('data-settings-search');
        expect(html).toContain('data-settings-page="general"');
        expect(html).not.toContain('data-settings-results');
    });

    it('a query lists matches across ALL pages, each row naming its page, and hides the page', () => {
        const html = render('sound');
        expect(html).toContain('data-settings-results');
        expect(html).toContain('data-setting="notification_sounds"');
        expect(html).toMatch(/data-setting="notification_sounds" data-setting-section="notifications"/);
        expect(html).not.toContain('data-settings-page=');
        expect(html).toContain('data-setting="sound_');
        expect(html).not.toContain('data-setting="theme"');
        const cross = render('agent');
        expect(cross).toContain('data-setting="dnd_reply"');
    });

    it('no match says so in a sentence naming the query, never an empty list', () => {
        const html = render('zzzqqq');
        expect(html).toMatch(/No setting matches “zzzqqq”/);
        expect(html).not.toContain('data-setting=');
    });
});

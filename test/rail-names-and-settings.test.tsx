import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { railWorkspaces, railSurfacesFor } from '../src/core/rail-view.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';

/**
 * THE RAIL SHOWS NAMES AND OFFERS SETTINGS. 2.0.0-beta.7: 26 ULIDs where names belong, and no way to reach
 * Settings but the palette — "I have no menu to access my settings" (owner). The rail row is the labelled
 * route; the palette stays an accelerator.
 */
describe('rail', () => {
    it('a workspace row shows the NAME, never the id; a row without a name shows its folder', () => {
        const html = renderToStaticMarkup(
            <Sidebar
                route="genie://dashboard"
                available={['deck', 'dashboard', 'genie', 'workspace', 'settings']}
                workspaces={[
                    { id: '01k95ewyzkvkbxtpdt8b3qvyqk', name: 'Tynn.ai', path: 'C:\\_Projects\\tynn.ai', count: 3, alert: false },
                    { id: '01kex8dep28vm4awnsv3h8avd3', path: 'C:\\_Projects\\_packages\\fancy.agi', count: 0, alert: false },
                ]}
                deckCount={0}
                onNavigate={() => {}}
            />,
        );
        expect(html).toMatch(/data-workspace="01k95ewyzkvkbxtpdt8b3qvyqk"/);
        expect(html).toMatch(/>Tynn\.ai</);
        expect(html).toMatch(/>fancy\.agi</);
        expect(html).not.toMatch(/>01k95ewyzkvkbxtpdt8b3qvyqk</);
        expect(html).not.toMatch(/>01kex8dep28vm4awnsv3h8avd3</);
    });

    it('the name rides from the snapshot into the rail item', () => {
        const items = railWorkspaces([{ id: 'w', path: 'C:\\w\\tynn', name: 'Tynn.ai', agentsKnown: true }], []);
        expect(items[0]).toMatchObject({ id: 'w', name: 'Tynn.ai', count: 0 });
        const unread = railWorkspaces([{ id: 'w', path: 'C:\\w\\tynn', name: 'Tynn.ai', agentsKnown: false }], []);
        expect(unread[0]).toMatchObject({ id: 'w', name: 'Tynn.ai', count: null });
    });

    it('offers a Settings row when the settings surface can be served', () => {
        const html = renderToStaticMarkup(
            <Sidebar route="genie://dashboard" available={['deck', 'dashboard', 'genie', 'workspace', 'settings']} workspaces={[]} deckCount={0} onNavigate={() => {}} />,
        );
        expect(html).toContain('data-nav="genie://settings"');
        expect(html).toMatch(/>Settings</);
    });

    it('railSurfacesFor derives the settings row from the settings surface — CONTROL: absent without it', () => {
        expect(railSurfacesFor(['deck', 'dashboard', 'agent', 'workspace', 'settings'])).toContain('settings');
        expect(railSurfacesFor(['deck', 'dashboard'])).not.toContain('settings');
    });
});

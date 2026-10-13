import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, SERVABLE, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { FeatureData } from '../src/renderer/features.js';

/**
 * THE FEATURE SURFACES IN THE SHELL — every v1 feature the owner named has a route, and a route a
 * build can serve renders a body with its own `data-surface`. §0.3 and §0.4 in one test: a surface
 * that exists must be reachable (the rail/title bar), and a route that is served must draw
 * something that is not the Dashboard underneath.
 */

const SNAP: GenieSnapshot = {
    ...EMPTY_SNAPSHOT,
    agents: [],
    workspaces: [{ id: 'tynn', path: 'C:/_Projects/tynn.ai', agentsKnown: true }],
    deckItems: [],
    workstation: { name: 'alphar', healthy: true },
};

const FEATURES: FeatureData = {
    knowledge: { hits: null, query: '', adding: null, lastAdd: null },
    flows: null,
    hosting: null,
    services: null,
    toolchain: null,
    inbox: null,
    settings: { values: null },
    browser: { url: null, routes: [] },
    remote: null,
    integrations: null,
    plugins: null,
};

function render(route: string, features: Partial<FeatureData> = {}): string {
    return renderToStaticMarkup(
        <Shell
            route={route}
            snapshot={SNAP}
            servable={SERVABLE}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={null}
            pinned={null}
            features={{ ...FEATURES, ...features }}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onTogglePin={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
            onFeature={() => {}}
        />,
    );
}

describe('every feature surface is servable and draws its own body', () => {
    it('SERVABLE names them all — a surface missing here is §0.4: built and unreachable', () => {
        for (const s of ['knowledge', 'flows', 'hosting', 'toolchain', 'inbox', 'settings', 'browser']) expect(SERVABLE).toContain(s);
    });

    it('each route renders exactly its surface and not the Dashboard underneath', () => {
        for (const s of ['knowledge', 'flows', 'hosting', 'toolchain', 'inbox', 'settings', 'browser']) {
            const html = render(`genie://${s}`);
            expect(html, s).toContain(`data-surface="${s}"`);
            expect(html, s).not.toContain('data-surface="dashboard"');
            // The title bar shows the route verbatim (§4.0) — it is how a human and an agent name the same place.
            expect(html, s).toContain(`genie://${s}</span>`);
        }
    });
});

describe('first paint — skeletons, never zeros or empty states', () => {
    it('knowledge with no answer yet shows the search box and a skeleton, not "no results"', () => {
        const html = render('genie://knowledge');
        expect(html).toContain('data-surface="knowledge"');
        expect(html).toContain('data-skeleton');
        expect(html).not.toMatch(/no results|nothing found/i);
    });

    it('settings before values arrive shows the four group tabs and skeleton rows, never the defaults as if chosen', () => {
        const html = render('genie://settings');
        for (const g of ['General', 'Agents', 'Workstation', 'Appearance']) expect(html).toContain(g);
        expect(html).toContain('data-skeleton');
    });

    it('flows / hosting / toolchain / inbox with null data show a skeleton, not an empty-state sentence', () => {
        for (const s of ['flows', 'hosting', 'toolchain', 'inbox']) {
            const html = render(`genie://${s}`);
            expect(html, s).toContain('data-skeleton');
            expect(html, s).not.toMatch(/no flows|no sites|nothing installed|no messages/i);
        }
    });
});

describe('measured empties are a different claim', () => {
    it('flows with an empty list invites the first flow; inbox with no mail says so; hosting with no sites offers to add one', () => {
        expect(render('genie://flows', { flows: { flows: [], adding: null } })).toMatch(/first flow|Add a flow/i);
        expect(render('genie://inbox', { inbox: { unread: [], peers: [], recent: [] } })).toMatch(/No messages/i);
        expect(render('genie://hosting', { hosting: { sites: [], processes: [], adding: null, frontDoor: { running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' } } })).toMatch(/Add a site/i);
    });

    it('settings with values shows the chosen value for a setting and the four groups', () => {
        const html = render('genie://settings?group=appearance', { settings: { values: { theme: 'light' } } });
        expect(html).toContain('data-surface="settings"');
        expect(html).toContain('data-setting="theme"');
        expect(html).toContain('light');
    });

    it('the browser surface with no url shows the address bar only; with a url it names the page', () => {
        expect(render('genie://browser')).toContain('data-browser-address');
        const html = render('genie://browser?url=http%3A%2F%2Ftynn.gen%2F', { browser: { url: 'http://tynn.gen/', routes: [{ host: 'tynn.gen', target: '127.0.0.1:4101' }] } });
        expect(html).toContain('tynn.gen');
    });
});

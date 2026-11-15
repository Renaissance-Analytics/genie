import { describe, expect, it } from 'vitest';
import { addressOf, routeOfAddress } from '../src/core/address.js';
import { formatRoute, parseRoute } from '../src/core/route.js';
import { railSurfacesFor } from '../src/core/rail-view.js';

/**
 * THE DECK IS NOT A PAGE (Tynn #730, option B): its route redirects to the Dashboard, and the deep link still names its
 * item — `genie://deck?item=<id>` opens the Dashboard with that item's agent row opened on it. Old links, toasts' doors
 * and bookmarks keep working.
 */
describe('genie://deck redirects to the Dashboard', () => {
    it('parses to the Dashboard, carrying the item', () => {
        expect(parseRoute('genie://deck?item=approval:kai')).toEqual({ surface: 'dashboard', item: 'approval:kai', chat: null, pin: null });
        expect(parseRoute('genie://deck')).toEqual({ surface: 'dashboard', chat: null, pin: null });
        // The other modifiers ride along, as on any route.
        expect(parseRoute('genie://deck?item=q_1&chat=kai')).toMatchObject({ surface: 'dashboard', item: 'q_1', chat: 'kai' });
    });

    it('the Dashboard route formats its item back, and writes nothing when there is none (CONTROL: today’s links are unchanged)', () => {
        expect(formatRoute({ surface: 'dashboard', item: 'q_1', chat: null, pin: null })).toBe('genie://dashboard?item=q_1');
        expect(formatRoute({ surface: 'dashboard', chat: null, pin: null })).toBe('genie://dashboard');
        expect(formatRoute(parseRoute('genie://deck?item=q_1'))).toBe('genie://dashboard?item=q_1');
    });

    it('the workspace-addressed form redirects too: genie://<ws>/deck → the Dashboard', () => {
        const ctx = { workstation: 'alphar', workspaces: [], agents: [] };
        expect(routeOfAddress('genie://alphar/deck?item=q1', ctx)).toBe('genie://dashboard?item=q1');
        expect(routeOfAddress('genie://deck?item=q1', ctx)).toBe('genie://deck?item=q1');
        expect(addressOf('genie://dashboard?item=q1', ctx)).toBe('genie://alphar/dashboard?item=q1');
    });
});

describe('no Deck row in the rail', () => {
    it('the rail offers the Dashboard and no Deck, whatever the build serves', () => {
        const rows = railSurfacesFor(['dashboard', 'agent', 'hosting', 'settings'] as never);
        expect(rows).toContain('dashboard');
        expect(rows).not.toContain('deck');
    });
});

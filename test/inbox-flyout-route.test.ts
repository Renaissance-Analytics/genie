import { describe, expect, it } from 'vitest';
import { addressOf, routeOfAddress, type AddressContext } from '../src/core/address.js';
import { formatRoute, parseRoute } from '../src/core/route.js';

/**
 * THE AGENTINBOX IS A FLYOUT, NOT A PAGE (beta.33 item 19; the owner: "the agentinbox should not be a page and it should
 * be accessible from the header system icons just like it was in genie 1"). It rides every page as `inbox=`: empty =
 * open on its threads, a thread key or a message id = open on that one. A link to the old page (`genie://inbox`, an
 * address's `…/inbox`) opens the flyout. The address (the hash, the title bar) keeps it, so back and deep links work.
 */
const ctx: AddressContext = {
    workstation: 'alphar',
    workspaces: [{ id: 'ws_tynn', name: 'Tynn.ai', path: '/w/tynn.ai' }],
    agents: [{ id: 'agent_atlas', name: 'atlas', workspaceId: 'ws_tynn' }],
};

describe('the route', () => {
    it('`inbox=` rides any page — open on the threads, on a thread, on a message — and round-trips', () => {
        for (const text of [
            'genie://dashboard?group=workspace&inbox=',
            'genie://workspace/ws_tynn?inbox=human%7Cagent_atlas',
            'genie://agent/agent_atlas?tab=stream&inbox=msg_123',
            'genie://deck?inbox=',
            'genie://settings?inbox=',
        ]) {
            const route = parseRoute(text);
            expect(route.inbox, text).toBe(new URLSearchParams(text.split('?')[1]).get('inbox'));
            expect(formatRoute(route), text).toBe(text);
        }
    });

    it('closed: no `inbox` at all, and a route without it reads exactly as before (positive control: with it, it is there)', () => {
        expect(parseRoute('genie://dashboard?group=workspace')).toEqual({ surface: 'dashboard', group: 'workspace', chat: null, pin: null });
        expect(formatRoute({ ...parseRoute('genie://deck?inbox='), inbox: null })).toBe('genie://deck');
        expect(parseRoute('genie://deck?inbox=')).toHaveProperty('inbox', '');
    });

    it('the old page `genie://inbox` opens the flyout over the Dashboard — there is no inbox page any more', () => {
        expect(parseRoute('genie://inbox')).toEqual({ surface: 'dashboard', group: 'workspace', chat: null, pin: null, inbox: '' });
        expect(parseRoute('genie://inbox?inbox=msg_9')).toMatchObject({ surface: 'dashboard', inbox: 'msg_9' });
    });
});

describe('the address keeps it', () => {
    it('an internal route with the flyout open is an address with it open, and back again', () => {
        const cases: Array<[string, string]> = [
            ['genie://workspace/ws_tynn?inbox=', 'genie://alphar/tynn-ai/dashboard?inbox='],
            ['genie://agent/agent_atlas?tab=stream&inbox=msg_1', 'genie://alphar/tynn-ai/atlas?inbox=msg_1'],
            ['genie://settings?inbox=', 'genie://alphar/settings?inbox='],
            ['genie://dashboard?group=workspace&inbox=human%7Cagent_atlas', 'genie://alphar/dashboard?inbox=human%7Cagent_atlas'],
        ];
        for (const [internal, address] of cases) {
            expect(addressOf(internal, ctx), internal).toBe(address);
            expect(parseRoute(routeOfAddress(address, ctx)!).inbox, address).toBe(parseRoute(internal).inbox);
        }
        // Closed stays closed (positive control: the same page, no `inbox=`).
        expect(addressOf('genie://workspace/ws_tynn', ctx)).toBe('genie://alphar/tynn-ai/dashboard');
        expect(parseRoute(routeOfAddress('genie://alphar/tynn-ai/dashboard', ctx)!).inbox).toBeUndefined();
    });

    it('the old page’s address `…/inbox` opens the flyout', () => {
        expect(parseRoute(routeOfAddress('genie://alphar/inbox', ctx)!)).toMatchObject({ surface: 'dashboard', inbox: '' });
    });
});

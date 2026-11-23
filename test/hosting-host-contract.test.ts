import { afterEach, describe, expect, it } from 'vitest';
import { SITE_REACH_DECK_PREFIX } from '../src/core/site-reach.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * GENIE'S HOSTING IS GENIE-HOST'S (the host split, P5a): the front door, the service engines and the site routes are built
 * in the host (hosting-compose.ts) and kept there. Since 2g-4d E2b (Tynn #955) no window holds a replica of it: a window
 * reads the front door on frontdoor.watch (split-2g4d-d1-frontdoor-watch.test.ts) and the Hosting and Services tabs over
 * the protocol (features.snapshot/act). What stays the host's contract with its windows is the ELEVATION:
 *  1. an elevation the host needs with NO window connected is NOT attempted: it is held and answered "waiting for a
 *     window" — and connecting a window is not an approval: nothing is elevated by the connect;
 *  2. with a window connected, the person's Approve is the one elevation, asked of that window, and nothing waits.
 */

const rigs: HostingRig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
const rig = async () => { const r = await hostingRig(); rigs.push(r); return r; };

async function shopAdded(r: HostingRig) {
    // A site added in the host (as an agent's tool or a declared site would): the hosts block is due, and writing it needs
    // the OS prompt.
    await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, hostPort: 5174 });
    await tick();
    await r.stack.frontDoorSettled();
    await tick();
}

describe('Genie’s hosting in genie-host asks its elevations of a window', () => {
    it('with NO window, a site change asks nothing of the OS (Tynn #753); an Approve with no window waits, and a window connecting elevates nothing', async () => {
        const r = await rig();
        await shopAdded(r);
        expect(r.elevationsAsked).toEqual([]);
        expect(r.stack.trustDeckItems().map((i) => i.id)).toContain(`${SITE_REACH_DECK_PREFIX}shop.gen`);
        // The person approves from somewhere with no window (a phone's Deck): held, answered “waiting for a window”.
        const held = await r.stack.syncHosts();
        expect('error' in held ? held.error : '').toMatch(/^waiting for a window/);
        expect(r.elevationsAsked).toEqual([]);
        // Connecting is not an approval: nothing is elevated by it, and the hosts ask is still the person's to answer.
        await r.window();
        await tick();
        expect(r.elevationsAsked).toEqual([]);
        expect(r.stack.trustDeckItems().map((i) => i.id)).toContain(`${SITE_REACH_DECK_PREFIX}shop.gen`);
    });

    it('CONTROL: with a window connected, the person’s Approve is the one elevation, asked of that window', async () => {
        const r = await rig();
        await r.window();
        await shopAdded(r);
        expect(r.elevationsAsked).toEqual([]);
        expect(r.stack.trustDeckItems().map((i) => i.id)).toContain(`${SITE_REACH_DECK_PREFIX}shop.gen`);
        expect(await r.stack.syncHosts()).toEqual({ changed: true, elevated: true });
        await tick();
        expect(r.elevationsAsked.length).toBe(1);
        // The hosts write landed: what is left of "Open shop.gen in your browser" is the certificate (untrusted here), with
        // no hosts block (Tynn #743).
        const left = r.stack.trustDeckItems().find((i) => i.id.startsWith(SITE_REACH_DECK_PREFIX));
        expect(left?.why).toBe('Your computer asks once for administrator permission: Genie trusts its own certificate. Until then the site works in Genie’s browser.');
        expect(left?.detail).toBeUndefined();
    });
});

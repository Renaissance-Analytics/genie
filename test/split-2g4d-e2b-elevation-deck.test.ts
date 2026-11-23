import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ELEVATION_WAITING_DECK_ID } from '../src/core/elevation-waiting.js';
import type { DeckItem } from '../src/core/deck.js';
import { answerDeck, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/*
 * AN ELEVATION WAITING FOR A WINDOW IS ON GENIE-HOST'S DECK (2g-4d E2b, Tynn #955). genie-host never raises an OS prompt
 * itself: with no window to ask, its hosting's elevation is held ("waiting for a window"). Before the split the window read
 * that item from the hosting replica's dump; the replica is gone, so genie-host puts it on its own Deck — the one
 * deck.watch serves and every client's estate carries — and the Approve on it reaches genie-host's own Deck answer, which
 * runs the hosts sync (deck-answer.ts `sync-hosts`) exactly as the hosts ask's Approve does. No new mechanism.
 *
 * The Deck here is genie-host's, assembled as genie-host.ts assembles it (`featureDeckItems`: its hosting's own items and its
 * elevation's), and answered with genie-host's Deck ports (`syncHosts: () => hostingStack.syncHosts()`); the wiring pin
 * below holds genie-host to that.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const code = (path: string) => readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

let r: HostingRig | null = null;
afterEach(async () => { await r?.close(); r = null; });

/** genie-host's Deck as deck.watch says it: its hosting's items, then what waits for a window. */
const deck = (rig: HostingRig): DeckItem[] => [...rig.stack.trustDeckItems(), ...rig.elevation.deckItems()];
const waiting = (rig: HostingRig) => deck(rig).find((i) => i.id === ELEVATION_WAITING_DECK_ID);
/** genie-host's own Deck answer, as deck.answer reaches it over the protocol (features.act → HostFeatures → answerDeck). */
const ports = (rig: HostingRig): DeckAnswerPorts => ({
    deckItems: () => deck(rig), attention: {} as never, approvals: {} as never, inbox: {} as never,
    trustCertificate: () => rig.stack.trustCertificate(), deferTrustCertificate: () => rig.stack.deferTrustCertificate(),
    syncHosts: () => rig.stack.syncHosts(), deferHosts: () => rig.stack.deferHosts(),
});
const approve = (rig: HostingRig, item: DeckItem) => answerDeck({ kind: 'deck.answer', item, optionId: 'approve' }, ports(rig));

/** A site added in the host, with no window: the hosts block is due; then the person's Approve from a phone, held. */
async function heldForAWindow(rig: HostingRig): Promise<DeckItem> {
    await rig.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: rig.ws, serve: { mode: 'proxy' }, hostPort: 5174 });
    await tick();
    await rig.stack.frontDoorSettled();
    const held = await rig.stack.syncHosts();
    expect('error' in held ? held.error : '').toMatch(/^waiting for a window/);
    const item = waiting(rig);
    expect(item).toBeDefined();
    return item!;
}

describe('what waits for a window is on genie-host’s Deck, and its Approve answers it', () => {
    it('CONTROL: nothing asked, no item', async () => {
        r = await hostingRig();
        await r.window();
        expect(r.elevation.deckItems()).toEqual([]);
        expect(waiting(r)).toBeUndefined();
    });

    it('an elevation held for a window is an item naming what waits, and genie-host’s Deck is told', async () => {
        r = await hostingRig();
        let told = 0;
        r.elevation.onChange(() => { told += 1; });
        const item = await heldForAWindow(r);
        expect(item.title).toContain('update the hosts file');
        expect(item.answer).toMatchObject({ kind: 'inline', options: [{ id: 'approve' }] });
        expect(told).toBeGreaterThan(0);
        expect(r.elevationsAsked).toEqual([]);
    });

    it('Approve with a window open: asked of that window, the hosts file written, the item gone', async () => {
        r = await hostingRig();
        const item = await heldForAWindow(r);
        await r.window();
        await approve(r, item);
        expect(r.elevationsAsked).toHaveLength(1);
        expect(waiting(r)).toBeUndefined();
    });

    it('the prompt declined: the answer is refused with the reason, and nothing waits any more', async () => {
        r = await hostingRig();
        const item = await heldForAWindow(r);
        await r.window({ client: { elevate: async () => ({ ok: false, failed: null, error: 'The operation was canceled by the user.' }) } });
        await expect(approve(r, item)).rejects.toThrow(/canceled by the user/);
        expect(waiting(r)).toBeUndefined();
    });

    it('Approve with still no window: refused in the same words, and the item stays', async () => {
        r = await hostingRig();
        const item = await heldForAWindow(r);
        await expect(approve(r, item)).rejects.toThrow(/^waiting for a window/);
        expect(r.elevationsAsked).toEqual([]);
        expect(waiting(r)).toBeDefined();
    });
});

describe('wired: genie-host’s Deck carries its elevation, follows it, and answers it with its hosting', () => {
    const host = code('src/main/genie-host.ts');
    it('featureDeckItems reads the elevation’s items beside the hosting’s', () => {
        expect(host).toMatch(/const featureDeckItems = \(\) => assembleDeckItems\(\{[\s\S]{0,400}?trust: \[\.\.\.\(hostingStack\?\.trustDeckItems\(\) \?\? \[\]\), \.\.\.hostingElevation\.deckItems\(\)\],/);
    });
    it('an elevation that starts or stops waiting touches the estate, so deck.watch and every client say it', () => {
        expect(host).toMatch(/hostingElevation\.onChange\(\(\) => \{ phoneTouch\(\); \}\);/);
    });
    it('the Deck’s Approve reaches the hosting’s own hosts sync', () => {
        expect(host).toMatch(/deck: \{ attention: own\.attention, approvals, inbox: own\.inbox, deckItems: featureDeckItems,/);
        expect(host).toMatch(/syncHosts: \(\) => hostingStack\.syncHosts\(\)/);
    });
});

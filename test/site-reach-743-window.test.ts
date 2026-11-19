import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SITE_REACH_DECK_PREFIX } from '../src/core/site-reach.js';
import { CALLER_A, CALLER_B, item, presentationFixture, type PresentationFixture } from './helpers/features-host-presentation.js';

/**
 * TYNN #743, the wire: "Open shop.gen in your browser" ends in the person's NORMAL browser, opened from the window that
 * clicked it (genie-host's features, features-host.ts), never another window and never Genie's own browser pane.
 *
 * Written after the code: the GREEN job proves it is not vacuous by removing the wire (features-host.ts's openExternal
 * into the Deck's answer) and watching this go red, then restoring it.
 */

let f: PresentationFixture;
beforeEach(async () => {
    f = await presentationFixture();
    // The fixture host has no front door (no bundled Caddy), so its own hosts sync refuses; this test is about the window
    // the answer opens in, so the host's hosts sync is a recorder that answers "already right".
    Object.assign(f.deck, { syncHosts: async () => { f.record('host', 'sync-hosts'); return { changed: false, elevated: false }; } });
    // The host's Deck holds the ask (Tynn #861): an answer is resolved against it.
    f.deckItems.push(reach);
});
afterEach(async () => { await f?.close(); });

const reach = item({
    id: `${SITE_REACH_DECK_PREFIX}shop.gen`, source: 'genie', agentId: null, agentName: null, workspaceId: null, blocking: false,
    title: 'Open shop.gen in your browser',
    answer: { kind: 'inline', options: [{ id: 'open', label: 'Open in browser', tone: 'ok' }, { id: 'later', label: 'Not now', tone: 'neutral' }] },
});

describe('Open in browser opens the person’s normal browser in the window that answered', () => {
    it('caller A answers → the certificate step runs, then https://shop.gen opens in A’s normal browser alone', async () => {
        await f.answer({ kind: 'deck.answer', item: reach, optionId: 'open' });
        expect(f.calls).toEqual([
            { owner: 'host', effect: 'trust-certificate' },
            { owner: 'host', effect: 'sync-hosts' },
            { owner: CALLER_A.connectionId, effect: 'external', value: 'https://shop.gen' },
        ]);
    });

    it('caller B answers → B’s normal browser, not A’s', async () => {
        await f.answer({ kind: 'deck.answer', item: reach, optionId: 'open' }, CALLER_B);
        expect(f.calls.filter((c) => c.effect === 'external')).toEqual([{ owner: CALLER_B.connectionId, effect: 'external', value: 'https://shop.gen' }]);
    });

    it('CONTROL: Not now opens nothing', async () => {
        await f.answer({ kind: 'deck.answer', item: reach, optionId: 'later' });
        expect(f.calls.filter((c) => c.effect === 'external')).toEqual([]);
    });
});

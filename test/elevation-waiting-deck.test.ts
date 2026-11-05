import { describe, expect, it } from 'vitest';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { ELEVATION_WAITING_DECK_ID, elevationWaitingDeckItem } from '../src/core/elevation-waiting.js';
import { WindowElevation } from '../src/main/hosting-host.js';
import type { PrivilegedStep } from '../src/main/elevate.js';

/**
 * AN ELEVATION THAT WAITED FOR A WINDOW (the host split, P5a): genie-host held it because no window was open; the next
 * window shows it on the Deck, and Approve now is the person asking — it runs the hosts sync from that window, the one
 * privileged step the host can need with no one asking. Nothing else answers it.
 */

const hostsStep: PrivilegedStep = { id: 'hosts', label: 'update the hosts file', step: { command: 'cp', args: [] } as never };

describe('an elevation waiting for a window', () => {
    it('is one Deck item naming what waits, and Approve now runs the hosts sync', () => {
        const item = elevationWaitingDeckItem(['update the hosts file'], 5);
        expect(item?.id).toBe(ELEVATION_WAITING_DECK_ID);
        expect(item?.title).toContain('update the hosts file');
        expect(resolveDeckAnswer(item!, 'approve')).toEqual({ kind: 'sync-hosts' });
        expect(resolveDeckAnswer(item!, 'trust')).toMatchObject({ kind: 'refused' });
        expect(elevationWaitingDeckItem([], 5)).toBeNull();
    });

    it('with no window, nothing is asked; once a window is asked, nothing waits (CONTROL)', async () => {
        let connected = false;
        const asked: Array<readonly PrivilegedStep[]> = [];
        const elevation = new WindowElevation({ connected: () => connected, ask: async (steps) => { asked.push(steps); return { ok: false, failed: null, error: 'declined' }; }, now: () => 9 });
        const held = await elevation.run([hostsStep]);
        expect(held).toMatchObject({ ok: false });
        expect(held.ok ? '' : held.error).toMatch(/^waiting for a window/);
        expect(asked).toEqual([]);
        expect(elevation.waiting()).toEqual(['update the hosts file']);
        expect(elevation.deckItems().map((i) => i.id)).toEqual([ELEVATION_WAITING_DECK_ID]);
        connected = true;
        // The window's own answer (here the person declined) is the answer: asked, so nothing waits any more.
        expect(await elevation.run([hostsStep])).toEqual({ ok: false, failed: null, error: 'declined' });
        expect(asked.length).toBe(1);
        expect(elevation.waiting()).toEqual([]);
        expect(elevation.deckItems()).toEqual([]);
    });
});

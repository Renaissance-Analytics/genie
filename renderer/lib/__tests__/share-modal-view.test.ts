import { describe, expect, it } from 'vitest';
import { shareModalView } from '../share-modal-view';
import { shareInviteState } from '../share-invite-state';
import type { HostSessionRosterEntry } from '../host-session-roster';

/**
 * What the Share workspace modal shows, per state.
 *
 * The rule worth a test is the one a component would quietly get wrong: the URL
 * is served ONCE, by Tynn, on the mint response. Any state transition that stops
 * showing it has destroyed the only copy — so "somebody connected" must not hide
 * the copy button, even though it is the moment the waiting is over.
 */
const guest = (workspaces: 'all' | string[]): HostSessionRosterEntry =>
    ({
        id: 'p1',
        name: 'Sam',
        access: { capability: 'control', workspaces },
    }) as unknown as HostSessionRosterEntry;

describe('shareModalView', () => {
    it('offers the mint form only when there is no link yet', () => {
        expect(shareModalView({ kind: 'idle' }).showMintForm).toBe(true);
        expect(shareModalView({ kind: 'waiting', url: 'u' }).showMintForm).toBe(false);
        expect(shareModalView({ kind: 'connected', url: 'u', guests: [] }).showMintForm).toBe(
            false,
        );
    });

    it('keeps the link copyable AFTER somebody connects', () => {
        // THE point of this module. Tynn serves the URL on the mint response and
        // never again; hiding the copy control on arrival throws away the only
        // copy of a link the owner may still want to send to a second person.
        expect(shareModalView({ kind: 'connected', url: 'u', guests: [] }).canCopy).toBe(true);
    });

    it('has nothing to copy before a link exists', () => {
        // NEGATIVE CONTROL for the case above: `canCopy` must not simply be true.
        expect(shareModalView({ kind: 'idle' }).canCopy).toBe(false);
    });

    it('watches only while waiting', () => {
        // The waiting view is the one place this surface asks the host again.
        // Before a link there is nothing to wait for; after an arrival there is
        // nothing further, and a modal left open must not keep asking all day.
        expect(shareModalView({ kind: 'idle' }).watching).toBe(false);
        expect(shareModalView({ kind: 'waiting', url: 'u' }).watching).toBe(true);
        expect(shareModalView({ kind: 'connected', url: 'u', guests: [] }).watching).toBe(false);
    });

    it('titles each state differently, so the modal says which one it is in', () => {
        const titles = [
            shareModalView({ kind: 'idle' }).title,
            shareModalView({ kind: 'waiting', url: 'u' }).title,
            shareModalView({ kind: 'connected', url: 'u', guests: [] }).title,
        ];
        expect(new Set(titles).size).toBe(3);
    });

    it('goes idle → waiting → connected on the real state machine', () => {
        // End to end with `shareInviteState`, because the modal composes the two
        // and a view that is right about states the state machine never produces
        // proves nothing.
        expect(shareModalView(shareInviteState(null, 'design', [])).showMintForm).toBe(true);

        const minted = { url: 'https://tynn.ai/invites/accept/tok' };
        expect(shareModalView(shareInviteState(minted, 'design', [])).watching).toBe(true);

        const arrived = shareInviteState(minted, 'design', [guest(['design'])]);
        expect(shareModalView(arrived).watching).toBe(false);
        expect(shareModalView(arrived).canCopy).toBe(true);
    });
});

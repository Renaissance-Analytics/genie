import { describe, expect, it } from 'vitest';
import {
    DESKTOP_PRINCIPAL,
    decideBaton,
    emptyBaton,
    holdsBaton,
    type BatonPrincipal,
    type BatonRequest,
    type BatonState,
} from '../baton';

/**
 * The BATON — multi-user control transfer (the pure core).
 *
 * The host's kill-switch has always been a two-principal baton: either the
 * desktop holds control (remotes view-only) or it doesn't. This is that same
 * baton generalised to N connected users, with the owner-directed rule:
 *
 *   - EXACTLY ONE principal drives at a time (or nobody).
 *   - OWNERS may TAKE the baton off whoever holds it.
 *   - NON-OWNERS may never take — they can only be GIVEN it by the holder
 *     (claiming a FREE baton is not taking: nobody is being interrupted).
 */

const owner = (id = 'owner-1'): BatonPrincipal => ({
    id,
    name: 'Owner',
    emoji: '🦊',
    isOwner: true,
    since: 1,
});

const member = (id: string, emoji = '🐢'): BatonPrincipal => ({
    id,
    name: id,
    emoji,
    isOwner: false,
    since: 2,
});

/** Fold a list of requests over a state, returning the final state. */
function run(state: BatonState, ...reqs: BatonRequest[]): BatonState {
    return reqs.reduce((s, r) => decideBaton(s, r).state, state);
}

/** A state with everyone joined and nobody holding. */
function joined(...ps: BatonPrincipal[]): BatonState {
    return run(emptyBaton(), ...ps.map((principal) => ({ kind: 'join', principal }) as BatonRequest));
}

describe('baton: exactly one driver', () => {
    it('gives a FREE baton to the first principal that drives', () => {
        const state = joined(member('m-1'), member('m-2'));
        expect(state.holder).toBeNull();

        const d = decideBaton(state, { kind: 'drive', by: 'm-1' });
        expect(d.allowed).toBe(true);
        expect(d.changed).toBe(true);
        expect(d.state.holder).toBe('m-1');
        expect(holdsBaton(d.state, 'm-1')).toBe(true);
    });

    it('refuses a second driver while someone else holds the baton', () => {
        const state = run(joined(member('m-1'), member('m-2')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'drive', by: 'm-2' });
        expect(d.allowed).toBe(false);
        expect(d.state.holder).toBe('m-1'); // unchanged — still exactly one driver
        expect(d.changed).toBe(false);
        expect(d.reason).toMatch(/control/i);
    });

    it('lets the holder keep driving without churning state', () => {
        const state = run(joined(member('m-1')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'drive', by: 'm-1' });
        expect(d.allowed).toBe(true);
        expect(d.changed).toBe(false);
        expect(d.state.holder).toBe('m-1');
    });

    it('refuses a principal that never joined (an unknown principal can never hold)', () => {
        const state = joined(member('m-1'));

        const d = decideBaton(state, { kind: 'drive', by: 'ghost' });
        expect(d.allowed).toBe(false);
        expect(d.state.holder).toBeNull();
    });
});

describe('baton: owners TAKE, everyone else can only be GIVEN', () => {
    it('lets an OWNER take control off the current holder', () => {
        const state = run(joined(owner(), member('m-1')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'take', by: 'owner-1' });
        expect(d.allowed).toBe(true);
        expect(d.state.holder).toBe('owner-1');
    });

    it('REFUSES a non-owner taking control off the current holder', () => {
        const state = run(joined(member('m-1'), member('m-2')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'take', by: 'm-2' });
        expect(d.allowed).toBe(false);
        expect(d.state.holder).toBe('m-1');
        expect(d.reason).toMatch(/owner/i);
    });

    it('lets a non-owner claim a FREE baton (nobody is interrupted)', () => {
        const state = joined(member('m-1'));

        const d = decideBaton(state, { kind: 'take', by: 'm-1' });
        expect(d.allowed).toBe(true);
        expect(d.state.holder).toBe('m-1');
    });

    it('lets the holder GIVE control to another connected user', () => {
        const state = run(joined(member('m-1'), member('m-2')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'give', from: 'm-1', to: 'm-2' });
        expect(d.allowed).toBe(true);
        expect(d.state.holder).toBe('m-2');
    });

    it('refuses a give from someone who does not hold the baton', () => {
        const state = run(joined(member('m-1'), member('m-2')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'give', from: 'm-2', to: 'm-2' });
        expect(d.allowed).toBe(false);
        expect(d.state.holder).toBe('m-1');
        expect(d.reason).toMatch(/hold/i);
    });

    it('refuses a give to someone who is not connected', () => {
        const state = run(joined(member('m-1')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'give', from: 'm-1', to: 'ghost' });
        expect(d.allowed).toBe(false);
        expect(d.state.holder).toBe('m-1');
    });

    it('lets the holder release the baton, and refuses a release from anyone else', () => {
        const held = run(joined(member('m-1'), member('m-2')), { kind: 'drive', by: 'm-1' });

        const notMine = decideBaton(held, { kind: 'release', by: 'm-2' });
        expect(notMine.allowed).toBe(false);
        expect(notMine.state.holder).toBe('m-1');

        const mine = decideBaton(held, { kind: 'release', by: 'm-1' });
        expect(mine.allowed).toBe(true);
        expect(mine.state.holder).toBeNull();
    });

    it('lets the DESKTOP host owner take control off a member (the kill-switch, generalised)', () => {
        const state = run(
            joined(member('m-1'), {
                id: DESKTOP_PRINCIPAL,
                name: 'This computer',
                emoji: '🖥️',
                isOwner: true,
                since: 0,
            }),
            { kind: 'drive', by: 'm-1' },
        );

        const d = decideBaton(state, { kind: 'take', by: DESKTOP_PRINCIPAL });
        expect(d.allowed).toBe(true);
        expect(d.state.holder).toBe(DESKTOP_PRINCIPAL);
    });
});

describe('baton: presence', () => {
    it('frees the baton when its holder disconnects', () => {
        const state = run(joined(member('m-1'), member('m-2')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'leave', id: 'm-1' });
        expect(d.state.holder).toBeNull();
        expect(d.state.participants.map((p) => p.id)).toEqual(['m-2']);
    });

    it('leaves another user’s baton alone when a viewer disconnects', () => {
        const state = run(joined(member('m-1'), member('m-2')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, { kind: 'leave', id: 'm-2' });
        expect(d.state.holder).toBe('m-1');
    });

    it('refreshes identity on re-join (reconnect) without dropping the baton', () => {
        const state = run(joined(member('m-1', '🐢')), { kind: 'drive', by: 'm-1' });

        const d = decideBaton(state, {
            kind: 'join',
            principal: { ...member('m-1', '🦄'), name: 'Renamed' },
        });
        expect(d.state.holder).toBe('m-1');
        expect(d.state.participants).toHaveLength(1);
        expect(d.state.participants[0]!.emoji).toBe('🦄');
        expect(d.state.participants[0]!.name).toBe('Renamed');
    });
});

describe('baton: the invariant holds through any sequence', () => {
    it('never yields two holders or a holder who is not connected', () => {
        const sequence: BatonRequest[] = [
            { kind: 'join', principal: owner() },
            { kind: 'join', principal: member('m-1') },
            { kind: 'join', principal: member('m-2') },
            { kind: 'drive', by: 'm-1' },
            { kind: 'take', by: 'm-2' },
            { kind: 'give', from: 'm-1', to: 'm-2' },
            { kind: 'take', by: 'owner-1' },
            { kind: 'drive', by: 'm-2' },
            { kind: 'leave', id: 'owner-1' },
            { kind: 'drive', by: 'm-2' },
            { kind: 'give', from: 'm-2', to: 'm-1' },
            { kind: 'release', by: 'm-2' },
            { kind: 'leave', id: 'm-1' },
        ];

        let state = emptyBaton();
        for (const req of sequence) {
            state = decideBaton(state, req).state;
            const holders = state.participants.filter((p) => holdsBaton(state, p.id));
            expect(holders.length).toBeLessThanOrEqual(1);
            if (state.holder !== null) {
                expect(state.participants.some((p) => p.id === state.holder)).toBe(true);
            }
        }
    });
});

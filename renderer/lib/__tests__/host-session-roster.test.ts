import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BatonParticipant, MobilePeer } from '../genie';
import { hostSessionRoster, peerAccessLabel } from '../host-session-roster';

/**
 * Who is connected, on the host's remote-session banner (genie#681).
 *
 * The banner could not tell a guest shared one workspace, read-only, from the
 * owner's own paired phone; it offered to hand control to a read-only guest, who
 * can never drive; and its only way to remove someone was End session, which drops
 * everyone, the owner's own devices included.
 */

const participant = (over: Partial<BatonParticipant> = {}): BatonParticipant => ({
    id: 'user-sam',
    name: 'Sam Support',
    emoji: '🦊',
    isOwner: false,
    holdsControl: false,
    ...over,
});

const peer = (over: Partial<MobilePeer> = {}): MobilePeer => ({
    ip: '',
    since: 1,
    id: 'user-sam',
    name: 'Sam Support',
    emoji: '🦊',
    holdsControl: false,
    access: { capability: 'control', workspaces: ['Shared App'] },
    ...over,
});

describe('peerAccessLabel', () => {
    it('names the capability and the workspaces a guest reaches', () => {
        expect(peerAccessLabel({ capability: 'readonly', workspaces: ['Shared App'] })).toBe('Read-only · Shared App');
        expect(peerAccessLabel({ capability: 'control', workspaces: 'all' })).toBe('Control · All workspaces');
    });

    it('keeps a long list short', () => {
        expect(peerAccessLabel({ capability: 'control', workspaces: ['Shared App', 'Docs', 'Site'] })).toBe(
            'Control · Shared App and 2 more',
        );
    });

    it('says so when a grant reaches no workspace here', () => {
        expect(peerAccessLabel({ capability: 'control', workspaces: [] })).toBe('Control · No workspaces');
    });

    it("has nothing to say about the owner's own device", () => {
        expect(peerAccessLabel(null)).toBeNull();
    });
});

describe('hostSessionRoster', () => {
    it("tells a guest from the owner's own device, and offers Disconnect for the guest only", () => {
        const roster = hostSessionRoster(
            [participant(), participant({ id: 'owner-phone', name: 'Phone', isOwner: true })],
            [peer(), peer({ id: 'owner-phone', name: 'Phone', access: null })],
            true,
        );

        expect(roster.map((r) => [r.name, r.accessLabel, r.canDisconnect])).toEqual([
            ['Sam Support', 'Control · Shared App', true],
            ['Phone', null, false],
        ]);
    });

    it('never offers control to a read-only guest', () => {
        const [viewer] = hostSessionRoster(
            [participant({ readonly: true })],
            [peer({ access: { capability: 'readonly', workspaces: ['Shared App'] } })],
            true,
        );

        expect(viewer.canReceiveControl).toBe(false);
    });

    it('offers control to a control guest only while the desktop holds it, and not to whoever already drives', () => {
        expect(hostSessionRoster([participant()], [peer()], true)[0].canReceiveControl).toBe(true);
        expect(hostSessionRoster([participant()], [peer()], false)[0].canReceiveControl).toBe(false);
        expect(hostSessionRoster([participant({ holdsControl: true })], [peer()], true)[0].canReceiveControl).toBe(false);
    });

    it('leaves the desktop itself off the list', () => {
        expect(hostSessionRoster([participant({ id: 'desktop', name: 'This computer' })], [], true)).toEqual([]);
    });
});

describe('the remote-session banner', () => {
    // A source check, because the banner is not rendered in unit tests. The positive
    // control is that the banner does build its list from the roster.
    const source = readFileSync(join(__dirname, '../../pages/master.tsx'), 'utf8');

    it('builds its list from the roster, and disconnects one guest at a time', () => {
        expect(source).toContain('hostSessionRoster(participants, peers, locked)');
        expect(source).toContain('api().mobile.disconnectGuest(u.id)');
    });

    it('gates handing over control on the roster, not on the lock alone', () => {
        expect(source).toContain('disabled={busy || !u.canReceiveControl}');
        expect(source).not.toContain('disabled={busy || !locked || u.holdsControl}');
    });
});

import { describe, expect, it } from 'vitest';
import {
    connectedVia,
    shareInviteNote,
    shareInviteState,
} from '../share-invite-state';
import type { HostSessionRosterEntry } from '../host-session-roster';

/**
 * THE WAITING-FOR-CONNECTION VIEW.
 *
 * The owner's shape for sharing a workspace: right-click, create a link, then a
 * **waiting on connection** view with click-to-copy that changes once somebody
 * arrives. Those three states are the whole question the person holding the
 * modal has — "does my link work, or am I still waiting?" — so the rule that
 * decides between them is worth testing away from the component.
 *
 * Genie answers it WITHOUT asking Tynn: the host already knows who is connected
 * and what they reach (the guest roster, genie#681/#690). Polling a service for
 * something the desktop can see directly would be slower and less truthful.
 */
const guest = (
    name: string,
    workspaces: 'all' | string[],
    capability: 'control' | 'readonly' = 'control',
): HostSessionRosterEntry =>
    ({
        id: name.toLowerCase(),
        name,
        access: { capability, workspaces },
        accessLabel: null,
        canReceiveControl: false,
        canDisconnect: true,
    }) as unknown as HostSessionRosterEntry;

/** The owner's own device: a participant with NO access record. */
const ownDevice = (): HostSessionRosterEntry =>
    ({
        id: 'phone',
        name: 'My phone',
        access: null,
        accessLabel: null,
        canReceiveControl: true,
        canDisconnect: false,
    }) as unknown as HostSessionRosterEntry;

describe('who counts as connected to this workspace', () => {
    it('counts a guest scoped to exactly this workspace', () => {
        expect(connectedVia('Tynn.ai', [guest('Ada', ['Tynn.ai'])])).toHaveLength(1);
    });

    it('counts a guest who reaches ALL workspaces', () => {
        // A workstation-wide share reaches this workspace too. Saying "nobody is
        // here" to the person looking at an occupied workspace would be worse
        // than the imprecision of counting them.
        expect(connectedVia('Tynn.ai', [guest('Ada', 'all')])).toHaveLength(1);
    });

    it('does NOT count a guest scoped to a different workspace', () => {
        expect(connectedVia('Tynn.ai', [guest('Ada', ['Other'])])).toEqual([]);
    });

    it('does NOT count the owner’s own device', () => {
        // A participant with no access record is the owner's own phone or remote
        // window, not a guest. Counting it would show "connected" the moment you
        // opened the modal from your own phone.
        expect(connectedVia('Tynn.ai', [ownDevice()])).toEqual([]);
    });

    it('CONTROL: an empty roster is nobody', () => {
        // Without this, "counts a guest" would pass against a rule that counted
        // everything, including nothing.
        expect(connectedVia('Tynn.ai', [])).toEqual([]);
    });
});

describe('the three states the modal can be in', () => {
    it('is IDLE before a link exists', () => {
        expect(shareInviteState(null, 'Tynn.ai', []).kind).toBe('idle');
    });

    it('stays IDLE for a link with no URL, rather than offering nothing to copy', () => {
        // The URL exists for exactly one moment — the mint response — and the
        // list it joins does not carry one. A "waiting" view with no link is a
        // dead end wearing a progress indicator.
        expect(shareInviteState({}, 'Tynn.ai', []).kind).toBe('idle');
    });

    it('is WAITING once a link exists and nobody has arrived', () => {
        const s = shareInviteState({ url: 'https://tynn.ai/s/abc' }, 'Tynn.ai', []);

        expect(s.kind).toBe('waiting');
        expect(s.kind === 'waiting' && s.url).toBe('https://tynn.ai/s/abc');
    });

    it('is CONNECTED once someone reaches this workspace, and KEEPS the link', () => {
        // The link stays visible on purpose: more than one person may use it,
        // and hiding it the moment the first guest lands would strand the second.
        const s = shareInviteState(
            { url: 'https://tynn.ai/s/abc' },
            'Tynn.ai',
            [guest('Ada', ['Tynn.ai'])],
        );

        expect(s.kind).toBe('connected');
        expect(s.kind === 'connected' && s.url).toBe('https://tynn.ai/s/abc');
        expect(s.kind === 'connected' && s.guests).toHaveLength(1);
    });

    it('CONTROL: a guest elsewhere leaves it WAITING', () => {
        // Without this, "connected when someone arrives" would pass against a
        // rule that went connected for any session at all.
        const s = shareInviteState(
            { url: 'https://tynn.ai/s/abc' },
            'Tynn.ai',
            [guest('Ada', ['Other'])],
        );

        expect(s.kind).toBe('waiting');
    });
});

describe('what the line actually says', () => {
    const url = 'https://tynn.ai/s/abc';

    it('says nothing before there is a link', () => {
        expect(shareInviteNote({ kind: 'idle' })).toBeNull();
    });

    it('asks the person to send the link while waiting', () => {
        expect(shareInviteNote({ kind: 'waiting', url })).toMatch(/waiting/i);
    });

    it('names one guest', () => {
        expect(
            shareInviteNote({ kind: 'connected', url, guests: [guest('Ada', 'all')] }),
        ).toBe('Ada is connected.');
    });

    it('names two', () => {
        expect(
            shareInviteNote({
                kind: 'connected',
                url,
                guests: [guest('Ada', 'all'), guest('Bo', 'all')],
            }),
        ).toBe('Ada and Bo are connected.');
    });

    it('counts the rest beyond two, rather than listing a crowd', () => {
        expect(
            shareInviteNote({
                kind: 'connected',
                url,
                guests: [guest('Ada', 'all'), guest('Bo', 'all'), guest('Cy', 'all')],
            }),
        ).toBe('Ada and 2 others are connected.');
    });

    it('falls back to "Someone" rather than rendering a blank name', () => {
        const nameless = { ...guest('X', 'all'), name: '' } as HostSessionRosterEntry;

        expect(shareInviteNote({ kind: 'connected', url, guests: [nameless] })).toBe(
            'Someone is connected.',
        );
    });
});

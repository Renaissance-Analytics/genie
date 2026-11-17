import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectWatch, connectedHere, connectedWords, connectNotice } from '../src/core/connected-here.js';
import { ConnectedHereBanner } from '../src/renderer/components/ConnectedHereBanner.js';
import { EMPTY_SNAPSHOT } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES, type FeatureData, type RemoteSection } from '../src/renderer/features.js';
import { Shell, type ShellRemote } from '../src/renderer/Shell.js';

/**
 * SOMEONE IS CONNECTED TO THIS MACHINE, AND IT SAYS SO (Tynn #726, critical: the owner's live trial, 2026-11-16). A Pilot
 * connected to a client's Genie over the relay and the client saw NOTHING: no notice on connect, no banner while connected.
 * genie-host knew (RemoteHost.connections(), pushed to the window as features.remote.connections); the only reader was the
 * "Connected now" list on Settings → Remote access. Now every window of the machine being reached carries a banner while
 * anyone is connected, and main raises a desktop notification for each arrival. Names are fixtures, never real ones.
 */

type Conn = RemoteSection['connections'][number];
const conn = (id: string, label: string, driving = false, isOwner = true): Conn => ({ id, label, isOwner, workspaceId: null, driving });
const PILOT = conn('conn_1', 'Pilot laptop', true);
// A Take Over window from the same Pilot is a second connection with the same label: one person, said once.
const PILOT_TAKEOVER = conn('conn_2', 'Pilot laptop');
const GUEST = conn('conn_3', 'Guest tablet', false, false);

describe('who is connected, in few words', () => {
    it('nobody: nothing to show', () => {
        expect(connectedHere([])).toBeNull();
    });

    it('one person with two windows is one name; the driver is named', () => {
        expect(connectedHere([PILOT, PILOT_TAKEOVER])).toEqual({ labels: ['Pilot laptop'], driver: 'Pilot laptop' });
        expect(connectedWords(connectedHere([PILOT, PILOT_TAKEOVER])!)).toBe('Pilot laptop is connected · driving');
    });

    it('two people: both named, and who drives', () => {
        expect(connectedWords(connectedHere([GUEST, PILOT])!)).toBe('Guest tablet and Pilot laptop are connected · Pilot laptop driving');
        expect(connectedWords(connectedHere([GUEST])!)).toBe('Guest tablet is connected');
    });

    it('the notice names who and where', () => {
        expect(connectNotice('Pilot laptop', 'client-box')).toEqual({ title: 'Pilot laptop connected to client-box', body: 'They can see and use this machine. Lock or manage it in Genie.' });
    });
});

describe('each arrival is noticed once', () => {
    it('a new person is reported; their second window, a status redraw and a drop are not; a reconnect is again', () => {
        const watch = new ConnectWatch();
        expect(watch.next([])).toEqual([]);
        expect(watch.next([PILOT])).toEqual(['Pilot laptop']);
        expect(watch.next([PILOT])).toEqual([]);
        expect(watch.next([PILOT, PILOT_TAKEOVER])).toEqual([]);
        expect(watch.next([PILOT, PILOT_TAKEOVER, GUEST])).toEqual(['Guest tablet']);
        expect(watch.next([])).toEqual([]);
        expect(watch.next([conn('conn_9', 'Pilot laptop')])).toEqual(['Pilot laptop']);
    });

    it('someone already connected when the window comes up is reported (it is still someone on this machine)', () => {
        expect(new ConnectWatch().next([PILOT])).toEqual(['Pilot laptop']);
    });
});

const remoteSection = (connections: Conn[], locked = false): RemoteSection => ({
    host: 'client-box', url: null, unavailable: null, locked, pin: null, devices: [], pairRequests: [], connections,
    enabled: true, firewall: false, firewallRule: null, firewallOutcome: null, tailscale: null, tailscaleOutcome: null, tynnWorkstation: null,
} as unknown as RemoteSection);

describe('the banner', () => {
    const banner = (connections: Conn[], locked = false) => renderToStaticMarkup(<ConnectedHereBanner remote={remoteSection(connections, locked)} onAction={() => {}} onNavigate={() => {}} />);

    it('nobody connected: no banner (positive control below)', () => {
        expect(banner([])).toBe('');
    });

    it('while connected: who, Lock, and the way to Remote access', () => {
        const html = banner([PILOT, GUEST]);
        expect(html).toMatch(/role="status"/);
        expect(html).toMatch(/data-connected-here="2"/);
        expect(html).toContain('Guest tablet and Pilot laptop are connected · Pilot laptop driving');
        expect(html).toMatch(/data-action="connected-here-lock"[^>]*>[\s\S]*?Lock</);
        expect(html).toMatch(/data-action="connected-here-manage"/);
    });

    it('locked: says so, and offers Unlock', () => {
        const html = banner([PILOT], true);
        expect(html).toMatch(/data-action="connected-here-unlock"[^>]*>[\s\S]*?Unlock</);
        expect(html).not.toMatch(/data-action="connected-here-lock"/);
    });
});

describe('composed: on the machine being reached, never on the Pilot', () => {
    const shell = (features: FeatureData, remote?: ShellRemote) => renderToStaticMarkup(
        <Shell
            route="genie://dashboard"
            snapshot={EMPTY_SNAPSHOT}
            features={features}
            servable={['dashboard', 'settings']}
            agentDetail={null}
            agentResolved
            selectedRowId={null}
            chatThread={null}
            pinned={null}
            remote={remote}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
        />,
    );
    const BANNER = /data-connected-here="/g;
    const count = (html: string) => html.match(BANNER)?.length ?? 0;

    it('the client’s own window: one banner while someone is connected, none when nobody is', () => {
        expect(count(shell({ ...EMPTY_FEATURES, remote: remoteSection([PILOT]) }))).toBe(1);
        expect(count(shell({ ...EMPTY_FEATURES, remote: remoteSection([]) }))).toBe(0);
    });

    it('the Pilot’s window reads the host’s list (itself in it) and has its own badge: no banner', () => {
        const driving: ShellRemote = { host: 'client-box', driver: 'Pilot laptop', driving: true, locked: false };
        expect(count(shell({ ...EMPTY_FEATURES, remote: remoteSection([PILOT]) }, driving))).toBe(0);
    });
});

describe('main raises the desktop notice on each arrival', () => {
    it('main watches remote access with ConnectWatch and shows a Notification from connectNotice', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/new ConnectWatch\(\)/);
        expect(main).toMatch(/composed\.remote\.onChange\([\s\S]{0,600}\.next\(composed\.remote\.connections\(\)\)[\s\S]{0,600}connectNotice\([\s\S]{0,300}new Notification\(/);
    });
});

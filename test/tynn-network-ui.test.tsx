import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { relayWorkstationOf, remoteFromSearch, remoteWindowSearch } from '../src/core/remote-window.js';
import { remoteUrl } from '../src/renderer/remote-session.js';
import { ipcRelayTransport, type TynnNetworkBridge } from '../src/renderer/relay-transport.js';
import { ConnectRemote } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * THE TYNN NETWORK IN THE WINDOW (Tynn #837): a Tynn workstation is a host like any other — it opens in its own
 * window, bound to `relay:<workstation id>` — but its connection lives in MAIN (the grant and the proof key never
 * reach the renderer), and the window talks to it over IPC. Connect lists the workstations Tynn says this person may
 * reach.
 */

describe('a window bound to a Tynn workstation', () => {
    it('`relay:<id>` is a host a window can be bound to, and names its workstation', () => {
        expect(remoteFromSearch(remoteWindowSearch('relay:ws_01abc'))).toBe('relay:ws_01abc');
        expect(relayWorkstationOf('relay:ws_01abc')).toBe('ws_01abc');
        expect(relayWorkstationOf('wss://studio.example.com/genie')).toBeNull();
    });

    it('nothing else that LOOKS like it is (CONTROL: ws/wss still are)', () => {
        expect(remoteFromSearch(remoteWindowSearch('relay:'))).toBeNull();
        expect(remoteFromSearch(remoteWindowSearch('relay:ws 1'))).toBeNull();
        expect(remoteFromSearch(remoteWindowSearch('relay:../x'))).toBeNull();
        expect(remoteFromSearch(remoteWindowSearch('wss://studio.example.com/genie'))).toBe('wss://studio.example.com/genie');
    });

    it('remoteUrl passes a relay address through untouched', () => {
        expect(remoteUrl('relay:ws_01abc')).toEqual({ ok: true, url: 'relay:ws_01abc' });
    });
});

function fakeNet() {
    const sent: Array<[string, string]> = [];
    const closed: string[] = [];
    const messages = new Set<(channel: string, text: string) => void>();
    const closes = new Set<(channel: string, reason: string | null) => void>();
    const net: TynnNetworkBridge = {
        workstations: async () => ({ ok: true, workstations: [] }),
        open: async () => ({ ok: true, channel: 'c1' }),
        send: (channel, text) => { sent.push([channel, text]); },
        close: (channel) => { closed.push(channel); },
        onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
        onClosed: (l) => { closes.add(l); return () => { closes.delete(l); }; },
    };
    return { net, sent, closed, message: (c: string, t: string) => { for (const l of messages) l(c, t); }, close: (c: string, r: string | null) => { for (const l of closes) l(c, r); } };
}

describe('ipcRelayTransport — the window’s end of main’s relay connection', () => {
    it('sends and receives on ITS channel only', () => {
        const f = fakeNet();
        const t = ipcRelayTransport(f.net, 'c1');
        const got: string[] = [];
        t.onMessage((m) => got.push(m));
        t.send('{"kind":"hello"}');
        f.message('c1', 'mine');
        f.message('c2', 'someone else’s');
        expect(f.sent).toEqual([['c1', '{"kind":"hello"}']]);
        expect(got).toEqual(['mine']);
    });

    it('closed by main: once, with the reason; closed here: main is told', () => {
        const f = fakeNet();
        const t = ipcRelayTransport(f.net, 'c1');
        let closes = 0;
        t.onClose(() => closes++);
        f.close('c2', 'not mine');
        expect(closes).toBe(0);
        f.close('c1', 'grant is no longer active');
        f.close('c1', 'again');
        expect(closes).toBe(1);
        expect(t.closedBecause()).toBe('grant is no longer active');
        const u = ipcRelayTransport(f.net, 'c3');
        u.close();
        expect(f.closed).toEqual(['c3']);
    });
});

describe('Connect lists your Tynn workstations', () => {
    const base = { state: null, remembered: [], onConnect: () => {}, onDisconnect: () => {} };

    it('each one Tynn says you may reach opens in its own window; one you may not is shown, not offered', () => {
        const html = renderToStaticMarkup(
            <ConnectRemote
                {...base}
                tynnWorkstations={{ ok: true, workstations: [
                    { id: 'ws_cloud', name: 'cloud box', active: true, connectable: true, local: false, source: 'owner' },
                    { id: 'ws_pat', name: 'Pat’s laptop', active: true, connectable: false, local: true, source: null },
                ] }}
                onOpenWorkstation={() => {}}
            />,
        );
        expect(html).toMatch(/data-tynn-workstation-row="ws_cloud"[^]*?data-action="open-workstation"/);
        const pat = html.slice(html.indexOf('data-tynn-workstation-row="ws_pat"'));
        expect(pat.slice(0, pat.indexOf('</li>'))).not.toContain('data-action="open-workstation"');
        expect(html).toContain('Pat’s laptop');
    });

    it('Tynn could not be asked: says why', () => {
        const html = renderToStaticMarkup(<ConnectRemote {...base} tynnWorkstations={{ ok: false, reason: 'sign in to Tynn to see your workstations' }} onOpenWorkstation={() => {}} />);
        expect(html).toContain('sign in to Tynn to see your workstations');
    });

    it('not asked (CONTROL): no Tynn list at all', () => {
        expect(renderToStaticMarkup(<ConnectRemote {...base} />)).not.toContain('data-tynn-workstations');
    });
});

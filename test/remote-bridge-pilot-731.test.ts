import { describe, expect, it, vi } from 'vitest';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';

// Tynn #731: the Pilot's Genie opens a sign-in link the drone sent over its connection, in the Pilot's own browser,
// through the same https-only guard a local window uses. The drone's frames are untrusted.
type Frame = { kind: string; id: number; method: string; args: unknown[] };
function pilotLink() {
    const listeners = new Set<(text: string) => void>();
    const sent: Frame[] = [];
    const transport: ClientTransport = { send: text => { const f = JSON.parse(text) as Frame; if (f.kind === 'call') sent.push(f); }, onMessage: l => { listeners.add(l); return () => { listeners.delete(l); }; }, onClose: () => () => {}, close: () => {} };
    return { transport, sent, deliver: (payload: unknown, channel = 'sign-in.open') => { for (const l of listeners) l(JSON.stringify({ kind: 'event', channel, payload })); } };
}
let clock = 1_000_000;
const dial = (openExternal: ((url: string) => unknown) | undefined) => {
    const link = pilotLink();
    const options = { now: () => clock, ...(openExternal ? { openExternal } : {}) };
    const remote = (connectRemote as (...a: unknown[]) => ReturnType<typeof connectRemote>)(link.transport, { kind: 'relay' }, 'laptop', options);
    /** The Pilot starts a sign-in on this connection; the call's id is what the drone's link must name. */
    const start = (kind = 'integrations.githubSignIn'): number => {
        void (remote.bridge as unknown as { features: { act(a: unknown): Promise<unknown> } }).features.act({ kind });
        return link.sent.at(-1)!.id;
    };
    return { ...link, start };
};
const url = 'https://github.com/login/device';

describe('a Pilot opens a sign-in link only in answer to a sign-in it started (Tynn #731)', () => {
    it.each(['integrations.githubSignIn', 'integrations.tynnSignIn', 'tailscale.up', 'tailscale.install'])('POSITIVE CONTROL: after %s, the link naming that request opens once, by the Pilot’s own opener', kind => {
        const open = vi.fn(); const link = dial(open);
        const request = link.start(kind);
        link.deliver({ url, request });
        expect(open).toHaveBeenCalledExactlyOnceWith(url);
    });
    it('a GitHub page the Pilot asked for opens too', () => {
        const open = vi.fn(); const link = dial(open);
        const request = link.start('integrations.githubOpen');
        link.deliver({ url, request });
        expect(open).toHaveBeenCalledExactlyOnceWith(url);
    });
    it('UNSOLICITED: a link when the Pilot started nothing is ignored and logged', () => {
        const open = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const link = dial(open);
        link.deliver({ url, request: 1 });
        link.deliver({ url });
        expect(open).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(2);
        expect(String(warn.mock.calls[0]![0])).toMatch(/sign-in/i);
        warn.mockRestore();
    });
    it('UNKNOWN ID: a link naming a request the Pilot never made is ignored and logged', () => {
        const open = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const link = dial(open);
        const request = link.start();
        link.deliver({ url, request: request + 7 });
        expect(open).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        link.deliver({ url, request });
        expect(open).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
    it('NOT A SIGN-IN: a request the Pilot made for something else cannot carry a link', () => {
        const open = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const link = dial(open);
        const request = link.start('integrations.githubRefresh');
        link.deliver({ url, request });
        expect(open).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
    it('EXPIRED: a link arriving minutes after the sign-in was started is ignored and logged', () => {
        const open = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const link = dial(open);
        const request = link.start();
        clock += 10 * 60_000;
        link.deliver({ url, request });
        expect(open).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
    it('WITHIN THE WINDOW: a link a minute after the start still opens', () => {
        const open = vi.fn(); const link = dial(open);
        const request = link.start();
        clock += 60_000;
        link.deliver({ url, request });
        expect(open).toHaveBeenCalledTimes(1);
    });
    it('REPLAYED: the same request opens one link, never a second', () => {
        const open = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const link = dial(open);
        const request = link.start();
        link.deliver({ url, request });
        link.deliver({ url: 'https://evil.example/phish', request });
        expect(open).toHaveBeenCalledExactlyOnceWith(url);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
    it.each(['file:///C:/Windows/System32/calc.exe', 'http://github.com/login', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', ''])(
        'even for a request the Pilot made, a %s link is refused on the Pilot side', bad => {
            const open = vi.fn(); const link = dial(open);
            link.deliver({ url: bad, request: link.start() });
            expect(open).not.toHaveBeenCalled();
        });
    it('a payload that is not { url: string, request: number } opens nothing', () => {
        const open = vi.fn(); const link = dial(open); const request = link.start();
        for (const payload of [null, url, { url: 5, request }, { request }, { url, request: '1' }, []]) link.deliver(payload);
        expect(open).not.toHaveBeenCalled();
    });
    it('another channel carrying a url opens nothing', () => {
        const open = vi.fn(); const link = dial(open); const request = link.start();
        link.deliver({ url, request }, 'features');
        expect(open).not.toHaveBeenCalled();
    });
    it('a client given no opener ignores the event without failing', () => {
        const link = dial(undefined); const request = link.start();
        expect(() => link.deliver({ url, request })).not.toThrow();
    });
    it('an opener that throws does not break the connection', () => {
        const link = dial(() => { throw new Error('no browser'); }); const request = link.start();
        expect(() => link.deliver({ url, request })).not.toThrow();
    });
});

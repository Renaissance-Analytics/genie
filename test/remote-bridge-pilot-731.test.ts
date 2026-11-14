import { describe, expect, it, vi } from 'vitest';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { connectRemote } from '../src/renderer/remote-bridge.js';

// Tynn #731: the Pilot's Genie opens a sign-in link the drone sent over its connection, in the Pilot's own browser,
// through the same https-only guard a local window uses. The drone's frames are untrusted.
function pilotLink() {
    const listeners = new Set<(text: string) => void>();
    const transport: ClientTransport = { send: () => {}, onMessage: l => { listeners.add(l); return () => { listeners.delete(l); }; }, onClose: () => () => {}, close: () => {} };
    return { transport, deliver: (payload: unknown, channel = 'sign-in.open') => { for (const l of listeners) l(JSON.stringify({ kind: 'event', channel, payload })); } };
}
const dial = (openExternal: ((url: string) => unknown) | undefined) => {
    const link = pilotLink();
    const options = openExternal ? { openExternal } : {};
    (connectRemote as (...a: unknown[]) => unknown)(link.transport, { kind: 'relay' }, 'laptop', options);
    return link;
};

describe('a Pilot opens the drone’s sign-in link in its own browser (Tynn #731)', () => {
    it('an https link from the drone is opened once, by the Pilot’s own opener', () => {
        const open = vi.fn(); const link = dial(open);
        link.deliver({ url: 'https://github.com/login/device' });
        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/login/device');
    });
    it.each(['file:///C:/Windows/System32/calc.exe', 'http://github.com/login', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', ''])(
        'a %s link is refused on the Pilot side and nothing opens', url => {
            const open = vi.fn(); const link = dial(open);
            link.deliver({ url });
            expect(open).not.toHaveBeenCalled();
        });
    it('a payload that is not { url: string } opens nothing', () => {
        const open = vi.fn(); const link = dial(open);
        for (const payload of [null, 'https://github.com/login/device', { url: 5 }, {}, []]) link.deliver(payload);
        expect(open).not.toHaveBeenCalled();
    });
    it('another channel carrying a url opens nothing', () => {
        const open = vi.fn(); const link = dial(open);
        link.deliver({ url: 'https://github.com/login/device' }, 'features');
        expect(open).not.toHaveBeenCalled();
    });
    it('a client given no opener ignores the event without failing', () => {
        const link = dial(undefined);
        expect(() => link.deliver({ url: 'https://github.com/login/device' })).not.toThrow();
    });
    it('an opener that throws does not break the connection', () => {
        const link = dial(() => { throw new Error('no browser'); });
        expect(() => link.deliver({ url: 'https://github.com/login/device' })).not.toThrow();
    });
});

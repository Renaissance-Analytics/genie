import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AuthRequest } from '../src/core/remote-protocol.js';
import { deviceLinkProtocol, type DeviceLinkProtocolPorts } from '../src/main/device-link-protocol.js';
import { deviceAuth, knownHosts, moveRememberedTokens, rememberedTokens, type DeviceLinkBridge, type TokenStorage } from '../src/renderer/remote-session.js';

/**
 * THE WINDOW'S SIDE OF M-e. A pairing's token leaves localStorage once, only after the host has read the same bytes back, and from then on the window holds a channel
 * and a list of addresses. A drone's dial stops in main, before anything is asked of the host.
 */

const URL_A = 'wss://studio:7421/genie';
const URL_B = 'wss://beast:7421/genie';

function memory(): TokenStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}
function bridge(adopt: DeviceLinkBridge['adopt']): DeviceLinkBridge & { adopted: [string, string][] } {
    const adopted: [string, string][] = [];
    return {
        adopted,
        open: async () => ({ ok: true, channel: 'device_1' }),
        hosts: async () => [],
        forget: async () => true,
        adopt: (url, token) => { adopted.push([url, token]); return adopt(url, token); },
    };
}

describe('moving the tokens out of localStorage, once', () => {
    it('after it, no token is readable from localStorage', async () => {
        const s = memory();
        rememberedTokens(s).remember(URL_A, 'tok_a');
        rememberedTokens(s).remember(URL_B, 'tok_b');
        const b = bridge(async () => true);
        await moveRememberedTokens(s, b);
        expect(b.adopted).toEqual([[URL_A, 'tok_a'], [URL_B, 'tok_b']]);
        expect(rememberedTokens(s).hosts()).toEqual([]);
        expect(JSON.stringify([...s.data])).not.toContain('tok_');
    });

    it('a token the host did not read back stays where it is, and the others still move', async () => {
        const s = memory();
        rememberedTokens(s).remember(URL_A, 'tok_a');
        rememberedTokens(s).remember(URL_B, 'tok_b');
        await moveRememberedTokens(s, bridge(async (url) => url === URL_B));
        expect(rememberedTokens(s).tokenFor(URL_A)).toBe('tok_a');
        expect(rememberedTokens(s).tokenFor(URL_B)).toBeNull();
    });

    it('a host that throws loses nothing', async () => {
        const s = memory();
        rememberedTokens(s).remember(URL_A, 'tok_a');
        await moveRememberedTokens(s, bridge(async () => { throw new Error('the link dropped'); }));
        expect(rememberedTokens(s).tokenFor(URL_A)).toBe('tok_a');
    });

    it('with nothing there it asks the host nothing, so a second run does nothing', async () => {
        const s = memory();
        rememberedTokens(s).remember(URL_A, 'tok_a');
        const b = bridge(async () => true);
        await moveRememberedTokens(s, b);
        await moveRememberedTokens(s, b);
        expect(b.adopted).toHaveLength(1);
    });

    it('the known hosts are kept: names and when, which were never secret', async () => {
        const s = memory();
        rememberedTokens(s).remember(URL_A, 'tok_a');
        knownHosts(s).noteConnected(URL_A, 'studio', 7);
        await moveRememberedTokens(s, bridge(async () => true));
        expect(knownHosts(s).list()[0]).toMatchObject({ url: URL_A, name: 'studio', lastConnectedAt: 7 });
    });
});

describe('the known hosts when the host holds the tokens', () => {
    it('paired comes from the list the host gave; Forget goes to the host, and the row goes', () => {
        const s = memory();
        let paired = [URL_A];
        const forgotten: string[] = [];
        const hosts = knownHosts(s, { hosts: () => paired, forget: (url) => { forgotten.push(url); paired = paired.filter((u) => u !== url); } });
        hosts.noteConnected(URL_A, 'studio', 2);
        hosts.noteConnected(URL_B, 'beast', 1);
        expect(hosts.list().map((h) => [h.url, h.paired])).toEqual([[URL_A, true], [URL_B, false]]);
        hosts.forget(URL_A);
        expect(forgotten).toEqual([URL_A]);
        expect(hosts.list().map((h) => h.url)).toEqual([URL_B]);
    });

    it('a host the keychain knows and this window has no row for is still listed', () => {
        const hosts = knownHosts(memory(), { hosts: () => [URL_A], forget: () => {} });
        expect(hosts.list()).toEqual([{ url: URL_A, name: null, lastConnectedAt: null, paired: true }]);
    });

    it('a phone with no bridge still reads its own storage', () => {
        const s = memory();
        rememberedTokens(s).remember(URL_A, 'tok_a');
        expect(knownHosts(s).list()[0]?.paired).toBe(true);
    });
});

describe('what a desktop window says when it connects', () => {
    it('a typed PIN wins, and is sent as typed', () => {
        expect(deviceAuth(' 123456 ', 'desk', [URL_A], URL_A)).toEqual<AuthRequest>({ kind: 'pin', code: '123456', label: 'desk' });
    });

    it('a paired host with no PIN asks for the saved hello, with no token in it', () => {
        const auth = deviceAuth('', 'desk', [URL_A], URL_A);
        expect(auth).toEqual<AuthRequest>({ kind: 'saved', label: 'desk' });
        expect(JSON.stringify(auth)).not.toContain('token');
    });

    it('an unpaired host with no PIN has nothing to say', () => {
        expect(deviceAuth('', 'desk', [URL_B], URL_A)).toBeNull();
    });
});

describe('genie-host dials another machine for any role (Tynn #423), and only a machine', () => {
    const open = () => {
        const calls: string[] = [];
        const link = { open: async (_owner: string, url: string) => { calls.push(url); return { ok: true as const, channel: 'c' }; }, openRelay: async () => ({ ok: false as const, reason: 'none' }), send: () => {}, close: () => {}, dropOwner: () => {}, browserVia: async () => ({ ok: false as const, reason: 'none' }) };
        return { calls, protocol: deviceLinkProtocol({ link, openBrowser: async () => null, remoteVia: () => {} } as DeviceLinkProtocolPorts) };
    };

    it('a socket to another machine is opened by the host; nothing about this machine is asked first', async () => {
        const o = open();
        expect(await o.protocol.call('window-1', 'open', [URL_A])).toEqual({ ok: true, channel: 'c' });
        expect(o.calls).toEqual([URL_A]);
    });

    it('a Tynn workstation or a web address is not a device link', async () => {
        const o = open();
        for (const url of ['relay:abc', 'https://evil.example/', 7]) expect(((await o.protocol.call('window-1', 'open', [url])) as { ok: boolean }).ok).toBe(false);
        expect(o.calls).toEqual([]);
    });
});

describe('source guards: the desktop path', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8');
    const desktop = app.slice(app.indexOf('function useRemote('), app.indexOf('function useMobileRemote('));
    const preload = readFileSync('src/main/preload.ts', 'utf8');

    it('the slice is the hook', () => { expect(desktop).toContain('connectWith'); });

    it('the desktop hook keeps no token: it reads none, stores none, and does not dial a socket', () => {
        expect(desktop).not.toMatch(/\.tokenFor\(/);
        expect(desktop).not.toMatch(/\.remember\(/);
        expect(desktop).not.toMatch(/rememberedTokens\(/);
        expect(desktop).not.toMatch(/webSocketTransport\(/);
        expect(desktop).not.toMatch(/kind: 'token'/);
    });

    it('a connection that drops after it was up says the host\'s words, not nothing', () => {
        expect(desktop).toMatch(/transport\.onClose\(\(\) => \{ const why = transport\.closedBecause\(\);/);
    });

    it('a phone still keeps its origin storage', () => {
        const phone = app.slice(app.indexOf('function useMobileRemote('));
        expect(phone).toContain('rememberedTokens(window.localStorage)');
    });

    it('the bridge offers no way to read a token', () => {
        const device = preload.slice(preload.indexOf('deviceLink:'), preload.indexOf('}', preload.indexOf('deviceLink:')));
        const remote = readFileSync('src/renderer/remote-bridge.ts', 'utf8');
        const owner = remote.slice(remote.indexOf('const localOwner:'), remote.indexOf('const bridge:', remote.indexOf('const localOwner:')));
        expect(owner).toContain("'deviceLink.adopt'");
        expect(device).not.toMatch(/tokenFor|\bread\b|\bget\b/);
        expect(owner).not.toMatch(/tokenFor|\bgetToken\b/);
    });
});

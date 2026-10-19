import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { knownHosts, rememberedTokens, remoteFromSearch, remoteWindowSearch, type TokenStorage } from '../src/renderer/remote-session.js';
import { ConnectRemote } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * KNOWN HOSTS, AND A WINDOW PER REMOTE HOST (the owner, 2026-10-19: "in this release we also need to get the Device
 * pairing and Remote connection features that Genie 1 had. I need to be able to connect to remote genie hosts and drive
 * agents on those machines"; Tynn #819, first in the approved order). Genie 1 listed the hosts you had connected to
 * (`remote.known`), opened each IN ITS OWN WINDOW (`remote.open`) so the local Genie stayed open, and offered Reconnect
 * and Forget. Genie 2 remembered a token per host and switched THIS window to it.
 */
function memory(): TokenStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

describe('knownHosts — the hosts this device has connected to', () => {
    it('newest first, each with its name, when it was last connected, and whether this device is paired (holds a token)', () => {
        const s = memory();
        rememberedTokens(s).remember('wss://studio:7421/genie', 'tok_a');
        rememberedTokens(s).remember('wss://beast:7421/genie', 'tok_b');
        const hosts = knownHosts(s);
        hosts.noteConnected('wss://studio:7421/genie', 'studio', 1_000);
        hosts.noteConnected('wss://beast:7421/genie', 'beast', 5_000);
        expect(hosts.list()).toEqual([
            { url: 'wss://beast:7421/genie', name: 'beast', lastConnectedAt: 5_000, paired: true },
            { url: 'wss://studio:7421/genie', name: 'studio', lastConnectedAt: 1_000, paired: true },
        ]);
    });

    it('a host remembered before names were kept is still listed — by its address, never dropped', () => {
        const s = memory();
        rememberedTokens(s).remember('wss://old:7421/genie', 'tok');
        expect(knownHosts(s).list()).toEqual([{ url: 'wss://old:7421/genie', name: null, lastConnectedAt: null, paired: true }]);
    });

    it('Forget removes the host AND its token — the next connection needs the PIN again', () => {
        const s = memory();
        rememberedTokens(s).remember('wss://studio:7421/genie', 'tok');
        knownHosts(s).noteConnected('wss://studio:7421/genie', 'studio', 1);
        knownHosts(s).forget('wss://studio:7421/genie');
        expect(knownHosts(s).list()).toEqual([]);
        expect(rememberedTokens(s).tokenFor('wss://studio:7421/genie')).toBeNull();
    });
});

describe('the remote window’s address — the host it is bound to', () => {
    it('round-trips a host’s socket URL through the window’s query', () => {
        const search = remoteWindowSearch('wss://studio:7421/genie');
        expect(remoteFromSearch(search)).toBe('wss://studio:7421/genie');
    });

    it('anything but ws:// or wss:// is not a host (no window binds to it)', () => {
        expect(remoteFromSearch('?remote=https%3A%2F%2Fevil.example')).toBeNull();
        expect(remoteFromSearch('?remote=javascript%3Aalert(1)')).toBeNull();
        expect(remoteFromSearch('')).toBeNull();
    });
});

describe('the Network page — known hosts, Open, Forget, Reconnect', () => {
    const known = [
        { url: 'wss://beast:7421/genie', name: 'beast', lastConnectedAt: 1_000, paired: true },
        { url: 'wss://old:7421/genie', name: null, lastConnectedAt: null, paired: true },
    ];
    const render = (extra: Record<string, unknown> = {}) =>
        renderToStaticMarkup(<ConnectRemote state={null} remembered={[]} onConnect={() => {}} onDisconnect={() => {}} known={known} onOpenHost={() => {}} onForgetHost={() => {}} now={61_000} {...extra} />);

    it('a row per known host (COUNTED), named — the address when it has no name — with when it was last connected', () => {
        const html = render();
        expect((html.match(/data-known-host="/g) ?? []).length).toBe(2);
        expect(html).toMatch(/data-known-host="wss:\/\/beast:7421\/genie"[\s\S]*?beast[\s\S]*?1m ago/);
        expect(html).toMatch(/data-known-host="wss:\/\/old:7421\/genie"[\s\S]*?old:7421/);
    });

    it('each row opens the host in its own window, and can be forgotten', () => {
        const html = render();
        expect((html.match(/data-action="open-host"/g) ?? []).length).toBe(2);
        expect((html.match(/data-action="forget-host"/g) ?? []).length).toBe(2);
    });

    it('CONTROL: no known hosts — no list, the connect form alone', () => {
        const html = render({ known: [] });
        expect(html).not.toContain('data-known-host=');
        expect(html).toContain('data-form="connect-remote"');
    });

    it('a window whose link to its host dropped offers Reconnect to that host', () => {
        const dropped = { connected: false, host: 'studio', isOwner: true, workspaceId: null, driving: false, driver: null, locked: false, lastRefusal: 'the connection closed', token: null };
        const html = render({ state: dropped, onReconnect: () => {} });
        expect(html).toMatch(/data-action="reconnect"[^>]*>Reconnect to studio</);
    });
});

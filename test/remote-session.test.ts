import { describe, expect, it } from 'vitest';
import { remoteUrl, rememberedTokens } from '../src/renderer/remote-session.js';

/**
 * CONNECTING TO ANOTHER MACHINE — the client-local half (§6.8's three-way split: the device's own
 * memory of where it has paired is a DEVICE preference). A host typed as `name:port` becomes the
 * host's socket URL; a token minted by a PIN pairing is remembered per host in the device's own
 * storage so the next connection needs no PIN; forgetting a host drops it. Nothing here touches
 * the host.
 */

describe('remoteUrl', () => {
    it('turns what a person types into the host’s socket URL, keeps an explicit ws(s) URL, and refuses nothing-at-all', () => {
        expect(remoteUrl('alphar.tailnet.invalid:7421')).toEqual({ ok: true, url: 'wss://alphar.tailnet.invalid:7421/genie' });
        expect(remoteUrl('  studio:7421 ')).toEqual({ ok: true, url: 'wss://studio:7421/genie' });
        expect(remoteUrl('ws://127.0.0.1:7421/genie')).toEqual({ ok: true, url: 'ws://127.0.0.1:7421/genie' });
        expect(remoteUrl('wss://studio:7421/genie')).toEqual({ ok: true, url: 'wss://studio:7421/genie' });
        expect(remoteUrl('')).toEqual({ ok: false, reason: 'name the host — its name or address, with the port Genie shows under Remote access' });
        expect(remoteUrl('http://studio:7421')).toEqual({ ok: false, reason: 'a Genie host is reached over ws:// or wss://, not http://' });
    });
});

describe('rememberedTokens', () => {
    it('remembers one token per host URL in the device’s own storage, under one key, and forgets on request', () => {
        const store = new Map<string, string>();
        const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
        const tokens = rememberedTokens(storage);
        expect(tokens.tokenFor('wss://studio:7421/genie')).toBeNull();
        tokens.remember('wss://studio:7421/genie', 'tok1');
        tokens.remember('wss://alphar:7421/genie', 'tok2');
        expect(tokens.tokenFor('wss://studio:7421/genie')).toBe('tok1');
        expect(tokens.hosts()).toEqual(['wss://studio:7421/genie', 'wss://alphar:7421/genie']);
        expect([...store.keys()]).toEqual(['genie.remote.tokens']);
        tokens.forget('wss://studio:7421/genie');
        expect(tokens.tokenFor('wss://studio:7421/genie')).toBeNull();
        expect(tokens.hosts()).toEqual(['wss://alphar:7421/genie']);
        // Corrupt storage reads as nothing remembered, never a throw on boot.
        store.set('genie.remote.tokens', '{not json');
        expect(rememberedTokens(storage).hosts()).toEqual([]);
    });
});

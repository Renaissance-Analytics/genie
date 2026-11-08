import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DeviceLinkReplica } from '../src/main/device-link-replica.js';
import { DeviceLinkService, type DeviceLinkEvent, type RelayMemberPorts } from '../src/main/device-link-service.js';
import { genieCatalog, RELAY_MEMBER_ELEMENT } from '../src/main/genie-catalog.js';
import type { RelayMemberTransport } from '../src/main/relay-member.js';
import { PopKeypair } from '../src/main/relay-member.js';
import { RemoteBrowsers } from '../src/main/remote-browsers.js';

/*
 * A PILOT'S CONNECTION TO ANOTHER WORKSTATION IS GENIE-HOST'S (Tynn #552, host split P5d.4; audit M-e: "the host dials, the
 * window gets a channel handle, never the token"). genie-host mints the Tynn grant with its own account, holds the proof
 * key, opens the relay member and renews its grant; the window speaks the remote protocol on a CHANNEL, and gets that
 * workstation's `.gen` sites through a door genie-host opens. No grant, no key, ever crosses to the window.
 */

const GRANT = 'GRANT-SECRET-eyJhbGciOi';

function fakeTransport() {
    const messages = new Set<(t: string) => void>();
    const closes = new Set<() => void>();
    const sent: string[] = [];
    let because: string | null = null;
    const t = {
        send: (text: string) => { sent.push(text); },
        onMessage: (l: (t: string) => void) => { messages.add(l); return () => messages.delete(l); },
        onClose: (l: () => void) => { closes.add(l); return () => closes.delete(l); },
        close: () => { for (const l of [...closes]) l(); },
        closedBecause: () => because,
        openSite: async (host: string) => ({ ok: true as const, stream: null as never, ca: `CA-for-${host}` }),
    };
    return { transport: t as unknown as RelayMemberTransport, sent, hear: (text: string) => { for (const l of [...messages]) l(text); }, drop: (reason: string) => { because = reason; for (const l of [...closes]) l(); } };
}

function rig(over: Partial<RelayMemberPorts> = {}) {
    const events: Array<{ owner: string; event: DeviceLinkEvent }> = [];
    const minted: Array<{ workstationId: string; jwk: unknown }> = [];
    const opened: Array<{ relayUrl: string; workstationId: string; grant: string; renew?: () => Promise<unknown> }> = [];
    const t = fakeTransport();
    const relay: RelayMemberPorts = {
        signedIn: () => true,
        keypair: () => PopKeypair.generate(),
        mint: async (workstationId, jwk) => { minted.push({ workstationId, jwk }); return { ok: true, token: GRANT, relayEndpoint: 'wss://relay.tynn.test' }; },
        open: async (input) => { opened.push(input); return { ok: true, transport: t.transport }; },
        ...over,
    };
    const browsers = new RemoteBrowsers(async () => ({ port: 47001, close: () => {} }));
    const service = new DeviceLinkService({ tokens: { hosts: async () => [], forget: async () => ({ ok: true }), remember: async () => ({ ok: true }), lookup: async () => null } as never, socket: () => { throw new Error('no device sockets here'); }, send: (owner, event) => events.push({ owner, event }), log: () => {}, relay, browsers });
    return { service, events, minted, opened, t };
}

describe('the relay member, in genie-host', () => {
    it('mints the grant for its own key, opens the member, says the step, and hands the window a channel', async () => {
        const r = rig();
        const result = await r.service.call('window-1', 'openRelay', ['ws_alpha']) as { ok: boolean; channel?: string };
        expect(result).toMatchObject({ ok: true, channel: expect.stringMatching(/^relay_/) });
        expect(r.minted.map((m) => m.workstationId)).toEqual(['ws_alpha']);
        expect(r.opened).toMatchObject([{ relayUrl: 'wss://relay.tynn.test', workstationId: 'ws_alpha', grant: GRANT }]);
        expect(r.events.filter((e) => e.event.type === 'step')).toEqual([{ owner: 'window-1', event: { type: 'step', workstationId: 'ws_alpha', step: 'relay' } }]);
        // Frames both ways, on the channel; the window that opened it alone may use it.
        r.t.hear('{"kind":"welcome"}');
        expect(r.events.at(-1)).toEqual({ owner: 'window-1', event: { type: 'frame', channel: result.channel, text: '{"kind":"welcome"}' } });
        await r.service.call('window-2', 'send', [result.channel, 'not yours']);
        await r.service.call('window-1', 'send', [result.channel, '{"kind":"call"}']);
        expect(r.t.sent).toEqual(['{"kind":"call"}']);
        r.t.drop('the relay closed the session');
        expect(r.events.at(-1)).toEqual({ owner: 'window-1', event: { type: 'closed', channel: result.channel, reason: 'the relay closed the session' } });
    });

    it('the grant and the key never reach the window: not in an answer, not in an event (control: the relay got the grant)', async () => {
        const r = rig();
        const result = await r.service.call('window-1', 'openRelay', ['ws_alpha']);
        r.t.hear('{"kind":"welcome"}');
        const via = await r.service.call('window-1', 'browserVia', [(result as { channel: string }).channel]);
        const toWindow = JSON.stringify([result, via, r.events.map((e) => e.event)]);
        expect(r.opened[0]?.grant).toBe(GRANT);
        expect(toWindow).not.toContain(GRANT);
        expect(toWindow).not.toMatch(/"d"\s*:/); // no private JWK member
        expect(toWindow).not.toContain('relayEndpoint');
    });

    it('a renewal mints for the SAME key; the key generated once', async () => {
        let keys = 0;
        const r = rig({ keypair: () => { keys += 1; return PopKeypair.generate(); } });
        await r.service.call('window-1', 'openRelay', ['ws_alpha']);
        await r.opened[0]!.renew!();
        expect(keys).toBe(1);
        expect(r.minted).toHaveLength(2);
        expect(r.minted[1]!.jwk).toEqual(r.minted[0]!.jwk);
    });

    it('says where it failed: signed out, Tynn\'s refusal (for the window to word), the relay', async () => {
        expect(await rig({ signedIn: () => false }).service.call('w', 'openRelay', ['ws_alpha'])).toEqual({ ok: false, reason: 'sign in to Tynn to connect to a Tynn workstation' });
        const refused = { ok: false as const, reason: 'not your workstation', refusedByTynn: true as const };
        const noWayIn = rig({ mint: async () => refused });
        expect(await noWayIn.service.call('w', 'openRelay', ['ws_alpha'])).toEqual({ ok: false, stage: 'tynn', refusal: refused });
        // The step is said only once Tynn gave the way in, and the relay is not dialled without it.
        expect(noWayIn.events.filter((e) => e.event.type === 'step')).toEqual([]);
        expect(noWayIn.opened).toEqual([]);
        expect(await rig({ open: async () => ({ ok: false, reason: 'the relay did not answer' }) }).service.call('w', 'openRelay', ['ws_alpha'])).toEqual({ ok: false, stage: 'relay', reason: 'the relay did not answer' });
        expect(await rig().service.call('w', 'openRelay', [''])).toMatchObject({ ok: false });
    });

    it('the browser\'s door to that workstation\'s sites is genie-host\'s: its port, and its CA once a site answered, said to the window', async () => {
        const r = rig();
        const { channel } = await r.service.call('window-1', 'openRelay', ['ws_alpha']) as { channel: string };
        expect(await r.service.call('window-1', 'browserVia', [channel])).toEqual({ ok: true, port: 47001, ca: null });
        expect(await r.service.call('window-2', 'browserVia', [channel])).toMatchObject({ ok: false });
    });

    it('the window that opened it leaving ends its relay connections, and only its own', async () => {
        const r = rig();
        const { channel } = await r.service.call('window-1', 'openRelay', ['ws_alpha']) as { channel: string };
        r.service.dropOwner('window-2');
        await r.service.call('window-1', 'send', [channel, 'still here']);
        expect(r.t.sent).toEqual(['still here']);
        r.service.dropOwner('window-1');
        expect(r.events.at(-1)).toMatchObject({ owner: 'window-1', event: { type: 'closed', channel } });
    });
});

describe('the window\'s replica', () => {
    it('opens a relay channel through the host, hears its step, keeps the door\'s port and CA as the host says, and ends it on a lost link', async () => {
        const calls: Array<[string, readonly unknown[]]> = [];
        const replica = new DeviceLinkReplica(async (method, args) => {
            calls.push([method, args]);
            if (method === 'openRelay') { replica.deliver({ type: 'step', workstationId: 'ws_alpha', step: 'relay' }); return { ok: true, channel: 'relay_1' }; }
            if (method === 'browserVia') return { ok: true, port: 47001, ca: null };
            return true;
        });
        const steps: string[] = [];
        replica.onStep((workstationId, step) => steps.push(`${workstationId} ${step}`));
        expect(await replica.openRelay('ws_alpha')).toEqual({ ok: true, channel: 'relay_1' });
        expect(steps).toEqual(['ws_alpha relay']);
        const via = await replica.browserVia('relay_1');
        expect(via && [via.port(), via.ca()]).toEqual([47001, null]);
        replica.deliver({ type: 'via', channel: 'relay_1', port: 47002, ca: 'PEM' });
        expect(via && [via.port(), via.ca()]).toEqual([47002, 'PEM']);
        const closed: string[] = [];
        replica.onClosed((channel) => closed.push(channel));
        replica.lost('the host went');
        expect(closed).toEqual(['relay_1']);
    });
});

describe('genie.relay-member in the catalog', () => {
    it('is a host-service on both sides, linked by the engine link\'s device-link call and event', () => {
        expect(genieCatalog().list('host-service').find((d) => d.id === 'genie.relay-member')).toMatchObject({
            reach: { side: 'both', requiresWindow: false, remote: 'local', link: { calls: ['engine.deviceLink'], events: ['device.event'] } },
            payload: { start: 'deviceLink.openRelay', stop: 'deviceLink.close', health: 'deviceLink.relayHealth', settingsSection: 'workstation' },
        });
        expect(RELAY_MEMBER_ELEMENT.id).toBe('genie.relay-member');
    });

    it('its health handler is answered by the host side: the relay channels open, and whether Tynn is signed in', async () => {
        const r = rig();
        expect(await r.service.call('window-1', 'relayHealth', [])).toEqual({ signedIn: true, open: 0 });
        await r.service.call('window-1', 'openRelay', ['ws_alpha']);
        expect(await r.service.call('window-1', 'relayHealth', [])).toEqual({ signedIn: true, open: 1 });
    });
});

describe('with genie-host linked, the window mints no grant and opens no relay member (source guard)', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    it('genie:relay-open asks genie-host when linked, and the browser asks genie-host for the door', () => {
        expect(main).toMatch(/const opened = await link\.openRelay\(workstationId\)/);
        expect(main).toMatch(/await link\.browserVia\(/);
    });
});

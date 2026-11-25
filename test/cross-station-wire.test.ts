import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { DefiniteRefusal } from '../src/core/cross-station.js';
import { inMemoryPair, parseMessage, type ServerConnection, type WireMessage } from '../src/core/remote-protocol.js';
import { StationRefused } from '../src/main/cross-station-host.js';
import { stationLinkOver } from '../src/main/cross-station-link.js';
import { principalOf, verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * MAIL BETWEEN WORKSTATIONS ON THE WIRE (P9): `xstation.roster`, `xstation.deliver` and `xstation.read`, said by one host to
 * another over the relay. The receiving host takes them ONLY from its owner's own workstation: the Tynn grant says the
 * caller is the owner (`src = owner`, the account signed in here) and WHICH of the owner's workstations it is (`src_ws`, from
 * Tynn's device binding). The sender's station is that, never anything the caller says. Not on the baton: mail does not
 * take control of the host from the person driving it.
 */

const A = '01m88dzykbnbx4kwj2ptpje92z';
const settled = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((r) => setImmediate(r)); };

let dir: string;
let devices: DeviceStore;
let accept: (c: ServerConnection) => void;
let host: RemoteHost;
let handled: Array<{ method: string; arg: unknown; station: string }>;
let onEvent: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-xstation-wire-'));
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'x' });
    handled = [];
    onEvent = vi.fn(() => () => {});
    const api: HostApi = { invoke: vi.fn(async () => ({ ok: true })) as unknown as HostApi['invoke'], onEvent: onEvent as unknown as HostApi['onEvent'], workspaceOfAgent: () => 'ws' };
    host = new RemoteHost({ api, hostName: 'laptop', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (l) => { accept = l; return () => {}; } } });
    host.setCrossStation({
        handle: async (method, arg, from) => {
            handled.push({ method, arg, station: from.station });
            if ((arg as { to?: string } | null)?.to === 'ghost@p8x') throw new Error('nobody at ghost@p8x on laptop');
            return { messageId: 'msg_there' };
        },
    });
});
afterEach(async () => { await devices.flushed(); await rm(dir, { recursive: true, force: true }); });

async function relay(preAuth: object, capabilities?: readonly string[]) {
    const pair = inMemoryPair();
    const heard: WireMessage[] = [];
    pair.client.onMessage((t) => { const r = parseMessage(t); if (r.ok) heard.push(r.message); });
    accept({ ...pair.server, preAuth } as ServerConnection);
    pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' }, ...(capabilities ? { capabilities } : {}) }));
    await vi.waitFor(() => expect(heard.some((m) => m.kind === 'welcome')).toBe(true));
    let id = 0;
    return {
        call: async (method: string, ...args: unknown[]) => {
            const mine = ++id;
            pair.client.send(JSON.stringify({ kind: 'call', id: mine, method, args }));
            await vi.waitFor(() => expect(heard.some((m) => m.kind === 'result' && m.id === mine)).toBe(true));
            return heard.find((m) => m.kind === 'result' && m.id === mine) as Extract<WireMessage, { kind: 'result' }>;
        },
    };
}

const OWNER_FROM_A = { kind: 'relay', label: 'desk', isOwner: true, workspaceId: null, readonly: false, station: A };
const deliver = { id: 'msg_1', from: { name: 'atlas', workspace: 'p8x' }, to: 'bolt@p8x', text: 'hi', sentAt: '2026-11-25T12:00:00.000Z' };

describe('the receiving host admits mail only from its owner’s own workstations', () => {
    it('the owner from A: the call reaches the inbox with station A, from the grant', async () => {
        const c = await relay(OWNER_FROM_A);
        const r = await c.call('xstation.deliver', deliver);
        expect(r).toMatchObject({ ok: true, value: { messageId: 'msg_there' } });
        expect(handled).toEqual([{ method: 'xstation.deliver', arg: deliver, station: A }]);
    });

    it('a refusal there is said back in its words', async () => {
        const c = await relay(OWNER_FROM_A);
        expect(await c.call('xstation.deliver', { ...deliver, to: 'ghost@p8x' })).toMatchObject({ ok: false, reason: 'nobody at ghost@p8x on laptop' });
    });

    it('a guest (even of the whole host), a read-only owner, and an owner whose grant names no workstation are refused; nothing reaches the inbox', async () => {
        for (const preAuth of [
            { ...OWNER_FROM_A, isOwner: false },
            { ...OWNER_FROM_A, readonly: true },
            { kind: 'relay', label: 'desk', isOwner: true, workspaceId: null, readonly: false },
        ]) {
            const c = await relay(preAuth);
            for (const method of ['xstation.roster', 'xstation.deliver', 'xstation.read']) expect(await c.call(method, deliver)).toMatchObject({ ok: false });
        }
        expect(handled).toEqual([]);
    });

    it('not on the baton: while another window drives, mail is still taken', async () => {
        const driver = await relay({ kind: 'relay', label: 'phone', isOwner: true, workspaceId: null, readonly: false });
        expect(await driver.call('baton.take')).toMatchObject({ ok: true });
        const c = await relay(OWNER_FROM_A);
        expect(await c.call('xstation.deliver', deliver)).toMatchObject({ ok: true });
    });
});

describe('the station is Tynn’s word, from the signed grant', () => {
    const key = generateKeyPairSync('ed25519');
    const jwk = { ...(key.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 't1' } as TynnJwk;
    const grant = (claims: Record<string, unknown>) => {
        const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
        const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 't1' });
        const body = b64({ aud: 'ws_target', exp: Math.floor(Date.now() / 1000) + 300, jti: 'g', sub: 'u1', cap: 'control', scope: ['host:all'], aud_role: 'pilot', ...claims });
        const checked = verifyMemberGrant(`${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')}`, { keys: [jwk], workstationId: 'ws_target' });
        if (!checked.ok) throw new Error(checked.reason);
        return checked.grant;
    };

    it('the owner from one of their machines carries that machine as its station', () => {
        expect(principalOf(grant({ src: 'owner', src_ws: A }), 'u1')).toMatchObject({ ok: true, principal: { isOwner: true, station: A } });
    });
    it('a guest never does, even with src_ws; an owner grant with no src_ws has none', () => {
        const guest = principalOf(grant({ src: 'share', share_origin: 'link', src_ws: A }), 'u1');
        expect(guest.ok && 'station' in guest.principal).toBe(false);
        const bare = principalOf(grant({ src: 'owner' }), 'u1');
        expect(bare.ok && 'station' in bare.principal).toBe(false);
        // Tynn's "owner" for another account is a guest here (Tynn #757): no station.
        const foreign = principalOf(grant({ src: 'owner', src_ws: A, sub: 'u2' }), 'u1');
        expect(foreign.ok && 'station' in foreign.principal).toBe(false);
    });
});

describe('the sending host’s link speaks the protocol to the receiving host', () => {
    it('hello as relay, welcome as owner, then calls; a refusal is a StationRefused, distinct from a dropped link', async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: OWNER_FROM_A } as ServerConnection);
        const link = await stationLinkOver(pair.client, { label: 'desk', timeoutMs: 5_000 });
        await expect(link.call('xstation.deliver', deliver)).resolves.toEqual({ messageId: 'msg_there' });
        await expect(link.call('xstation.deliver', { ...deliver, to: 'ghost@p8x' })).rejects.toBeInstanceOf(StationRefused);
        link.close();
        await settled();
        await expect(link.call('xstation.deliver', deliver)).rejects.not.toBeInstanceOf(StationRefused);
    });

    it('a host that does not admit it as the owner is not a link: nothing is called', async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: { ...OWNER_FROM_A, isOwner: false } } as ServerConnection);
        await expect(stationLinkOver(pair.client, { label: 'desk', timeoutMs: 2_000 })).rejects.toThrow(/not as its owner/);
        expect(handled).toEqual([]);
    });
});

const relayWithCaps = (preAuth: object, capabilities: readonly string[]) => relay(preAuth, capabilities);

/*
 * THE REVIEW OF #2180 (an independent review at 43e90be7), on the wire. Finding 1: a sender settles a message only on a
 * DEFINITE answer (nobody at that address, the scope, an unsupported method); a booting host, a disk error, anything else
 * keeps it queued. Finding 6: a station link is not a person's connection. Finding 7: a station link that is not the owner
 * raises no "Allow guest?" card. The nit: a locked host takes no mail.
 */
describe('finding 1: only a definite refusal settles, on the wire', () => {
    it('nobody at that address: said with its code, and the sender’s link reads it as a StationRefused', async () => {
        host.setCrossStation({ handle: async () => { throw new DefiniteRefusal('no-address', 'nobody at ghost@p8x on laptop'); } });
        const c = await relay(OWNER_FROM_A);
        expect(await c.call('xstation.deliver', deliver)).toMatchObject({ ok: false, code: 'no-address' });
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: OWNER_FROM_A } as ServerConnection);
        const link = await stationLinkOver(pair.client, { label: 'desk', timeoutMs: 5_000 });
        await expect(link.call('xstation.deliver', deliver)).rejects.toBeInstanceOf(StationRefused);
        link.close();
    });

    it('the scope: said with its code, a StationRefused too', async () => {
        host.setCrossStation({ handle: async () => { throw new DefiniteRefusal('scope', 'bolt@p8x is not reachable from atlas'); } });
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: OWNER_FROM_A } as ServerConnection);
        const link = await stationLinkOver(pair.client, { label: 'desk', timeoutMs: 5_000 });
        await expect(link.call('xstation.deliver', deliver)).rejects.toBeInstanceOf(StationRefused);
        link.close();
    });

    it('a disk error there is NOT definite: no code, and the link’s error is one worth a retry', async () => {
        host.setCrossStation({ handle: async () => { throw new Error('ENOSPC: no space left on device, write'); } });
        const c = await relay(OWNER_FROM_A);
        const r = await c.call('xstation.deliver', deliver);
        expect(r).toMatchObject({ ok: false });
        expect('code' in r).toBe(false);
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: OWNER_FROM_A } as ServerConnection);
        const link = await stationLinkOver(pair.client, { label: 'desk', timeoutMs: 5_000 });
        const failed = await link.call('xstation.deliver', deliver).catch((e: unknown) => e);
        expect(failed).toBeInstanceOf(Error);
        expect(failed).not.toBeInstanceOf(StationRefused);
        link.close();
    });

    it('a host still booting (no cross-station port yet) is NOT definite either', async () => {
        host.setCrossStation(null);
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: OWNER_FROM_A } as ServerConnection);
        const link = await stationLinkOver(pair.client, { label: 'desk', timeoutMs: 5_000 });
        const failed = await link.call('xstation.deliver', deliver).catch((e: unknown) => e);
        expect(failed).toBeInstanceOf(Error);
        expect(failed).not.toBeInstanceOf(StationRefused);
        link.close();
    });

    it('a host built with its cross-station port takes mail from its first connection (no window between start and set)', async () => {
        const seen: string[] = [];
        let first: ((c: ServerConnection) => void) | null = null;
        const api: HostApi = { invoke: vi.fn(async () => ({ ok: true })) as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
        new RemoteHost({ api, hostName: 'laptop', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
            transport: { onConnection: (l) => { first = l; return () => {}; } },
            crossStation: { handle: async (method) => { seen.push(method); return { agents: [] }; } } });
        const pair = inMemoryPair();
        first!({ ...pair.server, preAuth: OWNER_FROM_A } as ServerConnection);
        const link = await stationLinkOver(pair.client, { label: 'desk', timeoutMs: 5_000 });
        await expect(link.call('xstation.roster', {})).resolves.toEqual({ agents: [] });
        expect(seen).toEqual(['xstation.roster']);
        link.close();
    });
});

describe('finding 6: a station link is not a person’s connection', () => {
    it('it is not listed among the connections, hears no host events, and may make no other call; a window is listed (control)', async () => {
        const pair = inMemoryPair();
        accept({ ...pair.server, preAuth: OWNER_FROM_A } as ServerConnection);
        const link = await stationLinkOver(pair.client, { label: 'desk', timeoutMs: 5_000 });
        await link.call('xstation.roster', {});
        expect(host.connections()).toEqual([]);
        expect(onEvent).not.toHaveBeenCalled();
        const raw = await relayWithCaps(OWNER_FROM_A, ['cross-station@1']);
        expect(await raw.call('baton.take')).toMatchObject({ ok: false });
        await relay({ kind: 'relay', label: 'phone', isOwner: true, workspaceId: null, readonly: false });
        expect(host.connections().map((c) => c.label)).toEqual(['phone']);
        link.close();
    });
});

describe('finding 7: a station link that is not the owner raises no "Allow guest?" card', () => {
    it('refused at once, in words, and the card is never asked; a guest window still is (control)', async () => {
        const asked: string[] = [];
        const confirm = { ask: (input: { label: string }) => { asked.push(input.label); return { id: 'p1', expiresAt: Number.MAX_SAFE_INTEGER, answer: new Promise<never>(() => {}) }; }, cancel: () => {} };
        let enter: ((c: ServerConnection) => void) | null = null;
        const api: HostApi = { invoke: vi.fn(async () => ({ ok: true })) as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
        new RemoteHost({ api, hostName: 'laptop', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm, transport: { onConnection: (l) => { enter = l; return () => {}; } } });
        const pair = inMemoryPair();
        enter!({ ...pair.server, preAuth: { ...OWNER_FROM_A, isOwner: false, label: 'desk' } } as ServerConnection);
        await expect(stationLinkOver(pair.client, { label: 'desk', timeoutMs: 2_000 })).rejects.toThrow(/not as its owner/);
        expect(asked).toEqual([]);
        const guest = inMemoryPair();
        enter!({ ...guest.server, preAuth: { ...OWNER_FROM_A, isOwner: false, label: 'a guest' } } as ServerConnection);
        guest.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' } }));
        await vi.waitFor(() => expect(asked).toEqual(['a guest']));
    });
});

describe('nit: a locked host takes no mail between workstations', () => {
    it('deliver and read are refused while locked, and not definite; nothing reaches the inbox; unlocked, it is taken', async () => {
        host.lock();
        const c = await relay(OWNER_FROM_A);
        const r = await c.call('xstation.deliver', deliver);
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/locked/) });
        expect('code' in r).toBe(false);
        expect(await c.call('xstation.read', { reads: [] })).toMatchObject({ ok: false });
        expect(handled).toEqual([]);
        host.unlock();
        expect(await c.call('xstation.deliver', deliver)).toMatchObject({ ok: true });
    });
});

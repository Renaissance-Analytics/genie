import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
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

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-xstation-wire-'));
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => 'x' });
    handled = [];
    const api: HostApi = { invoke: vi.fn(async () => ({ ok: true })) as unknown as HostApi['invoke'], onEvent: () => () => {}, workspaceOfAgent: () => 'ws' };
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

async function relay(preAuth: object) {
    const pair = inMemoryPair();
    const heard: WireMessage[] = [];
    pair.client.onMessage((t) => { const r = parseMessage(t); if (r.ok) heard.push(r.message); });
    accept({ ...pair.server, preAuth } as ServerConnection);
    pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'relay' } }));
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

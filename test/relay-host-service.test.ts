import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import { genieCatalog, RELAY_HOST_ELEMENT } from '../src/main/genie-catalog.js';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';
import { RelayHostReplica } from '../src/main/relay-host-replica.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import type { RelayHostStatus } from '../src/main/tynn-network.js';

/*
 * THIS MACHINE ON THE TYNN RELAY, AS A HOST, IS GENIE-HOST'S (Tynn #410, host split P5d.3). Its registration with Tynn, the
 * role Tynn gives it and the relay link run with every window closed. A window reads them; it hands over Genie 1's record,
 * which only a window can open, so Tynn can settle that once.
 */

const TYNN = 'https://tynn.test';
const LEGACY = { workstationId: 'ws_genie1', privateKeyPem: 'PEM' };

function rig(over: Partial<RelayHostServicePorts> = {}, state: { signedIn?: boolean; enabled?: boolean; role?: 'pilot' | 'drone' | null } = {}) {
    const s = { signedIn: state.signedIn ?? true, enabled: state.enabled ?? true, role: state.role === undefined ? 'pilot' as const : state.role };
    const calls: string[] = [];
    const ensured: unknown[] = [];
    const starts: Array<{ host: string; workstationId: string; fingerprint: string; onStatus: (status: RelayHostStatus) => void }> = [];
    let changes = 0;
    const handle = { status: () => ({ state: 'connecting' }) as RelayHostStatus, stop: () => { calls.push('stop'); }, revalidate: async () => { calls.push('revalidate'); } };
    const ports: RelayHostServicePorts = {
        account: () => ({ host: () => TYNN, status: () => ({ signedIn: s.signedIn }), request: async () => ({ ok: true, status: 200, json: async () => ({}) }) as never }),
        workstation: {
            identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }),
            ensure: async (options) => { ensured.push(options); return { ok: true, workstationId: 'ws_me' } as never; },
            legacyDone: async () => null,
        },
        enabled: () => s.enabled,
        readRole: async () => s.role,
        start: (input) => { starts.push(input); calls.push(`start ${input.workstationId}`); return handle; },
        onChange: () => { changes += 1; },
        ...over,
    };
    return { service: new RelayHostService(ports), s, calls, ensured, starts, changes: () => changes };
}

describe('the relay host, in genie-host, with no window', () => {
    it('signed in with remote access on: registers, reads its role, and starts the relay link on that identity', async () => {
        const r = rig();
        await r.service.register();
        expect(r.ensured).toEqual([{ host: TYNN, legacy: null }]);
        expect(r.calls).toEqual(['start ws_me']);
        expect(r.starts[0]).toMatchObject({ host: TYNN, workstationId: 'ws_me', fingerprint: 'fp' });
        expect(r.service.status()).toMatchObject({ workstation: { registered: true, host: TYNN, workstationId: 'ws_me', role: 'pilot' }, role: 'pilot' });
    });

    it('follows remote access: off, no link; on, the link; off again, stopped (control: starts once, however often applied)', async () => {
        const r = rig({}, { enabled: false });
        await r.service.register();
        expect(r.calls).toEqual([]);
        r.s.enabled = true;
        await r.service.apply();
        await r.service.apply();
        expect(r.calls).toEqual(['start ws_me']);
        r.s.enabled = false;
        await r.service.apply();
        expect(r.calls).toEqual(['start ws_me', 'stop']);
    });

    it('signed out: not registered, no link, no role; signed in with no answer from Tynn: a drone (fail closed)', async () => {
        const out = rig({}, { signedIn: false });
        await out.service.register();
        expect(out.service.status()).toMatchObject({ workstation: { registered: false, reason: 'sign in to Tynn to register this machine' }, role: null });
        expect(out.calls).toEqual([]);
        const silent = rig({}, { role: null });
        await silent.service.register();
        expect(silent.service.status().role).toBe('drone');
    });

    it('one registration at a time; a refused one is said and starts nothing', async () => {
        const r = rig();
        await Promise.all([r.service.register(), r.service.register()]);
        expect(r.ensured).toHaveLength(1);
        const refused = rig({ workstation: { identity: async () => null, legacyDone: async () => null, ensure: async () => ({ ok: false, reason: 'Tynn said no' }) as never } });
        await refused.service.register();
        expect(refused.service.status().workstation).toMatchObject({ registered: false, reason: 'Tynn said no' });
        expect(refused.calls).toEqual([]);
    });

    it('Genie 1\'s record, handed over by a window: settled once, even when it arrives during the boot\'s own registration', async () => {
        const r = rig();
        const booting = r.service.register();
        const handed = r.service.register(LEGACY);
        await Promise.all([booting, handed]);
        expect(r.ensured).toEqual([{ host: TYNN, legacy: null }, { host: TYNN, legacy: LEGACY }]);
        const settled = rig({ workstation: { identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }), legacyDone: async () => 'ws_genie1', ensure: vi.fn(async () => ({ ok: true, workstationId: 'ws_me' }) as never) } });
        await settled.service.register(LEGACY);
        expect(settled.service.status().workstation).toMatchObject({ registered: true });
    });

    it('tells its windows when anything changes, the link\'s status included; a revoke re-checks the live sessions', async () => {
        const r = rig();
        await r.service.register();
        const before = r.changes();
        r.starts[0]!.onStatus({ state: 'connected' } as RelayHostStatus);
        expect(r.changes()).toBeGreaterThan(before);
        expect(r.service.status().relay).toEqual({ state: 'connected' });
        await r.service.call('revalidate', []);
        expect(r.calls).toContain('revalidate');
    });
});

describe('the window\'s replica, over the real engine link', () => {
    async function link(local: boolean, service: RelayHostService) {
        const server = new SessionEngineServer({ token: 't', build: 'b', relayHost: service });
        const [h, raw] = memoryPair();
        server.accept(h, { local });
        const t: ClientTransport = { send: (m) => raw.send(m), onMessage: (l) => raw.onMessage(l), onClose: (l) => raw.onClose(l), close: () => raw.close() };
        const client = new SessionEngineClient({});
        expect(await client.connect(t, 't')).toMatchObject({ ok: true });
        return { client, server };
    }

    it('is driven from a local window only, before any agent engine is up (control: a local window reads it)', async () => {
        const remote = await link(false, rig().service);
        await expect(remote.client.call('engine.relayHost', ['status', []])).resolves.toEqual({ ok: false, reason: 'The relay host is driven from a local window only.' });
        const local = await link(true, rig().service);
        await expect(local.client.call('engine.relayHost', ['status', []])).resolves.toMatchObject({ ok: true });
    });

    it('reads the host\'s state, fails closed until it has, and hands over Genie 1\'s record', async () => {
        const calls: Array<[string, readonly unknown[]]> = [];
        const replica = new RelayHostReplica(async (method, args) => {
            calls.push([method, args]);
            return { workstation: { registered: true, host: TYNN, workstationId: 'ws_me', role: 'pilot' }, role: 'pilot', relay: { state: 'connected' } };
        });
        expect(replica.role()).toBe('drone');
        expect(replica.workstation()).toBeNull();
        let changed = 0;
        replica.onChange(() => { changed += 1; });
        await replica.refresh();
        expect(replica.role()).toBe('pilot');
        expect(replica.relay()).toEqual({ state: 'connected' });
        expect(changed).toBe(1);
        await replica.register(LEGACY);
        expect(calls.at(-1)).toEqual(['register', [LEGACY]]);
    });
});

describe('genie.relay-host in the catalog', () => {
    it('is a host-service on both sides, linked by engine.relayHost and its event', () => {
        expect(genieCatalog().list('host-service').find((d) => d.id === 'genie.relay-host')).toMatchObject({
            reach: { side: 'both', requiresWindow: false, remote: 'local', link: { calls: ['engine.relayHost'], events: ['relayHost.event'] } },
            payload: { start: 'relayHost.start', stop: 'relayHost.stop', health: 'relayHost.health', settingsSection: 'workstation' },
        });
        expect(RELAY_HOST_ELEMENT.id).toBe('genie.relay-host');
    });

    it('the handlers its payload names are answered by the host side', async () => {
        const r = rig({}, { enabled: true });
        await r.service.register();
        await r.service.call('stop', []);
        expect(r.calls).toEqual(['start ws_me', 'stop']);
        expect(await r.service.call('health', [])).toEqual({ registered: true, role: 'pilot', relay: 'off' });
        await r.service.call('start', []);
        expect(r.calls).toEqual(['start ws_me', 'stop', 'start ws_me']);
    });
});

describe('with genie-host linked, the window runs no relay host (source guards)', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
    it('main.ts registers, reads the role and starts the link only without genie-host; genie-host attaches to its own remote host', () => {
        expect(main).toMatch(/if \(linkedRelayHost\) \{ await linkedRelayHost\.register\(/);
        expect(main).not.toMatch(/linkedRemote\.bridge/);
        expect(host).toMatch(/attach: \(transport\) => remoteHub\.add\(transport\)/);
        expect(host).not.toMatch(/RelayBridgeHost/);
    });
});

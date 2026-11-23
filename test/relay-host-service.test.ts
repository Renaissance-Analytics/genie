import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { genieCatalog, RELAY_HOST_ELEMENT } from '../src/main/genie-catalog.js';
import { RelayHostService, type RelayHostServicePorts } from '../src/main/relay-host-service.js';
import type { RelayHostStatus } from '../src/main/tynn-network.js';
import { mayBrowse } from '../src/core/workstation-role.js';

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

    it('Genie 1’s record is kept until a registration WITH it succeeds: one that fails tries it again (the security review of #2120)', async () => {
        let fail = true;
        const ensured: unknown[] = [];
        const r = rig({ workstation: { identity: async () => ({ workstationId: 'ws_me', fingerprint: 'fp' }), legacyDone: async () => null, ensure: async (options) => { ensured.push(options); return (fail ? { ok: false, reason: 'Tynn did not answer' } : { ok: true, workstationId: 'ws_me' }) as never; } } });
        await r.service.register(LEGACY);
        fail = false;
        await r.service.register();
        await r.service.register();
        expect(ensured).toEqual([{ host: TYNN, legacy: LEGACY }, { host: TYNN, legacy: LEGACY }, { host: TYNN, legacy: null }]);
    });

    it('tells its windows when anything changes, the link\'s status included; a revoke re-checks the live sessions', async () => {
        const r = rig();
        await r.service.register();
        const before = r.changes();
        r.starts[0]!.onStatus({ state: 'connecting' } as RelayHostStatus);
        expect(r.changes()).toBeGreaterThan(before);
        expect(r.service.status().relay).toEqual({ state: 'connecting' });
        await r.service.call('revalidate', []);
        expect(r.calls).toContain('revalidate');
    });
});

describe('genie.relay-host in the catalog', () => {
    it('is a host-service on both sides; its window side follows the host summary (Tynn #961: no engine route of its own)', () => {
        expect(genieCatalog().list('host-service').find((d) => d.id === 'genie.relay-host')).toMatchObject({
            reach: { side: 'both', requiresWindow: false, remote: 'local', link: { calls: ['summary.watch'], events: ['local-summary'] } },
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
    it('genie-host registers itself, with Genie 1’s record the window hands it; genie-host attaches to its own remote host', () => {
        // The window unseals Genie 1's record and hands it over (keychain.adoptLegacy, Tynn #959 2g-3b); it registers nothing.
        expect(main).not.toMatch(/linkedRelayHost|\.relayHost\(\)/);
        expect(host).toMatch(/relayHostService\.register\(genie1Identity\)/);
        expect(main).not.toMatch(/linkedRemote\.bridge/);
        expect(host).toMatch(/attach: \(transport\) => remoteHub\.add\(transport\)/);
        expect(host).not.toMatch(/RelayBridgeHost/);
    });
});

/*
 * THE HOST PICKER WENT FROM A PILOT'S TITLE BAR (beta.61 as shipped, main 23354995). The title bar offers Connect unless
 * `features.remote.tynnWorkstation.role` says drone (Shell.tsx `mayBrowse`). That role is genie-host's workstation view, and
 * it was the FAIL-CLOSED role: `drone` until Tynn's first answer, and `drone` whenever the role read answered nothing or
 * failed. A Pilot whose read had not answered, or had failed once, lost its host picker. What the window SHOWS is what Tynn
 * said; connecting out from a machine Tynn has not called a pilot is still refused where it must be (main's device-open
 * gate and Tynn itself read the effective role).
 */
describe('the role a window shows is Tynn\'s answer; failing closed stays where it must', () => {
    it('Tynn said pilot: shown as a pilot, and it may connect out', async () => {
        const r = rig({}, { role: 'pilot' });
        await r.service.register();
        expect(r.service.status().workstation?.role).toBe('pilot');
        expect(mayBrowse(r.service.status().workstation?.role ?? null)).toBe(true);
    });

    it('the role read answered nothing: the window shows no role (the picker stays), while connecting out still fails closed', async () => {
        const r = rig({}, { role: null });
        await r.service.register();
        expect(r.service.status().workstation?.role ?? null).toBeNull();
        expect(mayBrowse(r.service.status().workstation?.role ?? null)).toBe(true);
        expect(r.service.status().role).toBe('drone');
    });

    it('the role read failed: registered all the same, no role shown, connecting out fails closed', async () => {
        const r = rig({ readRole: async () => { throw new Error('Tynn could not be reached'); } });
        await expect(r.service.register()).resolves.toBeUndefined();
        expect(r.service.status().workstation).toMatchObject({ registered: true, workstationId: 'ws_me' });
        expect(r.service.status().workstation?.role ?? null).toBeNull();
        expect(r.service.status().role).toBe('drone');
    });

    it('CONTROL: Tynn said drone: shown as a drone, and no picker', async () => {
        const r = rig({}, { role: 'drone' });
        await r.service.register();
        expect(r.service.status().workstation?.role).toBe('drone');
        expect(mayBrowse(r.service.status().workstation?.role ?? null)).toBe(false);
    });
});

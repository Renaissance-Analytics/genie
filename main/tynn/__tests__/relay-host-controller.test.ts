import { describe, expect, it, vi } from 'vitest';

import type { RelayHostDeps, RelayHostHandle, RelayHostStatus } from '../../host-core/relay-host/service';
import {
    RelayHostController,
    relayHostStatus,
    relayLocalTarget,
    setRelayHostController,
    syncRelayHost,
    type RelayHostControllerDeps,
    type RelayHostIdentity,
} from '../relay-host-controller';

/**
 * When this computer is reachable over Tynn (genie#680, genie#451).
 *
 * The Settings "Tynn" network switch used to be read by nothing, while Settings said
 * "Tynn: authenticated relay enabled" on every install. The controller makes the
 * switch mean what it says: with Genie Remote on and Tynn allowed, this machine
 * dials the relay; otherwise it does not. And its status is the one Settings shows —
 * including WHY it cannot be reached, never a claim that it can.
 */

function fakeStart() {
    const started: RelayHostDeps[] = [];
    const handles: Array<RelayHostHandle & { stopped: boolean; set(s: RelayHostStatus): void }> = [];
    const start = (deps: RelayHostDeps): RelayHostHandle => {
        started.push(deps);
        let status: RelayHostStatus = { state: 'connecting' };
        const handle = {
            stopped: false,
            status: () => status,
            stop() {
                this.stopped = true;
            },
            set(s: RelayHostStatus) {
                status = s;
                deps.onStatus?.(s);
            },
        };
        handles.push(handle);
        return handle;
    };
    return { start, started, handles };
}

const identity = (id = 'ws-desktop'): RelayHostIdentity => ({
    workstationId: id,
    fingerprint: 'fp',
    authHeader: () => 'Workstation 1:sig',
    sign: () => Buffer.from('sig'),
});

function controller(overrides: Partial<RelayHostControllerDeps> = {}) {
    const fake = fakeStart();
    const broadcast = vi.fn();
    let settings: Record<string, string> = { remote_enabled: 'on' };
    let id: RelayHostIdentity | null = identity();
    let local: string | null = 'http://127.0.0.1:51718';
    const c = new RelayHostController({
        settings: () => settings,
        identity: () => id,
        tynnApiBaseUrl: () => 'https://tynn.ai',
        localBaseUrl: () => local,
        start: fake.start,
        broadcast,
        ...overrides,
    });
    return {
        c,
        fake,
        broadcast,
        set: (s: Record<string, string>) => (settings = s),
        setIdentity: (i: RelayHostIdentity | null) => (id = i),
        setLocal: (l: string | null) => (local = l),
    };
}

describe('RelayHostController', () => {
    it('dials the relay when Genie Remote is on and Tynn is allowed (Tynn is allowed by default)', () => {
        const { c, fake } = controller();

        c.sync();

        expect(fake.started).toHaveLength(1);
        expect(fake.started[0]).toMatchObject({ workstationId: 'ws-desktop', fingerprint: 'fp', tynnApiBaseUrl: 'https://tynn.ai' });
        expect(fake.started[0].localBaseUrl()).toBe('http://127.0.0.1:51718');
        expect(c.status()).toEqual({ state: 'connecting' });
    });

    it('does not dial with Genie Remote off, and says the Tynn transport is off', () => {
        const h = controller();
        h.set({ remote_enabled: 'off' });

        h.c.sync();

        expect(h.fake.started).toEqual([]);
        expect(h.c.status()).toEqual({ state: 'off' });
    });

    it('does not dial with Tynn switched off, and stops a live link when it is switched off', () => {
        const h = controller();
        h.c.sync();
        expect(h.fake.started).toHaveLength(1);

        h.set({ remote_enabled: 'on', remote_network_tynn: 'off' });
        h.c.sync();

        expect(h.fake.handles[0].stopped).toBe(true);
        expect(h.c.status()).toEqual({ state: 'off' });
    });

    it('says it cannot be reached until this computer is registered with Tynn', () => {
        const h = controller();
        h.setIdentity(null);

        h.c.sync();

        expect(h.fake.started).toEqual([]);
        expect(h.c.status()).toMatchObject({ state: 'unavailable', reason: 'not_enrolled' });
    });

    it('says it cannot be reached while nothing is listening locally to proxy to', () => {
        const h = controller();
        h.setLocal(null);

        h.c.sync();

        expect(h.fake.started).toEqual([]);
        expect(h.c.status()).toMatchObject({ state: 'unavailable', reason: 'not_listening' });
    });

    it('reports the live link\'s own status, and broadcasts every change', () => {
        const h = controller();
        h.c.sync();

        h.fake.handles[0].set({ state: 'connected', relay: 'wss://relay.geniecloud.link' });

        expect(h.c.status()).toEqual({ state: 'connected', relay: 'wss://relay.geniecloud.link' });
        expect(h.broadcast).toHaveBeenLastCalledWith({ state: 'connected', relay: 'wss://relay.geniecloud.link' });
    });

    it('leaves a running link alone on a sync that changes nothing, and restarts it for a new identity', () => {
        const h = controller();
        h.c.sync();
        h.c.sync();
        expect(h.fake.started).toHaveLength(1);

        h.setIdentity(identity('ws-re-enrolled'));
        h.c.sync();

        expect(h.fake.handles[0].stopped).toBe(true);
        expect(h.fake.started).toHaveLength(2);
        expect(h.fake.started[1].workstationId).toBe('ws-re-enrolled');
    });

    it('stops and reports off when told to stop', () => {
        const h = controller();
        h.c.sync();

        h.c.stop();

        expect(h.fake.handles[0].stopped).toBe(true);
        expect(h.c.status()).toEqual({ state: 'off' });
    });
});

describe('relayLocalTarget', () => {
    it('is the Local listener on loopback, the only one the relay may proxy onto', () => {
        expect(
            relayLocalTarget([
                { network: 'tailscale', ip: '100.64.0.7', port: 51718, secure: true },
                { network: 'local', ip: '127.0.0.1', port: 51718, secure: false },
            ]),
        ).toBe('http://127.0.0.1:51718');
    });

    it('is null when Local is not listening, even if Tailscale is', () => {
        expect(relayLocalTarget([{ network: 'tailscale', ip: '100.64.0.7', port: 51718, secure: true }])).toBeNull();
        expect(relayLocalTarget([])).toBeNull();
    });
});

describe('the app-wide relay host', () => {
    it('reports off before one is running, then the running one\'s status, and syncs it', () => {
        setRelayHostController(null);
        expect(relayHostStatus()).toEqual({ state: 'off' });
        syncRelayHost(); // nothing running: a no-op, not a throw

        const h = controller();
        setRelayHostController(h.c);
        syncRelayHost();

        expect(h.fake.started).toHaveLength(1);
        expect(relayHostStatus()).toEqual({ state: 'connecting' });
        setRelayHostController(null);
    });
});

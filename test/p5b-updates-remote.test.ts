import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, type ServerConnection } from '../src/core/remote-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import type { UpdateState } from '../src/main/updater.js';
import { UpdatesReplica } from '../src/main/updates-replica.js';
import { connectRemote, type RemoteClient } from '../src/renderer/remote-bridge.js';
import { protocolContractDeps } from './support/protocol-contract-deps.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/**
 * P5b: with the updater in genie-host, the window's `updates` is a REPLICA of the host's. A remote or phone connection
 * still reaches it through the window's host API, under today's rules: `updates.check/download/install` are the owner's
 * alone, refused to a guest BEFORE anything reaches the host.
 */

const available = { phase: 'available', version: '2.0.1', percent: null, error: null, checkedAt: 9 } satisfies UpdateState;
let dir: string;
let devices: DeviceStore;
const clients: RemoteClient[] = [];
const closes: Array<() => void> = [];

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-p5b-remote-'));
    let seq = 0;
    devices = await DeviceStore.open(dir, { now: Date.now, random: () => `p5b-${++seq}` });
});
afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const c of closes.splice(0)) c();
    await new Promise<void>((r) => setImmediate(r));
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
});

function serve(deps: HostApiDeps) {
    const api = buildHostApi(deps);
    let accept!: (connection: ServerConnection) => void;
    const host = new RemoteHost({ api, hostName: 'p5b-host', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now }), confirm: allowEveryPairing,
        transport: { onConnection: (listener) => { accept = listener; return () => {}; } } });
    return async (kind: 'owner' | 'guest') => {
        const pair = inMemoryPair();
        closes.push(() => pair.client.close());
        const guest = kind === 'guest';
        accept(guest ? { ...pair.server, preAuth: { kind: 'relay', label: 'guest', isOwner: false, workspaceId: null, readonly: false } } : pair.server);
        const client = connectRemote(pair.client, guest ? { kind: 'relay' } : { kind: 'pin', code: host.issuePin().code }, 'p5b-phone');
        clients.push(client);
        expect(await client.ready).toEqual({ ok: true });
        return client;
    };
}

function withReplica() {
    const toHost = vi.fn(async (method: string, _args: readonly unknown[]): Promise<unknown> => (method === 'check' ? available : method === 'download' ? true : { killed: [], report: 'no agents were running. No processes were running from the install directory.' }));
    const replica = new UpdatesReplica(toHost, 4242);
    replica.rebase({ phase: 'downloaded', version: '2.0.1', percent: 100, error: null, checkedAt: 9 });
    const deps = protocolContractDeps(dir);
    deps.updates = { state: () => replica.state(), check: () => replica.check(), download: () => replica.download(), install: () => replica.install(), notes: () => replica.refreshNotes(), onChange: (l) => replica.onChange(l) };
    return { deps, toHost };
}

describe('a remote or phone connection keeps today’s owner-only updates.* rules', () => {
    it.each(['check', 'download', 'install'] as const)('updates.%s from a guest is refused, and nothing reaches the host', async (name) => {
        const { deps, toHost } = withReplica();
        const guest = await serve(deps)('guest');
        await expect((guest.bridge as unknown as { updates: Record<string, () => Promise<unknown>> }).updates[name]!()).rejects.toThrow();
        expect(toHost).not.toHaveBeenCalled();
    });

    it.each(['check', 'download', 'install'] as const)('updates.%s from the owner reaches genie-host through the window’s replica', async (name) => {
        const { deps, toHost } = withReplica();
        const owner = await serve(deps)('owner');
        await (owner.bridge as unknown as { updates: Record<string, () => Promise<unknown>> }).updates[name]!();
        expect(toHost).toHaveBeenCalledTimes(1);
        expect(toHost.mock.calls[0]![0]).toBe(name);
        if (name === 'install') expect(toHost.mock.calls[0]![1]).toEqual([4242]);
    });

    it('updates.state is the replica’s, read with no call to the host', async () => {
        const { deps, toHost } = withReplica();
        const owner = await serve(deps)('owner');
        expect(await (owner.bridge as unknown as { updates: { state(): Promise<unknown> } }).updates.state()).toMatchObject({ phase: 'downloaded', version: '2.0.1' });
        expect(toHost).not.toHaveBeenCalled();
    });
});

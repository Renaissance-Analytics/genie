import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Baton, PairingPins } from '../src/core/remote.js';
import { inMemoryPair, parseMessage, type ClientTransport, type PreAuth, type WireMessage } from '../src/core/remote-protocol.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost } from '../src/main/remote-host.js';
import { workspaceCallerFixture, type WorkspaceCallerFixture } from './helpers/features-host-workspace-caller.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * WHO MAY TRUST A WORKSPACE (2g-4d E2b, Tynn #955). Trust decides what a workspace's own files may run. Before the split
 * the window's Trust went over `engine.hosting`, local windows only; it goes over the protocol now (features.act
 * workspace.trust / workspace.untrust, answered by genie-host's HostFeatures over its own hosting's trust). The owner's
 * rule: the owner's own Genie and the owner's own paired devices are refused no feature; only a SHARE LINK differs. The
 * guard is RemoteHost's, the one every owner-only change goes through: a principal that is not the owner — a share link to
 * the whole host, or to one workspace, read-only or not — changes nothing of the host's features (remote-host.ts).
 *
 * Real RemoteHost, real HostFeatures, the real trust service over temporary files: nothing written and the verdict
 * unchanged are read from the trust record and the workspace's folder, not from a stub.
 */
const trustOf = (f: WorkspaceCallerFixture) => f.hosting.trust.view('work')?.trusted === true;

function client(t: ClientTransport) {
    const inbox: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];
    t.onMessage((text) => { const r = parseMessage(text); if (!r.ok) throw new Error(r.reason); const w = waiters.shift(); if (w) w(r.message); else inbox.push(r.message); });
    const next = () => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise<WireMessage>((r) => waiters.push(r)));
    let id = 0;
    const call = async (method: string, ...args: unknown[]) => { t.send(JSON.stringify({ kind: 'call', id: ++id, method, args })); return next() as Promise<Extract<WireMessage, { kind: 'result' }>>; };
    return { call, next, send: (frame: unknown) => t.send(JSON.stringify(frame)) };
}

let f: WorkspaceCallerFixture;
let dir: string;
let devices: DeviceStore;
let admit: (who: PreAuth, auth: 'local' | 'relay') => Promise<ReturnType<typeof client>>;

beforeEach(async () => {
    f = await workspaceCallerFixture();
    dir = await mkdtemp(join(tmpdir(), 'genie-e2b-trust-guard-'));
    devices = await DeviceStore.open(dir, { now: () => 1_000_000, random: () => 'tok' });
    const accept: Array<(c: ReturnType<typeof inMemoryPair>['server'] & { remoteAddress: string; preAuth: PreAuth }) => void> = [];
    new RemoteHost({
        now: () => 1_000_000, confirm: allowEveryPairing, api: f.api, hostName: 'alphar', baton: new Baton(),
        pins: new PairingPins({ now: () => 1_000_000 }), devices,
        transport: { onConnection: (cb) => { accept.push(cb as never); return () => {}; } },
    });
    admit = async (who, auth) => {
        const pair = inMemoryPair();
        for (const cb of accept) cb({ ...pair.server, remoteAddress: auth === 'local' ? 'local-window' : 'relay:wren', preAuth: who });
        const c = client(pair.client);
        c.send({ kind: 'hello', auth: { kind: auth }, label: who.label });
        let welcome = await c.next();
        while (welcome.kind === 'pairing') welcome = await c.next();
        expect(welcome).toMatchObject({ kind: 'welcome', isOwner: who.isOwner });
        if (!who.readonly) expect(await c.call('baton.take')).toMatchObject({ ok: true });
        return c;
    };
});

afterEach(async () => {
    await devices.flushed();
    await rm(dir, { recursive: true, force: true });
    await f.close();
});

const OWN_WINDOW: PreAuth = { kind: 'local', label: 'this Genie window', isOwner: true, workspaceId: null, readonly: false, window: 'main' };
const OWN_DEVICE: PreAuth = { kind: 'relay', label: 'the owner’s phone', isOwner: true, workspaceId: null, readonly: false };
const SHARE_WORKSPACE: PreAuth = { kind: 'relay', label: 'wren', isOwner: false, workspaceId: 'work', readonly: false };
const SHARE_HOST: PreAuth = { kind: 'relay', label: 'wren', isOwner: false, workspaceId: null, readonly: false };

const trust = () => ({ kind: 'workspace.trust', workspaceId: 'work', workspacePath: f.workspace });
const untrust = () => ({ kind: 'workspace.untrust', workspaceId: 'work' });

describe('Trust and Untrust over the protocol: the owner’s own Genie and devices, never a share link', () => {
    it('the owner’s own Genie (this machine’s window): Trust is recorded, and Genie’s files go in', async () => {
        const c = await admit(OWN_WINDOW, 'local');
        expect(trustOf(f)).toBe(false);
        expect(await c.call('features.act', trust())).toMatchObject({ ok: true });
        expect(trustOf(f)).toBe(true);
        expect(f.order).toEqual(['trust', 'docs:you', 'config:you']);
    });

    it('the owner’s own paired device: Trust is recorded, then Untrust withdraws it', async () => {
        const c = await admit(OWN_DEVICE, 'relay');
        expect(await c.call('features.act', trust())).toMatchObject({ ok: true });
        expect(trustOf(f)).toBe(true);
        expect(await c.call('features.act', untrust())).toMatchObject({ ok: true });
        expect(trustOf(f)).toBe(false);
    });

    for (const [name, who] of [['a share link to this workspace, with write access', SHARE_WORKSPACE], ['a share link to the whole host, with write access', SHARE_HOST]] as const) {
        it(`${name}: Trust is refused in words, nothing is written, the verdict is unchanged`, async () => {
            const c = await admit(who, 'relay');
            const answer = await c.call('features.act', trust());
            expect(answer).toMatchObject({ ok: false });
            expect((answer as { reason: string }).reason).toMatch(/only its owner can|a shared workspace cannot/);
            expect(trustOf(f)).toBe(false);
            expect(f.order).toEqual([]);
            expect(f.trust).not.toHaveBeenCalled();
            expect(f.docs).not.toHaveBeenCalled();
            expect(f.config).not.toHaveBeenCalled();
        });

        it(`${name}: Untrust of a trusted workspace is refused in words, and it stays trusted`, async () => {
            await f.hosting.trust.trust('work');
            const c = await admit(who, 'relay');
            const answer = await c.call('features.act', untrust());
            expect(answer).toMatchObject({ ok: false });
            expect((answer as { reason: string }).reason).toMatch(/only its owner can|a shared workspace cannot/);
            expect(trustOf(f)).toBe(true);
            expect(f.untrust).not.toHaveBeenCalled();
        });
    }
});

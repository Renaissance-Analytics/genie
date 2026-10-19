import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inMemoryPair, parseMessage, type ServerConnection } from '../src/core/remote-protocol.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * REMOTE ACCESS IN THE SNAPSHOT (§6.8) — the host side's facts for the Settings → Workstation
 * section: the PIN on this screen, the paired devices, who is connected and who is driving, the lock,
 * and the share-link roster. Minting a link SERVES its URL exactly once: it is in the answer to the
 * mint and in no snapshot after — a link is a credential you cannot unsend. The RemoteHost is
 * composed with the rest; the transport is a port (an in-memory pair here).
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

let dir: string;
let services: ComposedServices;
let accept: (c: ServerConnection) => void = () => {};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-remote-'));
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
        hostName: 'alphar',
        remoteTransport: { onConnection: (cb) => { accept = cb; return () => {}; } },
    });
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('the remote section', () => {
    it('is MEASURED at boot: the host name, no URL until a transport listens, unlocked, no PIN, no devices, no links, nobody connected', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.remote).toEqual({ host: 'alphar', url: null, unavailable: 'nothing is listening on alphar', locked: false, pin: null, devices: [], shares: [], connections: [], servedLink: null, enabled: false, firewall: false, firewallOutcome: null });
    });

    it('remote.issuePin puts six digits on this screen with their expiry; lock and unlock flip the kill-switch', async () => {
        const pinned = await handleFeatureAction(services, { kind: 'remote.issuePin' }, state());
        expect(pinned.remote!.pin).toMatchObject({ code: expect.stringMatching(/^\d{6}$/) });
        expect(pinned.remote!.pin!.expiresAt).toBeGreaterThan(Date.now());
        expect((await handleFeatureAction(services, { kind: 'remote.lock' }, state())).remote!.locked).toBe(true);
        expect((await handleFeatureAction(services, { kind: 'remote.unlock' }, state())).remote!.locked).toBe(false);
    });

    it('a device that reads the PIN appears in the roster and among the connections; revoking it drops the roster entry', async () => {
        const pinned = await handleFeatureAction(services, { kind: 'remote.issuePin' }, state());
        const pair = inMemoryPair();
        accept(pair.server);
        const got: unknown[] = [];
        pair.client.onMessage((t) => { const r = parseMessage(t); if (r.ok) got.push(r.message); });
        pair.client.send(JSON.stringify({ kind: 'hello', auth: { kind: 'pin', code: pinned.remote!.pin!.code }, label: 'glenn’s phone' }));
        await tick();
        expect(got[0]).toMatchObject({ kind: 'welcome', isOwner: true });

        const snap = await featureSnapshot(services, state());
        expect(snap.remote!.devices.map((d) => d.label)).toEqual(['glenn’s phone']);
        expect(snap.remote!.connections).toEqual([{ id: expect.any(String), label: 'glenn’s phone', isOwner: true, workspaceId: null, driving: false }]);
        const after = await handleFeatureAction(services, { kind: 'remote.revokeDevice', deviceId: snap.remote!.devices[0]!.id }, state());
        expect(after.remote!.devices).toEqual([]);
    });

    it('minting a share link serves its URL ONCE — in the mint’s answer, never in a later snapshot; the roster shows it served; revoke refuses it', async () => {
        const minted = await handleFeatureAction(services, { kind: 'remote.mintShare', workspaceId: 'tynn', grantedTo: 'wren', expiresInMs: 3_600_000 }, state());
        expect(minted.remote!.servedLink).toMatchObject({ id: expect.stringMatching(/^share_/), url: expect.stringMatching(/\/share\/share_[^#]+#.+$/) });
        expect(minted.remote!.shares).toEqual([{ id: minted.remote!.servedLink!.id, workspaceId: 'tynn', grantedTo: 'wren', expiresAt: expect.any(Number), served: true, revoked: false }]);

        const later = await featureSnapshot(services, state());
        expect(later.remote!.servedLink).toBeNull();
        expect(later.remote!.shares[0]!.served).toBe(true);

        const revoked = await handleFeatureAction(services, { kind: 'remote.revokeShare', shareId: minted.remote!.servedLink!.id }, state());
        expect(revoked.remote!.shares[0]!.revoked).toBe(true);
        await expect(handleFeatureAction(services, { kind: 'remote.revokeShare', shareId: 'share_nope' }, state())).rejects.toThrow(/no share link/);
    });
});

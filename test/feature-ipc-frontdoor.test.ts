import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE FRONT DOOR IN THE HOSTING SNAPSHOT — its state rides `hosting.frontDoor`, and the two
 * person-triggered repairs are actions: trust the certificate (one OS prompt), and try the hosts
 * file again after a declined prompt. A refusal is thrown with the reason, never swallowed.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const settle = () => new Promise<void>((r) => setTimeout(r, 15));

let dir: string;
let services: ComposedServices;
let content = '';
let denyElevated = false;
let declineTrust = false;
const hostsIo: HostsIo = {
    read: async () => content,
    write: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    writeElevated: async (next) => { if (denyElevated) throw new Error('Request dismissed'); content = next; },
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-frontdoor-'));
    content = '127.0.0.1 localhost\n';
    denyElevated = false;
    declineTrust = false;
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0,
        hostsIo,
        runElevated: async () => { if (declineTrust) throw new Error('the user declined'); },
    });
    await settle();
});

afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('hosting.frontDoor', () => {
    it('is the composed front door state, verbatim', async () => {
        const snap = await featureSnapshot(services, state());
        expect(snap.hosting!.frontDoor).toEqual(services.externalFrontDoor);
        expect(snap.hosting!.frontDoor).toMatchObject({ running: true, hosts: { changed: true, elevated: true }, trusted: false });
    });

    it('hosting.trustCertificate trusts once; a declined prompt is a thrown refusal', async () => {
        const snap = await handleFeatureAction(services, { kind: 'hosting.trustCertificate' }, state());
        expect(snap.hosting!.frontDoor).toMatchObject({ trusted: true });

        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
        dir = await mkdtemp(join(tmpdir(), 'genie2-feature-ipc-frontdoor-'));
        declineTrust = true;
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0, hostsIo, runElevated: async () => { throw new Error('the user declined'); } });
        await expect(handleFeatureAction(services, { kind: 'hosting.trustCertificate' }, state())).rejects.toThrow('the user declined');
    });

    it('hosting.syncHosts tries the hosts file again after a declined prompt and the snapshot shows the outcome', async () => {
        denyElevated = true;
        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        await settle();
        const before = await featureSnapshot(services, state());
        expect(before.hosting!.frontDoor).toMatchObject({ hosts: { error: 'Request dismissed' } });

        denyElevated = false;
        const after = await handleFeatureAction(services, { kind: 'hosting.syncHosts' }, state());
        expect(after.hosting!.frontDoor).toMatchObject({ hosts: { changed: true, elevated: true } });
        expect(content).toContain('127.0.0.1 docs.gen');
    });
});

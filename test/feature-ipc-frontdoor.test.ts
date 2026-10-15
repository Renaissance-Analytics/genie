import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import { TRUST_DECK_ID } from '../src/core/gen-ca.js';
import type { TrustStorePort } from '../src/main/gen-ca.js';
import type { HostsIo } from '../src/main/hosts-file.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * THE FRONT DOOR IN THE HOSTING SNAPSHOT — its state rides `hosting.frontDoor`, and the two
 * person-triggered repairs are actions: trust the certificate (one OS prompt), and try the hosts
 * file again after a declined prompt. A refusal is thrown with the reason, never swallowed. The
 * Deck's Trust item answers through the same Trust; its Not now is remembered.
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
/** The OS trust store: what it holds. The elevated install adds Genie's CA to it unless declined. */
let held = new Set<string>();
const trustStore: TrustStorePort = { has: async (t) => held.has(t) };
const installed = () => { const fd = services.externalFrontDoor; if (fd.running) held.add(fd.authority.thumbprint); };
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
    held = new Set<string>();
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0,
        hostsIo, trustStore,
        runElevated: async () => { if (declineTrust) throw new Error('the user declined'); installed(); },
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
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: '/opt/genie/runtime/caddy', frontDoorPort: 0, hostsIo, trustStore, runElevated: async () => { throw new Error('the user declined'); } });
        await settle();
        await expect(handleFeatureAction(services, { kind: 'hosting.trustCertificate' }, state())).rejects.toThrow('Genie could not install its certificate into the trust store: the user declined');
        expect((await featureSnapshot(services, state())).hosting!.frontDoor).toMatchObject({ trusted: false, trustError: 'Genie could not install its certificate into the trust store: the user declined' });
    });

    it('the Deck’s Trust item: Trust trusts through the same one prompt; Not now removes it', async () => {
        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        await settle();
        const item = services.deckItems().find((i) => i.id === TRUST_DECK_ID)!;
        expect(item).toBeDefined();
        const snap = await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'trust' }, state());
        expect(snap.hosting!.frontDoor).toMatchObject({ trusted: true });
        expect(services.deckItems().find((i) => i.id === TRUST_DECK_ID)).toBeUndefined();
    });

    it('the Deck’s Not now: the item is gone; a declined Trust from the Deck is a thrown refusal with the reason', async () => {
        services.sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: dir, serve: { mode: 'proxy' }, hostPort: 5173 });
        await settle();
        const item = services.deckItems().find((i) => i.id === TRUST_DECK_ID)!;
        declineTrust = true;
        await expect(handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'trust' }, state())).rejects.toThrow('the user declined');
        expect(services.deckItems().find((i) => i.id === TRUST_DECK_ID)).toBeDefined();
        await handleFeatureAction(services, { kind: 'deck.answer', item, optionId: 'not-now' }, state());
        expect(services.deckItems().find((i) => i.id === TRUST_DECK_ID)).toBeUndefined();
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

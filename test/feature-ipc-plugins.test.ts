import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { PluginsService } from '../src/main/plugins-host.js';
import { PluginsReplica } from '../src/main/plugins-replica.js';
import { hostCatalog } from '../src/main/genie-catalog.js';

/**
 * PLUGINS IN THE SNAPSHOT (§6.7). The plugin host at `<userData>/plugins` is GENIE-HOST'S (ADF A3, Tynn #447): the
 * window's composed services read it through the host's replica — so this test composes the services the way main.ts
 * does with a host, over the host's real `PluginsService`, wired as the engine wires it (a call asks the host; the host's
 * change comes back as its dump). The snapshot lists every entry; `plugins.setEnabled` flips an installable one and is
 * refused (returns the same list) for one that is not. Turning developer mode on re-reads the folder so an unsigned local
 * plugin appears enabled.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

let dir: string;
let services: ComposedServices;
let host: PluginsService;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-plugins-'));
    await mkdir(join(dir, 'plugins', 'local-dev'), { recursive: true });
    await writeFile(join(dir, 'plugins', 'local-dev', 'genie-plugin.json'), JSON.stringify({ id: 'com.example.localdev', name: 'Local Dev', version: '0.1.0', publisher: { name: 'Me', keyId: 'me' } }));
    let publisherChecksOff = () => false;
    host = await PluginsService.open({ dir: join(dir, 'plugins'), keys: {}, publisherChecksOff: () => publisherChecksOff() });
    const replica = new PluginsReplica((method, args) => host.call(method, args));
    host.onEvent((dump) => replica.rebase(dump));
    replica.rebase(host.dump());
    // The host's catalog, as the window's replica of it reads (ADF A5: the editors and panels are the catalog's).
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, plugins: replica, catalog: { list: () => hostCatalog(host.plugins()).list() } });
    publisherChecksOff = () => services.settings.snapshot().publisher_checks_off === true;
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

/*
 * REWRITTEN for beta.33 item 14 (the owner: "I STILL DO NOT SEE OUR PLUGINS SUPPORTED"): the list now begins with the
 * official plugins that ship in Genie (Document, Spreadsheet, Presentation). The folder plugin's rules are unchanged, so it
 * is found by id instead of being the list's only entry.
 */
const local = <T extends { id: string }>(data: { plugins: { entries: readonly T[] } | null }) => data.plugins!.entries.find((p) => p.id === 'com.example.localdev')!;

describe('plugins in the snapshot', () => {
    it('lists the folder with its state and reason; an unsigned local plugin is refused until developer mode is on, then enabled and labelled', async () => {
        const before = await featureSnapshot(services, state());
        expect(before.plugins).toMatchObject({ dir: join(dir, 'plugins'), publisherChecksOff: false });
        expect(local(before)).toMatchObject({ state: 'refused', label: null });
        expect(local(before).reason).toMatch(/^unsigned plugins are not installed/);

        // ADF B8: a change the host refuses is a failure the page shows, never dropped; and nothing changed.
        await expect(handleFeatureAction(services, { kind: 'plugins.setEnabled', id: 'com.example.localdev', enabled: true }, state())).rejects.toThrow(/com\.example\.localdev could not be enabled/);
        expect(local(await handleFeatureAction(services, { kind: 'settings.set', key: 'publisher_checks_off', value: false }, state()))).toMatchObject({ state: 'refused' });

        const dev = await handleFeatureAction(services, { kind: 'settings.set', key: 'publisher_checks_off', value: true }, state());
        expect(dev.plugins).toMatchObject({ publisherChecksOff: true });
        expect(local(dev)).toMatchObject({ state: 'enabled', label: 'Unverified' });

        const off = await handleFeatureAction(services, { kind: 'plugins.setEnabled', id: 'com.example.localdev', enabled: false }, state());
        expect(local(off)).toMatchObject({ state: 'disabled' });
        expect(host.plugins().guard('com.example.localdev')).toBeNull();
    });

    it('the official plugins are listed first and their editors reach the renderer; disabling one takes its editor away', async () => {
        const before = await featureSnapshot(services, state());
        expect(before.plugins!.entries.slice(0, 3).map((p) => [p.id, p.state, p.label])).toEqual([
            ['ai.genie.document', 'enabled', 'official — ships with Genie'],
            ['ai.genie.spreadsheet', 'enabled', 'official — ships with Genie'],
            ['ai.genie.presentation', 'enabled', 'official — ships with Genie'],
        ]);
        expect(before.plugins!.editors!.map((e) => e.pluginId)).toEqual(['ai.genie.document', 'ai.genie.spreadsheet', 'ai.genie.presentation']);
        const off = await handleFeatureAction(services, { kind: 'plugins.setEnabled', id: 'ai.genie.document', enabled: false }, state());
        expect(off.plugins!.editors!.map((e) => e.pluginId)).toEqual(['ai.genie.spreadsheet', 'ai.genie.presentation']);
    });
});

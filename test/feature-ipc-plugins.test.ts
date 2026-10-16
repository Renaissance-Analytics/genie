import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * PLUGINS IN THE SNAPSHOT (§6.7). The composed services open the plugin host at `<userData>/plugins`
 * with the publisher keys Genie carries and the `developer_mode` setting; the snapshot lists every
 * entry; `plugins.setEnabled` flips an installable one and is refused (returns the same list) for one
 * that is not. Turning developer mode on re-reads the folder so an unsigned local plugin appears enabled.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });

let dir: string;
let services: ComposedServices;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-feature-plugins-'));
    await mkdir(join(dir, 'plugins', 'local-dev'), { recursive: true });
    await writeFile(join(dir, 'plugins', 'local-dev', 'genie-plugin.json'), JSON.stringify({ id: 'com.example.localdev', name: 'Local Dev', version: '0.1.0', publisher: { name: 'Me', keyId: 'me' } }));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0 });
});
afterEach(async () => {
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe('plugins in the snapshot', () => {
    it('lists the folder with its state and reason; an unsigned local plugin is refused until developer mode is on, then enabled and labelled', async () => {
        const before = await featureSnapshot(services, state());
        expect(before.plugins).toMatchObject({ dir: join(dir, 'plugins'), developerMode: false, entries: [{ id: 'com.example.localdev', state: 'refused', label: null }] });
        expect(before.plugins!.entries[0]!.reason).toMatch(/^unsigned plugins are not installed/);

        const refused = await handleFeatureAction(services, { kind: 'plugins.setEnabled', id: 'com.example.localdev', enabled: true }, state());
        expect(refused.plugins!.entries[0]!.state).toBe('refused');

        const dev = await handleFeatureAction(services, { kind: 'settings.set', key: 'developer_mode', value: true }, state());
        expect(dev.plugins).toMatchObject({ developerMode: true, entries: [{ id: 'com.example.localdev', state: 'enabled', label: 'UNSIGNED — developer mode' }] });

        const off = await handleFeatureAction(services, { kind: 'plugins.setEnabled', id: 'com.example.localdev', enabled: false }, state());
        expect(off.plugins!.entries[0]!.state).toBe('disabled');
        expect(services.plugins.guard('com.example.localdev')).toBeNull();
    });
});

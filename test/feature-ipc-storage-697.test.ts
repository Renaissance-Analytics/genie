import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { featureSnapshot, handleFeatureAction, type FeaturePorts, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import type { StorageView } from '../src/core/workspace-storage.js';

/**
 * THE STORAGE TAB'S PATH TO THE HOST (Tynn #697). The window sends a workspace id and an item id, never a path: the host's
 * storage port resolves the workspace and re-validates the item. Its view rides the feature snapshot per workspace.
 */
const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
const VIEW: StorageView = { measuring: false, report: null, error: null, outcome: 'Moved wt/clean to .trash.' };

function fakeStorage() {
    const calls: unknown[][] = [];
    const port: NonNullable<FeaturePorts['storage']> = {
        views: () => ({ ws1: VIEW }),
        measure: (id) => { calls.push(['measure', id]); },
        trash: async (id, item) => { calls.push(['trash', id, item]); },
        restore: async (id, trashId) => { calls.push(['restore', id, trashId]); },
        empty: async (id, approval) => { calls.push(['empty', id, approval]); },
    };
    return { port, calls };
}

let dir: string;
let services: ComposedServices;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-storage-ipc-'));
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, hostName: 'alphar', remoteTransport: { onConnection: () => () => {} } });
});
afterEach(async () => { await services.shutdown(); await rm(dir, { recursive: true, force: true }); });

describe('storage in the snapshot and its actions', () => {
    it('the snapshot carries each workspace’s storage view', async () => {
        const s = fakeStorage();
        expect((await featureSnapshot(services, state(), { storage: s.port })).storage).toEqual({ ws1: VIEW });
    });

    it('CONTROL: no storage port: none in the snapshot, and an action is refused in words', async () => {
        expect((await featureSnapshot(services, state())).storage).toBeNull();
        await expect(handleFeatureAction(services, { kind: 'storage.measure', workspaceId: 'ws1' }, state())).rejects.toThrow('cannot measure');
    });

    it('measure, trash, restore and empty reach the port with the ids the window sent, and nothing else', async () => {
        const s = fakeStorage();
        const approval = { ids: ['genie-1-abc'], bytes: 10 };
        await handleFeatureAction(services, { kind: 'storage.measure', workspaceId: 'ws1' }, state(), { storage: s.port });
        await handleFeatureAction(services, { kind: 'storage.trash', workspaceId: 'ws1', itemId: 'worktrees:wt/clean' }, state(), { storage: s.port });
        await handleFeatureAction(services, { kind: 'storage.restore', workspaceId: 'ws1', trashId: 'genie-1-abc' }, state(), { storage: s.port });
        await handleFeatureAction(services, { kind: 'storage.emptyTrash', workspaceId: 'ws1', approval }, state(), { storage: s.port });
        expect(s.calls).toEqual([['measure', 'ws1'], ['trash', 'ws1', 'worktrees:wt/clean'], ['restore', 'ws1', 'genie-1-abc'], ['empty', 'ws1', approval]]);
    });
});

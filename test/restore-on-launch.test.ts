import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * RESTORE AFTER AN UPGRADE OR RELAUNCH (§7.6, §2.5). The registry remembers which agents were RUNNING
 * when Genie last closed — written at quit, before anything is stopped — so every launch knows whom to
 * start (always: the restore switch was removed 2026-10-20, the owner's call). An agent the user had stopped was not running,
 * so it is never in the list: "never restarts what the user stopped" falls out of the record, not of
 * a flag. The list is cleared once read, so a crash mid-restore does not restart twice.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-restore-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('runningAtQuit', () => {
    it('is empty by default, persists what was marked across a reload, filters unknown ids, and is KEPT until the agent's restore start went through (Tynn #754)', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'bolt' });
        expect(registry.runningAtQuit()).toEqual([]);

        await registry.markRunningAtQuit([a.id, 'agent_never_existed' as never]);
        expect(registry.runningAtQuit()).toEqual([a.id]);

        const again = new Registry(new Store(dir));
        await again.load({ name: 'alphar', healthy: true });
        expect(again.runningAtQuit()).toEqual([a.id]);
        expect((await again.beginRestore()).running).toEqual([a.id]);
        // Read, not taken: a shutdown before a's start still finds it.
        const before = new Registry(new Store(dir));
        await before.load({ name: 'alphar', healthy: true });
        expect(before.runningAtQuit()).toEqual([a.id]);
        await again.restoreStarted(a.id);
        expect(again.runningAtQuit()).toEqual([]);

        const third = new Registry(new Store(dir));
        await third.load({ name: 'alphar', healthy: true });
        expect(third.runningAtQuit()).toEqual([]);
    });
});

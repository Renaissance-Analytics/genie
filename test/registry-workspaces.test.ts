import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE REGISTRY'S WORKSPACE OPERATIONS (§6.1) — a workspace can be ASLEEP (hibernated: nothing may
 * start in it, and it stays asleep through restarts and upgrades because the flag is on disk), and a
 * workspace can be FORGOTTEN (removed from Genie: its agent records go with it; the folder on disk is
 * never touched here — this class owns no filesystem). The snapshot carries `asleep` so the rail
 * and the Workspace surface can say it.
 */

let dir: string;
let registry: Registry;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-registry-ws-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    await registry.addWorkspace({ id: 'fancy', path: '/w/fancy' });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('asleep', () => {
    it('is false by default, flips with setAsleep, shows in the snapshot, and SURVIVES a reopen', async () => {
        expect(registry.snapshot().workspaces!.find((w) => w.id === 'tynn')!.asleep).toBe(false);
        expect(await registry.setAsleep('tynn', true)).toBe(true);
        expect(registry.workspace('tynn')?.asleep).toBe(true);
        expect(registry.snapshot().workspaces!.find((w) => w.id === 'tynn')!.asleep).toBe(true);
        expect(await registry.setAsleep('nope', true)).toBe(false);

        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.workspace('tynn')?.asleep).toBe(true);
        expect(reopened.workspace('fancy')?.asleep).toBe(false);
    });
});

describe('forgetWorkspace', () => {
    it('removes the workspace AND its agent records, leaves other workspaces alone, and answers how many agents went; an unknown id is null', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const b = await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'bolt' });
        const c = await registry.register({ workspaceId: 'fancy', provider: 'claude', name: 'cass' });
        expect(await registry.forgetWorkspace('tynn')).toEqual({ agentsForgotten: 2 });
        expect(registry.workspace('tynn')).toBeNull();
        expect(registry.find(a.id)).toBeNull();
        expect(registry.find(b.id)).toBeNull();
        expect(registry.find(c.id)).not.toBeNull();
        expect(registry.snapshot().workspaces!.map((w) => w.id)).toEqual(['fancy']);
        expect(await registry.forgetWorkspace('tynn')).toBeNull();

        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.workspace('tynn')).toBeNull();
        expect(reopened.find(c.id)).not.toBeNull();
    });

    it('agentsOf lists a workspace’s agents', async () => {
        await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(registry.agentsOf('tynn').map((r) => r.name)).toEqual(['atlas']);
        expect(registry.agentsOf('fancy')).toEqual([]);
    });
});

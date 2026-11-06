import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

let dir: string;
let store: Store;
let registry: Registry;
let awake: AgentRecord;
let ghost: AgentRecord;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-394-'));
    store = new Store(dir);
    awake = agentRecord({ id: mintAgentId(), workspaceId: 'awake', name: 'Active', provider: 'claude' });
    ghost = agentRecord({ id: mintAgentId(), workspaceId: 'ghost', name: 'Dormant', provider: 'codex' });
    await store.writeWorkspaces([{ id: 'awake', path: '/awake' }, { id: 'ghost', path: '/ghost', asleep: true }]);
    await store.writeAgents([awake, ghost]);
    registry = new Registry(store);
    await registry.load({ name: 'test', healthy: true });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('story 394: a hibernated workspace supplies no data', () => {
    it('excludes its agents and Deck items before reading sessions, handoffs or observed output', () => {
        const probe = vi.fn(() => null), observed = vi.fn(() => null), handoff = vi.fn(() => null);
        registry.setProbe(probe); registry.setObservedProbe(observed); registry.setHandoffProbe(handoff);
        registry.setDeckSource(() => [
            { id: 'active-question', workspaceId: 'awake', agentId: awake.id },
            { id: 'ghost-question', workspaceId: 'ghost', agentId: ghost.id },
        ] as never);
        probe.mockClear(); observed.mockClear(); handoff.mockClear();
        const snapshot = registry.snapshot();
        expect(snapshot.agents.map((a) => a.id)).toEqual([awake.id]);
        expect(snapshot.deckItems?.map((d) => d.id)).toEqual(['active-question']);
        for (const read of [probe, observed, handoff]) expect(read.mock.calls.flat()).not.toContain(ghost.id);
    });
    it('keeps only sidebar ghost metadata, without consulting project files for names or colours', () => {
        const namer = vi.fn((path: string) => `Name of ${path}`), color = vi.fn(() => null);
        registry.setWorkspaceNamer(namer); registry.setWorkspaceColorer(color);
        namer.mockClear(); color.mockClear();
        const snapshot = registry.snapshot();
        expect(snapshot.workspaces?.map((w) => w.id)).toEqual(['awake']);
        const ghosts = (snapshot as unknown as { hibernatedWorkspaces?: { id: string; path: string; asleep: boolean }[] }).hibernatedWorkspaces;
        expect(ghosts).toEqual([expect.objectContaining({ id: 'ghost', path: '/ghost', asleep: true })]);
        expect(namer.mock.calls.flat()).not.toContain('/ghost');
        expect(color.mock.calls.flat()).not.toContain('/ghost');
        expect(JSON.stringify(ghosts)).not.toContain(ghost.id);
    });
    it('removes ghosts from window tool rosters, workspace selectors, search slugs and direct agent lookups', () => {
        expect(registry.listAgents().map((a) => a.id)).toContain(awake.id);
        expect(registry.listAgents().map((a) => a.id)).not.toContain(ghost.id);
        expect(registry.listWorkspaces().map((w) => w.id)).toEqual(['awake']);
        expect([...registry.workspaceSlugs().keys()]).toEqual(['awake']);
        expect(registry.find(ghost.id)).toBeNull();
        expect(registry.agentsOf('ghost')).toEqual([]);
    });
    it('also removes ghosts from the headless MCP/AgentInbox roster and workspace slugs', async () => {
        const host = new HostRegistry(store); await host.refresh();
        expect(host.listAgents().map((a) => a.id)).toContain(awake.id);
        expect(host.listAgents().map((a) => a.id)).not.toContain(ghost.id);
        expect(host.listWorkspaces().map((w) => w.id)).toEqual(['awake']);
        expect([...host.workspaceSlugs().keys()]).toEqual(['awake']);
        expect(host.find(ghost.id)).toBeNull();
    });
    it('removes an already-visible workspace immediately on hibernation, while preserving the other workspace', async () => {
        await registry.setAsleep('ghost', false);
        expect(registry.listAgents().map((a) => a.id)).toContain(ghost.id);
        await registry.setAsleep('ghost', true);
        expect(registry.snapshot().agents.map((a) => a.id)).toEqual([awake.id]);
        expect(registry.listAgents().map((a) => a.id)).not.toContain(ghost.id);
        const reopened = new Registry(store); await reopened.load({ name: 'test', healthy: true });
        expect(reopened.snapshot().agents.map((a) => a.id)).toEqual([awake.id]);
    });
});

describe('story 394: redocking requires each agent to reorient on its next turn', () => {
    it('persists the redock marker for each agent and does not arm it on an already-awake workspace', async () => {
        const other = agentRecord({ id: mintAgentId(), workspaceId: 'ghost', name: 'Second', provider: 'claude' });
        await store.writeAgents([awake, ghost, other]); await registry.refresh();
        await registry.setAsleep('ghost', false);
        const stamp = (registry.find(ghost.id) as unknown as { redockAt?: string }).redockAt;
        expect(stamp).toEqual(expect.any(String));
        expect((registry.find(other.id) as unknown as { redockAt?: string }).redockAt).toBe(stamp);
        expect(registry.find(awake.id)).not.toHaveProperty('redockAt');
        const reopened = new Registry(store); await reopened.load({ name: 'test', healthy: true });
        expect(reopened.find(ghost.id)).toHaveProperty('redockAt', stamp);
        await reopened.setAsleep('ghost', false);
        expect(reopened.find(ghost.id)).toHaveProperty('redockAt', stamp);
    });
});

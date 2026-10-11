import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupByWorkspace, type AgentRow } from '../src/core/dashboard-view.js';
import type { AgentRecord } from '../src/core/identity.js';
import { HUMAN, reachable } from '../src/core/inbox.js';
import { railWorkspaces, type RailWorkspace } from '../src/core/rail-view.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * OPS PROJECTS GOVERNING CHILDREN (§6.1). An ops workspace GOVERNS other workspaces — a Genie-side relation
 * on the workspace record (the published envelope schema has no such field, so nothing is written into
 * project.json). Governing means: the rail and the Dashboard nest the children under the governor, in the
 * user's order; and for AgentInbox reach, the governor counts as the child's own workspace in both tiers.
 * The relation is persisted; a workspace cannot govern itself or an unknown id.
 */

const row = (id: string, workspaceId: string): AgentRow => ({
    id, name: id, provider: 'claude', workspaceId, fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null,
    activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const ws = (id: string, over: Partial<RailWorkspace> = {}): RailWorkspace => ({ id, path: `/w/${id}`, agentsKnown: true, ...over });

describe('the rail nests governed workspaces under their governor', () => {
    it('children follow their governor directly, in the user\'s order, and carry governedBy; the rest stay where they were', () => {
        const items = railWorkspaces([ws('ops', { governs: ['fancy', 'prism'] }), ws('tynn'), ws('fancy'), ws('prism')], [row('a', 'fancy')]);
        expect(items.map((i) => i.id)).toEqual(['ops', 'fancy', 'prism', 'tynn']);
        expect(items[1]).toMatchObject({ id: 'fancy', governedBy: 'ops', count: 1 });
        // Ungoverned rows carry NO governedBy key at all (existing item literals stay exact).
        expect('governedBy' in items[3]!).toBe(false);
        expect(railWorkspaces([ws('tynn'), ws('fancy')], []).map((i) => i.governedBy ?? null)).toEqual([null, null]);
    });
});

describe('the Dashboard groups the same way and names the governor', () => {
    it('governed groups follow their governor and say who governs them', () => {
        const groups = groupByWorkspace([row('a', 'fancy'), row('b', 'ops')], ['ops', 'tynn', 'fancy'], { fancy: 'ops' });
        expect(groups.map((g) => g.workspaceId)).toEqual(['ops', 'fancy', 'tynn']);
        expect(groups[1]).toMatchObject({ workspaceId: 'fancy', governedBy: 'ops' });
        expect('governedBy' in groups[0]!).toBe(false);
        expect('governedBy' in groupByWorkspace([], ['tynn'])[0]!).toBe(false);
    });
});

describe('reach: the governor counts as the child\'s own workspace', () => {
    const agent = (id: string, workspaceId: string, accessScope: AgentRecord['accessScope'] = 'self'): AgentRecord =>
        ({ id, workspaceId, provider: 'claude', name: id, instructions: null, threadId: null, createdAt: 't', lastUsedAt: null, mode: 'manual', accessScope } as AgentRecord);
    const self = () => ({ scope: 'self' as const });
    const governs = (from: string, to: string) => from === 'ops' && to === 'fancy';

    it('an ops agent reaches a child agent whose workspace and scope are self; a stranger still does not; the child does not get the reverse for free', () => {
        const opsAgent = agent('o', 'ops');
        const child = agent('c', 'fancy');
        const stranger = agent('s', 'tynn');
        expect(reachable(opsAgent, child, self)).toBe(false);
        expect(reachable(opsAgent, child, self, { governs })).toBe(true);
        expect(reachable(stranger, child, self, { governs })).toBe(false);
        expect(reachable(child, opsAgent, self, { governs })).toBe(false);
        expect(reachable(opsAgent, agent('n', 'fancy', 'none'), self, { governs })).toBe(false);
        expect(reachable(HUMAN, child, self)).toBe(true);
    });
});

describe('the registry persists the relation', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-ops-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('setGoverns keeps known ids only, never self; governorOf answers for a child; the snapshot carries governedBy; persisted across a reload', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        for (const id of ['ops', 'tynn', 'fancy']) await registry.addWorkspace({ id, path: `/w/${id}` });
        expect(await registry.setGoverns('ops', ['fancy', 'ops', 'ghost'])).toEqual({ ok: true, governs: ['fancy'] });
        expect(await registry.setGoverns('ghost', ['fancy'])).toEqual({ ok: false, reason: 'no workspace "ghost"' });
        expect(registry.governorOf('fancy')).toBe('ops');
        expect(registry.governorOf('tynn')).toBeNull();
        expect(registry.snapshot().workspaces!.find((w) => w.id === 'fancy')).toMatchObject({ governedBy: 'ops' });
        expect(registry.snapshot().workspaces!.find((w) => w.id === 'ops')).toMatchObject({ governs: ['fancy'] });

        const again = new Registry(new Store(dir));
        await again.load({ name: 'alphar', healthy: true });
        expect(again.governorOf('fancy')).toBe('ops');
        // Removing the child workspace drops it from the governor's list.
        await again.forgetWorkspace('fancy');
        expect(again.workspace('ops')).toMatchObject({ governs: [] });
    });
});

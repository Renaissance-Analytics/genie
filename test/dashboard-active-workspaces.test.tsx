import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { EMPTY_SNAPSHOT, type GenieSnapshot } from '../src/renderer/bridge.js';
import { Dashboard, type DashboardProps } from '../src/renderer/components/Dashboard.js';
import { Shell } from '../src/renderer/Shell.js';

const row = (id: string, workspaceId: string, state: AgentRow['state'] = 'working'): AgentRow => ({
    id, name: id, workspaceId, state, provider: 'codex', fidelity: 'declared', duration: null,
    ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null,
    collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const snapshot: GenieSnapshot = {
    ...EMPTY_SNAPSHOT,
    workspaces: [
        { id: 'active', name: 'Active workspace', path: '/fixture/active', agentsKnown: true, asleep: false },
        { id: 'active-empty', name: 'Active empty', path: '/fixture/active-empty', agentsKnown: true },
        { id: 'sleeping', name: 'Hibernated workspace', path: '/fixture/sleeping', agentsKnown: true, asleep: true },
        { id: 'sleeping-empty', name: 'Hibernated empty', path: '/fixture/sleeping-empty', agentsKnown: true, asleep: true },
    ],
    agents: [row('active-working', 'active'), row('active-idle', 'active', 'idle'), row('sleep-working', 'sleeping'),
        row('sleep-waiting', 'sleeping', 'waiting'), { ...row('sleep-remote', 'sleeping', 'remote'), fidelity: 'remote' }],
    osAgent: row('genie', '__genie__'),
};
const render = (over: Partial<DashboardProps> = {}) => renderToStaticMarkup(<Dashboard
    workspaces={snapshot.workspaces} rows={snapshot.agents} genie={snapshot.osAgent ?? null}
    onOpenAgent={() => {}} onAddAgent={() => {}} {...over}
/>);
const ids = (html: string) => [...html.matchAll(/data-agent="([^"]+)"/g)].map((match) => match[1]).sort();
const sleeping = snapshot.workspaces!.filter((workspace) => workspace.asleep);
const sleepingRows = snapshot.agents.filter((agent) => agent.workspaceId === 'sleeping');

describe('Dashboard shows active workspaces only', () => {
    it.each(['workspace', 'status'] as const)('%s grouping hides hibernated agents and excludes them from every status chip', (group) => {
        const html = render({ group, focusedId: 'sleep-working', revealId: 'sleep-working', trayId: 'sleep-working' });
        expect(ids(html)).toEqual(['active-idle', 'active-working', 'genie']);
        expect(html).not.toContain('Hibernated workspace'); expect(html).not.toContain('/fixture/sleeping');
        expect(html).toMatch(/data-chip="working"[^>]*>[\s\S]*?2 working/);
        expect(html).toMatch(/data-chip="idle"[^>]*>[\s\S]*?1 idle/);
        expect(html).not.toContain('data-chip="waiting"'); expect(html).not.toContain('data-chip="remote"');
        expect(html).not.toContain('data-legend'); expect(html).not.toContain('data-focused="true"');
    });

    it('keeps active empty-workspace groups without retaining hibernated empty ones', () => {
        const html = render();
        expect(html).toContain('data-workspace="active-empty"'); expect(html).toContain('Active empty');
        expect(html).toContain('No agents');
        expect(html).not.toContain('data-workspace="sleeping-empty"'); expect(html).not.toContain('Hibernated empty');
    });

    it.each(['workspace', 'status'] as const)('with every workspace asleep, %s grouping retains genie and offers an honest empty state', (group) => {
        const html = render({ group, workspaces: sleeping, rows: sleepingRows });
        expect(ids(html)).toEqual(['genie']);
        expect(html).toContain('data-dashboard-no-active-workspaces'); expect(html).toContain('No active workspaces');
        expect(html).not.toContain('data-dashboard="first-run"');
        expect(html).toMatch(/data-chip="working"[^>]*>[\s\S]*?1 working/);
        expect(html).not.toContain('data-chip="idle"');
    });

    it('does not count hidden agents when all workspaces are asleep and genie has not been read', () => {
        const html = render({ workspaces: sleeping, rows: sleepingRows, genie: null });
        expect(ids(html)).toEqual([]); expect(html).not.toContain('data-chip=');
        expect(html).toContain('data-dashboard-no-active-workspaces'); expect(html).not.toContain('Add a workspace');
    });

    it('CONTROL: active workspaces with absent or false asleep flags and their agents remain visible', () => {
        const workspaces = [{ id: 'legacy', path: '/fixture/legacy' }, { id: 'awake', path: '/fixture/awake', asleep: false }];
        const html = render({ workspaces, rows: [row('legacy-agent', 'legacy'), row('awake-agent', 'awake')], genie: null });
        expect(ids(html)).toEqual(['awake-agent', 'legacy-agent']);
        expect(html).toContain('data-workspace="legacy"'); expect(html).toContain('data-workspace="awake"');
        expect(html).toMatch(/data-chip="working"[^>]*>[\s\S]*?2 working/);
    });

    it('a newly awakened workspace reappears with its agents and status counts', () => {
        const html = render({ workspaces: snapshot.workspaces!.map((workspace) => ({ ...workspace, asleep: false })) });
        expect(ids(html)).toEqual(['active-idle', 'active-working', 'genie', 'sleep-remote', 'sleep-waiting', 'sleep-working']);
        expect(html).toContain('data-workspace="sleeping"'); expect(html).toContain('data-workspace="sleeping-empty"');
        expect(html).toContain('data-chip="waiting"'); expect(html).toContain('data-chip="remote"');
    });

    it('status grouping retains agents whose workspace is missing from the registry', () => {
        const html = render({ group: 'status', rows: [...snapshot.agents, row('orphan-agent', 'unregistered')] });
        expect(ids(html)).toEqual(['active-idle', 'active-working', 'genie', 'orphan-agent']);
        expect(html).toMatch(/data-chip="working"[^>]*>[\s\S]*?3 working/);
        expect(html).not.toContain('data-agent="sleep-working"');
    });

    it('an orphan from separately persisted registry files remains visible by status', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-dashboard-orphan-'));
        try {
            const store = new Store(dir);
            await store.writeWorkspaces([{ id: 'active', path: '/fixture/active' }]);
            const orphan = agentRecord({ id: mintAgentId(), workspaceId: 'unregistered', name: 'persisted-orphan', provider: 'codex' });
            await store.writeAgents([orphan]);
            const registry = new Registry(store); await registry.load({ name: 'fixture', healthy: true });
            const restored = registry.snapshot();
            expect(restored.workspaces?.map((workspace) => workspace.id)).toEqual(['active']);
            expect(restored.agents.map((agent) => agent.id)).toContain(orphan.id);
            const html = render({ workspaces: restored.workspaces, rows: restored.agents, genie: restored.osAgent ?? null, group: 'status' });
            expect(ids(html)).toContain(orphan.id);
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('CONTROL: unknown workspace data stays loading and a truly empty registry keeps first-run onboarding', () => {
        expect(render({ workspaces: null })).toContain('data-dashboard="loading"');
        expect(render({ workspaces: [] })).toContain('data-dashboard="first-run"');
    });

    it('the full snapshot reaches Dashboard without removing hibernated workspace navigation from the rail', () => {
        const html = renderToStaticMarkup(<Shell route="genie://dashboard?group=workspace" snapshot={snapshot}
            servable={['dashboard', 'deck', 'agent', 'workspace']} agentDetail={null} agentResolved={false}
            selectedRowId={null} chatThread={null} pinned={null} onNavigate={() => {}} onOpenAgent={() => {}}
            onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}}
            onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
        />);
        expect(html).toContain('data-rail-tool="hibernated"'); expect(html).toContain('Show 2 hibernated workspaces');
        expect(html).toContain('data-agent="active-working"'); expect(html).not.toContain('data-agent="sleep-working"');
        expect(snapshot.workspaces!.filter((workspace) => workspace.asleep)).toHaveLength(2);
    });
});

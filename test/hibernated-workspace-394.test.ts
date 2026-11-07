import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HostRegistry } from '../src/main/host-registry.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { filterSnapshotForWorkspace } from '../src/core/remote-protocol.js';
import { doctorDataTools } from '../src/main/doctor-data.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { genieTools } from '../src/main/mcp-tools.js';

let dir: string;
let store: Store;
let registry: Registry;
let awake: AgentRecord;
let ghost: AgentRecord;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-394-'));
    store = new Store(dir);
    awake = agentRecord({ id: mintAgentId(), workspaceId: 'awake', name: 'Active', provider: 'claude' });
    ghost = agentRecord({ id: mintAgentId(), workspaceId: 'ghost', name: 'Dormant', provider: 'codex', accessScope: 'all' });
    await store.writeWorkspaces([{ id: 'awake', path: '/awake' }, { id: 'ghost', path: '/ghost', asleep: true }]);
    await store.writeAgents([awake, ghost]);
    registry = new Registry(store);
    await registry.load({ name: 'test', healthy: true });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('story 394: a hibernated workspace supplies no data', () => {
    it('a hidden duplicate name cannot shadow an active public mail address', async () => {
        await store.writeWorkspaces([{ id: 'ghost', path: '/ghost', asleep: true }, { id: 'awake', path: '/awake' }]);
        await store.writeAgents([{ ...awake, name: 'Dormant' }, ghost]); await registry.refresh();
        registry.setWorkspaceNamer(() => 'ghost');
        const refusal = (registry as unknown as { mailRefusal?: (text: string) => string | null }).mailRefusal;
        expect(refusal?.call(registry, 'Dormant@ghost')).toBeNull();
        const host = new HostRegistry(store); await host.refresh(); host.setNames(new Map([['awake', 'ghost'], ['ghost', 'ghost']]));
        expect((host as unknown as { mailRefusal?: (text: string) => string | null }).mailRefusal?.('Dormant@ghost')).toBeNull();
    });
    it('child windows can follow workspace visibility without subscribing to every agent activity snapshot', async () => {
        const subscribe = (registry as unknown as { subscribeWorkspaceVisibility?: (listener: (snapshot: ReturnType<Registry['snapshot']>) => void) => () => void }).subscribeWorkspaceVisibility;
        expect(typeof subscribe).toBe('function');
        const seen = vi.fn(); const off = subscribe!.call(registry, seen);
        registry.touch(); expect(seen).not.toHaveBeenCalled();
        await registry.setAsleep('ghost', false); expect(seen).toHaveBeenCalledOnce();
        expect(seen.mock.calls[0]![0].workspaces.map((w: { id: string }) => w.id)).toContain('ghost');
        registry.touch(); expect(seen).toHaveBeenCalledOnce();
        await registry.setAsleep('ghost', true); expect(seen).toHaveBeenCalledTimes(2);
        expect(seen.mock.calls[1]![0].workspaces.map((w: { id: string }) => w.id)).not.toContain('ghost');
        off(); await registry.setAsleep('ghost', false); expect(seen).toHaveBeenCalledTimes(2);
    });
    it('a failed redock metadata write leaves the workspace hidden in memory and on disk', async () => {
        vi.spyOn(store, 'writeWorkspaces').mockRejectedValueOnce(new Error('disk refused the redock'));
        await expect(registry.setAsleep('ghost', false)).rejects.toThrow('disk refused');
        expect(registry.workspace('ghost')?.asleep).toBe(true);
        expect(registry.listAgents().map((a) => a.id)).not.toContain(ghost.id);
        expect((await store.readWorkspaces()).find((w) => w.id === 'ghost')?.asleep).toBe(true);
    });
    it('keeps the last awake display name and mail slug across restart without reopening the ghost folder', async () => {
        await registry.setAsleep('ghost', false);
        registry.setWorkspaceNamer((path) => path === '/ghost' ? 'Named project' : 'Awake');
        await registry.setAsleep('ghost', true);
        const reopened = new Registry(store);
        const namer = vi.fn((path: string) => { if (path === '/ghost') throw new Error('ghost folder was read'); return 'Awake'; });
        reopened.setWorkspaceNamer(namer); await reopened.load({ name: 'test', healthy: true });
        const hidden = (reopened.snapshot() as unknown as { hibernatedWorkspaces?: readonly { id: string; name: string }[] }).hibernatedWorkspaces;
        expect(hidden?.find((w) => w.id === 'ghost')?.name).toBe('Named project');
        const refusal = (reopened as unknown as { mailRefusal?: (text: string) => string | null }).mailRefusal;
        expect(refusal?.call(reopened, 'Dormant@named-project')).toBe("Dormant's workspace is hibernated; redock it first");
        const host = new HostRegistry(store); await host.refresh();
        expect((host as unknown as { mailRefusal?: (text: string) => string | null }).mailRefusal?.('Dormant@named-project')).toBe("Dormant's workspace is hibernated; redock it first");
        expect(namer.mock.calls.flat()).not.toContain('/ghost');
    });
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
    it('the real AgentInbox list includes an awake peer but never a ghost peer', async () => {
        const host = new HostRegistry(store); await host.refresh();
        const inbox = await InboxStore.open(dir), attention = await AttentionStore.open(dir, inbox);
        const tools = genieTools({ inbox, attention, roster: () => host.listAgents(), workspaceSlugs: () => host.workspaceSlugs(),
            resolveCaller: () => ({ agentId: registry.osAgent()!.id, agentName: 'genie', workspaceId: registry.osAgent()!.workspaceId, workspacePath: dir }),
            userActive: () => true, glow: () => true, thumbsUp: () => {},
        });
        const answer = await tools.find((t) => t.definition.name === 'agentinbox')!.handler({ action: 'list', terminalId: 'test' }, { server: 'genie', tool: 'agentinbox', headers: {} });
        expect(answer.isError).toBe(false);
        const peers = (JSON.parse(answer.text) as { peers: { workspaceId: string }[] }).peers;
        expect(peers.map((p) => p.workspaceId)).toContain('awake');
        expect(peers.map((p) => p.workspaceId)).not.toContain('ghost');
    });
    it('the OS doctor workspace/agent views exclude ghosts too', async () => {
        const tools = doctorDataTools({ genieHome: dir });
        const invoke = async (name: string, args: Record<string, string>) => tools.find((t) => t.definition.name === name)!.handler(args, { server: 'genie', tool: name, headers: {} });
        const list = await invoke('workspaces', {});
        expect(list.isError).toBe(false);
        expect(list.text).toContain(awake.name);
        expect(list.text).not.toContain(ghost.name);
        expect(list.text).not.toContain('"ghost"');
        expect((await invoke('loadWorkspace', { workspace: 'ghost' })).isError).toBe(true);
        expect((await invoke('loadAgent', { workspace: 'ghost', agent: ghost.name })).isError).toBe(true);
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

it('workspace-scoped remote snapshots cannot leak another workspace’s sidebar ghost metadata', () => {
    const snapshot = { agents: [], workspaces: [{ id: 'awake' }], hibernatedWorkspaces: [{ id: 'ghost', path: '/ghost', asleep: true }], deckItems: [] };
    const scoped = filterSnapshotForWorkspace(snapshot, 'awake');
    expect(scoped.workspaces).toEqual([{ id: 'awake' }]);
    expect(scoped.hibernatedWorkspaces).toEqual([]);
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
    it('an acknowledgement for an older redock cannot clear a newer marker', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-11-06T20:00:00.000Z'));
            await registry.setAsleep('ghost', false);
            const first = (registry.find(ghost.id) as unknown as { redockAt?: string }).redockAt;
            await registry.setAsleep('ghost', true);
            vi.setSystemTime(new Date('2026-11-06T21:00:00.000Z'));
            await registry.setAsleep('ghost', false);
            const second = (registry.find(ghost.id) as unknown as { redockAt?: string }).redockAt;
            expect(second).toEqual(expect.any(String)); expect(second).not.toBe(first);
            const clear = (registry as unknown as { clearRedock?: (id: string, at: string) => Promise<void> }).clearRedock;
            expect(typeof clear).toBe('function');
            await clear!.call(registry, ghost.id, first!);
            expect(registry.find(ghost.id)).toHaveProperty('redockAt', second);
            await clear!.call(registry, ghost.id, second!);
            expect(registry.find(ghost.id)).not.toHaveProperty('redockAt');
            expect(registry.find(awake.id)).not.toHaveProperty('redockAt');
        } finally { vi.useRealTimers(); }
    });
});

it.each(['Dormant', 'Dormant@ghost', 'id'])('story394: mail addressed to a ghost by %s is refused explicitly, never silently queued, and works after redock', async (address) => {
    const host = new HostRegistry(store); await host.refresh();
    const inbox = await InboxStore.open(dir), attention = await AttentionStore.open(dir, inbox);
    const tools = genieTools({ inbox, attention, roster: () => host.listAgents(), workspaceSlugs: () => host.workspaceSlugs(),
        resolveCaller: () => ({ agentId: awake.id, agentName: awake.name, workspaceId: 'awake', workspacePath: dir }),
        userActive: () => true, glow: () => true, thumbsUp: () => {},
        refusalForRecipient: (text: string) => (host as unknown as { mailRefusal?: (address: string) => string | null }).mailRefusal?.(text) ?? null,
    } as never);
    const tool = tools.find((entry) => entry.definition.name === 'agentinbox')!;
    const args = { action: 'send', terminalId: 'test', to: address === 'id' ? ghost.id : address, text: 'Work for ghost' };
    const answer = await tool.handler(args, { server: 'genie', tool: 'agentinbox', headers: {} });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Dormant's workspace is hibernated; redock it first");
    expect(inbox.all().some((message) => message.to === ghost.id)).toBe(false);
    await store.writeWorkspaces([{ id: 'awake', path: '/awake' }, { id: 'ghost', path: '/ghost', asleep: false }]);
    await host.refresh();
    expect((await tool.handler(args, { server: 'genie', tool: 'agentinbox', headers: {} })).isError).toBe(false);
    expect(inbox.all().filter((message) => message.to === ghost.id)).toHaveLength(1);
});

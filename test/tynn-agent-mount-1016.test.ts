import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { tynnAgentIdentities } from '../src/main/tynn-agent-identities.js';

/*
 * MOUNTING A SHARED AGENT (Tynn #1016; the owner's ruling #1003, 2026-11-21: agents belong to a shareable workspace, not
 * a machine; their MCP keys are minted per USER on mount in Genie). Machine A made `atlas` and Tynn registered it with A's
 * local id. Machine B imported the workspace from Tynn and has its own local `atlas`, with its own id and no binding. It
 * was refused as "another Tynn agent already uses this name" (P8 measurement, run-1124-220028.log b8/c9). Now B binds to
 * Tynn's agent of the SAME name, gets a key of its own, and takes the settings Tynn holds for it. Two LOCAL agents on one
 * machine still never share one Tynn identity.
 */

const PROJECT = 'project-42';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-mount-1016-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

type Remote = { id: string; name: string; external_id: string | null; status: string; config: Record<string, unknown> | null; tokens: Array<{ id: string; public_id: string; active: boolean }> };

/** One Tynn (one project) that several machines talk to, each with its own vault and keychain. */
function fakeTynn() {
    const agents: Remote[] = [];
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const state = { userId: 'user-7', registered: 0, minted: 0 };
    const answer = (status: number, body: unknown) => { const text = JSON.stringify(body); return { ok: status < 300, status, json: async () => JSON.parse(text) as unknown }; };
    const tynn = {
        status: () => ({ signedIn: true }), userId: () => state.userId, savedUserId: () => state.userId,
        request: async (path: string, init: { method: string; body?: any }) => {
            calls.push({ path, method: init.method, body: init.body });
            const base = `/api/v1/projects/${PROJECT}/agents`;
            if (path === base && init.method === 'GET') return answer(200, { project_id: PROJECT, agents });
            if (path === base && init.method === 'POST') {
                state.registered++;
                let row = agents.find((a) => a.name.toLowerCase() === init.body.name.toLowerCase());
                if (!row) { row = { id: `remote-${agents.length + 1}`, name: init.body.name, external_id: null, status: 'active', config: null, tokens: [] }; agents.push(row); }
                row.external_id = init.body.external_id; row.config = init.body.config;
                return answer(201, { created: true, agent: row });
            }
            const one = path.startsWith(`${base}/`) ? agents.find((a) => a.id === decodeURIComponent(path.slice(base.length + 1))) : undefined;
            if (one && init.method === 'PATCH') { if (init.body.config !== undefined) one.config = init.body.config; return answer(200, { agent: one }); }
            if (path === '/api/v1/projects/agent-token' && init.method === 'POST') {
                const row = agents.find((a) => a.name.toLowerCase() === String(init.body.agent_name).toLowerCase());
                if (!row) return answer(404, {});
                state.minted++;
                const publicId = String(state.minted).padStart(26, '0');
                row.tokens.push({ id: `key-${state.minted}`, public_id: publicId, active: true });
                return answer(200, { token: `rpk_${publicId}.${state.minted.toString(16).repeat(64).slice(0, 64)}`, agent: { id: row.id, name: row.name }, mcp_url: 'https://tynn.ai/mcp/tynn' });
            }
            return answer(404, {});
        },
    };
    return { agents, calls, state, tynn };
}

/** One workstation: its own vault file and keychain, and the agents it has locally. */
function machine(name: string, local: AgentRecord[] = []) {
    const held = new Map<string, string>();
    const secrets = {
        probe: async () => ({ ok: true as const }),
        get: async (n: string) => { const v = held.get(n); return v === undefined ? { kind: 'missing' as const } : { kind: 'value' as const, value: v }; },
        set: async (n: string, v: string) => { held.set(n, v); return { ok: true as const }; },
    };
    const vault = tynnAgentIdentities({ file: join(dir, name, 'agents.json'), secrets, isLocalAgent: (id: string) => local.some((a) => a.id === id) } as never);
    return { vault, local };
}
const atlas = (over: Partial<AgentRecord> = {}): AgentRecord => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', name: 'atlas', provider: 'claude', instructions: '.agents/atlas/AGENT.md' }), ...over });
const ensure = (m: ReturnType<typeof machine>, agent: AgentRecord, t: ReturnType<typeof fakeTynn>) => m.vault.ensure({ projectId: PROJECT, agent, tynn: t.tynn as never });

describe('an agent with no Tynn binding mounts Tynn’s agent of the same name (Tynn #1016)', () => {
    it('A registers its settings, including autoApprove and accessScope', async () => {
        const t = fakeTynn();
        const a = atlas({ permissions: 'ask', mode: 'manual', autoApprove: true, accessScope: 'all' });
        expect(await ensure(machine('A', [a]), a, t)).toMatchObject({ status: 'minted' });
        expect(t.agents[0]?.config).toEqual({ provider: 'claude', instructions: '.agents/atlas/AGENT.md', permissions: ['ask'], mode: 'manual', auto_approve: true, access_scope: 'all' });
    });

    it('B, another machine of the same person, gets a key of its own for A’s agent and A’s settings; nothing is registered again', async () => {
        const t = fakeTynn();
        const a = atlas({ permissions: 'ask', mode: 'automated', autoApprove: true, accessScope: 'none', model: 'opus' });
        const first = await ensure(machine('A', [a]), a, t);
        const b = atlas(); // B's own local atlas: its own id, the defaults
        const onB = machine('B', [b]);
        const mounted = await ensure(onB, b, t);
        expect(mounted).toMatchObject({ status: 'minted', remoteAgentId: 'remote-1', adopted: { permissions: 'ask', mode: 'automated', autoApprove: true, accessScope: 'none', model: 'opus' } });
        expect('mcp' in mounted && 'mcp' in first && mounted.mcp.token).not.toBe('mcp' in first ? first.mcp.token : null);
        expect(t.state.registered).toBe(1);
        expect(t.state.minted).toBe(2);
        expect(t.agents).toHaveLength(1);
        expect(t.agents[0]?.external_id, 'A’s identity is not taken over').toBe(a.id);
        // B's next start uses the key it holds, checked with Tynn; nothing is minted again, and no settings are applied again.
        const again = await ensure(onB, b, t);
        expect(again).toMatchObject({ status: 'already', remoteAgentId: 'remote-1' });
        expect('adopted' in again).toBe(false);
        expect(t.state.minted).toBe(2);
    });

    it('a model Tynn holds for another provider is not applied to B’s agent', async () => {
        const t = fakeTynn();
        const a = atlas({ provider: 'codex', model: 'gpt-5' });
        await ensure(machine('A', [a]), a, t);
        const b = atlas();
        const mounted = await ensure(machine('B', [b]), b, t);
        expect(mounted.status).toBe('minted');
        expect((mounted as { adopted?: Record<string, unknown> }).adopted).not.toHaveProperty('model');
    });

    it('SAME MACHINE: a second local agent of that name is refused while the first is on this machine', async () => {
        const t = fakeTynn();
        const a = atlas(); const twin = atlas();
        const onA = machine('A', [a, twin]);
        await ensure(onA, a, t);
        expect(await ensure(onA, twin, t)).toMatchObject({ status: 'failed', code: 'conflict' });
        expect(t.state.minted).toBe(1);
    });

    it('SAME MACHINE: refused also when this vault already binds that Tynn agent to another local agent', async () => {
        const t = fakeTynn();
        const a = atlas(); const b = atlas(); const twin = atlas();
        await ensure(machine('A', [a]), a, t);
        const onB = machine('B', [b]); // the vault knows b's binding; twin is not in the registry list given
        await ensure(onB, b, t);
        onB.local.splice(0, onB.local.length, twin);
        expect(await ensure(onB, twin, t)).toMatchObject({ status: 'failed', code: 'conflict' });
        expect(t.state.minted).toBe(2);
    });

    it('a name that differs only in case is still a conflict, never a mount', async () => {
        const t = fakeTynn();
        const a = atlas(); await ensure(machine('A', [a]), a, t);
        const b = atlas({ name: 'ATLAS' });
        expect(await ensure(machine('B', [b]), b, t)).toMatchObject({ status: 'failed', code: 'conflict' });
        expect(t.state.minted).toBe(1);
    });

    it('a suspended Tynn agent is not mounted', async () => {
        const t = fakeTynn();
        const a = atlas(); await ensure(machine('A', [a]), a, t);
        t.agents[0]!.status = 'suspended';
        const b = atlas();
        expect(await ensure(machine('B', [b]), b, t)).toMatchObject({ status: 'failed', code: 'inactive' });
        expect(t.state.minted).toBe(1);
    });
});

describe('later setting changes go to Tynn (Tynn #1001)', () => {
    it('a bound agent’s settings are sent to its Tynn agent; on B they reach the same shared agent', async () => {
        const t = fakeTynn();
        const a = atlas(); const onA = machine('A', [a]);
        await ensure(onA, a, t);
        expect(await onA.vault.push({ projectId: PROJECT, agent: { ...a, permissions: 'edits', autoApprove: true }, tynn: t.tynn as never })).toBe('sent');
        expect(t.calls.at(-1)).toMatchObject({ path: `/api/v1/projects/${PROJECT}/agents/remote-1`, method: 'PATCH' });
        expect(t.agents[0]?.config).toMatchObject({ permissions: ['edits'], auto_approve: true, access_scope: 'self' });

        const b = atlas(); const onB = machine('B', [b]);
        await ensure(onB, b, t);
        expect(await onB.vault.push({ projectId: PROJECT, agent: { ...b, accessScope: 'all' }, tynn: t.tynn as never })).toBe('sent');
        expect(t.agents[0]?.config).toMatchObject({ access_scope: 'all' });
    });

    it('an agent with no binding on this machine sends nothing', async () => {
        const t = fakeTynn();
        const a = atlas();
        expect(await machine('A', [a]).vault.push({ projectId: PROJECT, agent: a, tynn: t.tynn as never })).toBe('unbound');
        expect(t.calls).toHaveLength(0);
    });
});

/*
 * THE HOST'S HALF. A mounted agent takes Tynn's settings BEFORE its first session is handed its servers: its tool setting
 * and autonomy are read live from its record (session-host), so the first session already runs under A's settings, not
 * B's defaults. And a later change on any door reaches Tynn: the host watches its agents and sends what changed.
 */
describe('the host applies a mounted agent’s settings and sends later changes', () => {
    it('agentTynnPrep hands the adopted settings to the host before it returns the agent’s servers', async () => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const { agentTynnPrep } = await import('../src/main/agent-tynn-prep.js');
        const t = fakeTynn();
        const a = atlas({ permissions: 'edits', autoApprove: true, accessScope: 'none' });
        await ensure(machine('A', [a]), a, t);
        const ws = join(dir, 'ws'); await mkdir(ws);
        await writeFile(join(ws, 'project.json'), JSON.stringify({ tynn: { projectId: PROJECT } }));
        const b = atlas();
        const order: string[] = [];
        const held = new Map<string, string>();
        const prep = agentTynnPrep({
            vaultFile: join(dir, 'B', 'agents.json'),
            secrets: { probe: async () => ({ ok: true as const }), get: async (n: string) => { const v = held.get(n); return v === undefined ? { kind: 'missing' as const } : { kind: 'value' as const, value: v }; }, set: async (n: string, v: string) => { held.set(n, v); return { ok: true as const }; } },
            tynn: () => t.tynn as never,
            workspaces: () => [{ id: 'ws', path: ws }],
            isLocalAgent: (id: string) => id === b.id,
            onAdopted: async (agent: AgentRecord, settings: unknown) => { order.push(`adopted ${agent.id} ${JSON.stringify(settings)}`); },
        } as never);
        const servers = await prep.prepare(b, new AbortController().signal);
        order.push('servers');
        expect(servers.map((s) => s.name)).toEqual(['tynn']);
        expect(order).toEqual([`adopted ${b.id} ${JSON.stringify({ permissions: 'edits', mode: 'manual', autoApprove: true, accessScope: 'none' })}`, 'servers']);
    });

    it('agentTynnSync sends a changed agent, not an unchanged one, and tries a failed send again', async () => {
        const { agentTynnSync } = await import('../src/main/agent-tynn-sync.js');
        let roster: AgentRecord[] = [atlas(), atlas({ name: 'bolt' })];
        const sent: string[] = [];
        let answer: 'sent' | 'failed' = 'sent';
        const sync = agentTynnSync({ agents: () => roster, push: async (agent) => { sent.push(`${agent.name}:${agent.permissions ?? 'all'}:${agent.autoApprove === true}:${agent.accessScope}`); return answer; } });
        sync.prime();
        await sync.changed();
        expect(sent, 'nothing changed, nothing sent').toEqual([]);
        roster = [{ ...roster[0]!, permissions: 'ask' }, roster[1]!];
        answer = 'failed';
        await sync.changed();
        expect(sent).toEqual(['atlas:ask:false:self']);
        answer = 'sent';
        await sync.changed();
        expect(sent, 'a send that failed is tried again').toEqual(['atlas:ask:false:self', 'atlas:ask:false:self']);
        await sync.changed();
        expect(sent).toHaveLength(2);
        roster = [roster[0]!, { ...roster[1]!, autoApprove: true, accessScope: 'all' }, atlas({ name: 'cleo' })];
        await sync.changed();
        expect(sent, 'a new agent is registered with its settings when it is first bound, not sent here').toEqual(['atlas:ask:false:self', 'atlas:ask:false:self', 'bolt:all:true:all']);
        roster = [roster[0]!, roster[1]!, { ...roster[2]!, lastUsedAt: new Date().toISOString(), threadId: 't1' }];
        await sync.changed();
        expect(sent, 'what is not a setting is not sent').toHaveLength(3);
    });
});

/*
 * ONE WRITE (harness run-1124-225604.log, b9/b10): the mounted settings were written one setter at a time, so the host's
 * settings sync sent Tynn each half-applied state — B's default autoApprove overwrote A's in Tynn — and each write was one
 * more chance for a stale whole-registry write from the window to land between them. They are written as one change.
 */
describe('a mounted agent’s settings are one registry write', () => {
    /** One registry over a Store on disk; every change it sends is counted on the store itself (Tynn #1007: the only write). */
    async function rig(seed: AgentRecord) {
        const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
        const { Registry } = await import('../src/main/registry.js');
        const { Store } = await import('../src/main/store.js');
        const home = join(dir, 'home'); await mk(join(home, 'runtime'), { recursive: true });
        await wf(join(home, 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'ws', path: home }]));
        await wf(join(home, 'runtime', 'agents.json'), JSON.stringify([seed]));
        const store = new Store(home);
        const changes: Array<Parameters<typeof store.changeAgents>[0]> = [];
        // Counted on the store itself (a Proxy cannot reach its private fields).
        const change = store.changeAgents.bind(store);
        store.changeAgents = async (c) => { changes.push(c); return change(c); };
        const open = async () => { const r = new Registry(store); await r.load({ name: 'fixture', healthy: true }); return r; };
        return { store, changes, open };
    }

    it('applyMountedSettings sends permissions, mode, autoApprove, accessScope and model as ONE per-record change, never a whole list', async () => {
        const b = atlas();
        const { store, changes, open } = await rig(b);
        const registry = await open();
        changes.length = 0;
        const after = await registry.applyMountedSettings(b.id, { permissions: 'edits', mode: 'automated', autoApprove: true, accessScope: 'all', model: 'opus' });
        expect(changes).toHaveLength(1);
        expect(changes[0]).toEqual({ patch: [{ id: b.id, set: { permissions: 'edits', mode: 'automated', autoApprove: true, accessScope: 'all', model: 'opus' } }] });
        expect(after).toMatchObject({ permissions: 'edits', mode: 'automated', autoApprove: true, accessScope: 'all', model: 'opus' });
        expect((await store.readAgents()).find((a) => a.id === b.id)).toMatchObject({ permissions: 'edits', mode: 'automated', autoApprove: true, accessScope: 'all', model: 'opus' });
        // Nothing Tynn holds: nothing is written, nothing changes.
        changes.length = 0;
        const c = await registry.applyMountedSettings(b.id, {});
        expect(changes).toHaveLength(0);
        expect(c).toMatchObject({ permissions: 'edits' });
    });

    it('a setting Tynn holds lands even when this copy is behind and already shows that value (a set field always crosses, #1007)', async () => {
        const b = atlas({ mode: 'manual', autoApprove: false });
        const { store, changes, open } = await rig(b);
        const stale = await open(); // shows manual, autoApprove false
        const other = await open();
        await other.setMode(b.id, 'automated');
        await other.setAutoApprove(b.id, true);
        changes.length = 0;
        // Tynn holds manual and autoApprove false: this copy already shows exactly that, and is behind the files.
        await stale.applyMountedSettings(b.id, { mode: 'manual', autoApprove: false });
        expect(changes).toEqual([{ patch: [{ id: b.id, set: { mode: 'manual', autoApprove: false } }] }]);
        expect((await store.readAgents()).find((a) => a.id === b.id)).toMatchObject({ mode: 'manual', autoApprove: false });
        expect(stale.find(b.id)).toMatchObject({ mode: 'manual', autoApprove: false });
    });
});

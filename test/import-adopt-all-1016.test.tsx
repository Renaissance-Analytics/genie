import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importedAgents } from '../src/core/agent-adoption.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { adoptAgents, readImportedAgents, type AgentAdoptionPorts } from '../src/main/agent-adoption-host.js';
import { agentTynnSync } from '../src/main/agent-tynn-sync.js';
import { tynnAgentIdentities } from '../src/main/tynn-agent-identities.js';
import { ImportedAgentsView } from '../src/renderer/components/ImportedAgents.js';

/*
 * IMPORTING A WORKSPACE FROM TYNN BRINGS ITS AGENTS (Tynn #1016, #1001; the owner's ruling 2026-11-25, P8: moving a workspace
 * is syncing it to Tynn and importing it from Tynn on another workstation). The P8 measurement (run-1124-220028.log) found
 * an imported workspace offered only the agents its repo's `.agents/` held — none, until A committed and pushed them by
 * hand (a9) — and each had to be adopted one at a time (b6). And A's agents reached Tynn only at their first start (a6).
 *
 * Now: an agent is registered in Tynn when it is CREATED; the import offers the agents Tynn has for the project as well as
 * those on disk; and one step adopts them all, with a per-agent opt-out, each mounted at once (its own key, Tynn's settings).
 */

// ---------------------------------------------------------------------------------------------------------------- core

describe('the offer lists Tynn’s agents for the project, not only the repo’s .agents/', () => {
    it('a Tynn agent with no folder here is offered, on the provider Tynn holds, marked as coming from Tynn', () => {
        const list = importedAgents({
            files: [{ folder: 'atlas' }],
            registered: [],
            tynn: [{ name: 'atlas', provider: 'claude', instructions: '.agents/atlas/AGENT.md' }, { name: 'bolt', provider: 'codex', instructions: '.agents/bolt/AGENT.md' }, { name: 'Cleo Smith', provider: 'claude', instructions: null }],
        });
        expect(list.map((a) => [a.name, a.provider, a.instructions, a.refusal === null, a.fromTynn === true])).toEqual([
            ['atlas', 'claude', '.agents/atlas/AGENT.md', true, false],
            ['bolt', 'codex', '.agents/bolt/AGENT.md', true, true],
        ]);
    });

    it('a Tynn agent already registered here is not offered again (any case)', () => {
        const list = importedAgents({ files: [], registered: [{ name: 'Bolt' }], tynn: [{ name: 'bolt', provider: 'claude', instructions: null }] });
        expect(list).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------------------- host

function fakes(tynn: Array<{ name: string; provider: string | null; instructions: string | null; purpose?: string | null }> | null) {
    const root = '/w/acme.agi';
    const files: Record<string, string> = { [`${root}/project.json`]: `${JSON.stringify({ name: 'acme', tynn: { projectId: 'p1' } }, null, 2)}\n` };
    let agents: Array<{ id: string; workspaceId: string; name: string }> = [];
    const registered: Array<{ workspaceId: string; provider: string; name: string; instructions?: string | null }> = [];
    const mounted: string[] = [];
    const made: string[] = [];
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports: AgentAdoptionPorts = {
        workspace: (id) => (id === 'acme' ? { id, path: root } : null),
        agentsOf: (id) => agents.filter((a) => a.workspaceId === id),
        listDirs: async (p) => { if (key(p) !== `${root}/.agents`) throw new Error('ENOENT'); return Object.keys(files).filter((f) => f.startsWith(`${root}/.agents/`)).map((f) => f.split('/')[4]!); },
        readText: async (p) => files[key(p)] ?? null,
        writeTextAtomic: async (p, text) => { files[key(p)] = text; },
        mkdirp: async (dir) => { made.push(key(dir)); },
        register: async (input) => {
            registered.push(input);
            const id = `agent_new_${registered.length}`;
            agents = [...agents, { id, workspaceId: input.workspaceId, name: input.name }];
            return { id, name: input.name };
        },
        tynnAgents: async () => tynn,
        mount: async (id) => { mounted.push(id); },
    };
    return { ports, files, registered, mounted, made, root };
}

describe('adopting them all in one step (Tynn #1016)', () => {
    it('reads Tynn’s agents for a Tynn-linked workspace whose clone has no .agents/', async () => {
        const f = fakes([{ name: 'atlas', provider: 'claude', instructions: '.agents/atlas/AGENT.md' }, { name: 'bolt', provider: 'claude', instructions: '.agents/bolt/AGENT.md' }]);
        const r = await readImportedAgents(f.ports, 'acme');
        expect(r.ok && r.agents.map((a) => a.name)).toEqual(['atlas', 'bolt']);
    });

    it('adopts every offered agent but the ones opted out, writes the persona a Tynn-only agent lacks, and mounts each at once', async () => {
        const f = fakes([
            { name: 'atlas', provider: 'claude', instructions: '.agents/atlas/AGENT.md', purpose: 'Plans the work' },
            { name: 'bolt', provider: 'codex', instructions: '.agents/bolt/AGENT.md' },
            { name: 'cleo', provider: 'claude', instructions: '.agents/cleo/AGENT.md' },
        ]);
        f.files[`${f.root}/.agents/bolt/AGENT.md`] = '# bolt\n\nHand-written persona.\n';
        const r = await adoptAgents(f.ports, 'acme', { except: ['cleo'] });
        expect(r).toMatchObject({ ok: true, adopted: [{ name: 'atlas', id: 'agent_new_1' }, { name: 'bolt', id: 'agent_new_2' }], refused: [] });
        expect(f.registered.map((x) => [x.name, x.provider, x.instructions])).toEqual([['atlas', 'claude', '.agents/atlas/AGENT.md'], ['bolt', 'codex', '.agents/bolt/AGENT.md']]);
        expect(f.mounted).toEqual(['agent_new_1', 'agent_new_2']);
        // A persona that was missing is written; one that exists is never rewritten.
        expect(f.files[`${f.root}/.agents/atlas/AGENT.md`]).toContain('Plans the work');
        expect(f.files[`${f.root}/.agents/bolt/AGENT.md`]).toBe('# bolt\n\nHand-written persona.\n');
        expect(f.files[`${f.root}/.agents/cleo/AGENT.md`], 'an opted-out agent leaves nothing behind').toBeUndefined();
        const after = await readImportedAgents(f.ports, 'acme');
        expect(after.ok && after.agents.map((a) => a.name)).toEqual(['cleo']);
    });

    it('a mount that fails does not undo the adoption: it is said, and the agent mounts at its first start', async () => {
        const f = fakes([{ name: 'atlas', provider: 'claude', instructions: '.agents/atlas/AGENT.md' }]);
        f.ports.mount = async () => { throw new Error('Tynn could not be reached'); };
        const r = await adoptAgents(f.ports, 'acme', { except: [] });
        expect(r).toMatchObject({ ok: true, adopted: [{ name: 'atlas', mount: 'Tynn could not be reached' }] });
    });

    it('signed out (no Tynn list), only the repo’s agents are offered, as before', async () => {
        const f = fakes(null);
        f.files[`${f.root}/.agents/atlas/AGENT.md`] = '# atlas';
        const r = await readImportedAgents(f.ports, 'acme');
        expect(r.ok && r.agents.map((a) => [a.name, a.fromTynn === true])).toEqual([['atlas', false]]);
    });
});

// ---------------------------------------------------------------------------------------------------------------- the screen

type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}

describe('the screen adopts them all at once, with a per-agent opt-out', () => {
    const agents = importedAgents({ files: [], registered: [], tynn: [{ name: 'atlas', provider: 'claude', instructions: null }, { name: 'bolt', provider: 'claude', instructions: null }] });
    const base = { workspaceName: 'Acme', path: '/w/acme.agi', agents, busy: null, notice: null, error: null, onAdopt: () => {}, onOpen: () => {} };

    it('each agent has a keep switch, on by default, and one Adopt all button', () => {
        const html = renderToStaticMarkup(<ImportedAgentsView {...base} skipped={[]} onSkip={() => {}} onAdoptAll={() => {}} />);
        expect(html.match(/data-adopt-keep="/g)?.length).toBe(2);
        expect(html.match(/data-action="adopt-all"/g)?.length).toBe(1);
        expect(html).toContain('Adopt 2 agents');
    });

    it('Adopt all names the agents not opted out; the switch opts one out', () => {
        const did: string[] = [];
        const ui = ImportedAgentsView({ ...base, skipped: ['bolt'], onSkip: (name: string, skip: boolean) => did.push(`skip:${name}:${skip}`), onAdoptAll: (names: readonly string[]) => did.push(`all:${names.join(',')}`) });
        for (const b of findAll(ui, (p) => p['data-action'] === 'adopt-all')) (b.onClick as () => void)();
        for (const s of findAll(ui, (p) => p['data-adopt-keep'] === 'atlas')) (s.onCheckedChange as (v: boolean) => void)(false);
        expect(did).toEqual(['all:atlas', 'skip:atlas:true']);
        expect(renderToStaticMarkup(<ImportedAgentsView {...base} skipped={['bolt']} onSkip={() => {}} onAdoptAll={() => {}} />)).toContain('Adopt 1 agent');
    });
});

// ---------------------------------------------------------------------------------------------------------------- registered when created

const PROJECT = 'p1';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-import-1016-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function fakeTynn() {
    const agents: Array<{ id: string; name: string; external_id: string | null; status: string; config: unknown; tokens: unknown[] }> = [];
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const answer = (status: number, body: unknown) => { const text = JSON.stringify(body); return { ok: status < 300, status, json: async () => JSON.parse(text) as unknown }; };
    const tynn = {
        status: () => ({ signedIn: true }), userId: () => 'user-7', savedUserId: () => 'user-7',
        request: async (path: string, init: { method: string; body?: any }) => {
            calls.push({ path, method: init.method, body: init.body });
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'GET') return answer(200, { project_id: PROJECT, agents });
            if (path === `/api/v1/projects/${PROJECT}/agents` && init.method === 'POST') {
                const row = { id: `remote-${agents.length + 1}`, name: init.body.name, external_id: init.body.external_id, status: 'active', config: init.body.config, tokens: [] };
                agents.push(row); return answer(201, { created: true, agent: row });
            }
            return answer(404, {});
        },
    };
    return { agents, calls, tynn };
}
const vault = (name: string, local: AgentRecord[]) => tynnAgentIdentities({
    file: join(dir, name, 'agents.json'),
    secrets: { probe: async () => ({ ok: true as const }), get: async () => ({ kind: 'missing' as const }), set: async () => ({ ok: true as const }) },
    isLocalAgent: (id: string) => local.some((a) => a.id === id),
});
const agent = (name: string, over: Partial<AgentRecord> = {}): AgentRecord => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'acme', name, provider: 'claude', instructions: `.agents/${name}/AGENT.md` }), ...over });

describe('an agent is registered in Tynn when it is created, not at its first start (Tynn #1001)', () => {
    it('register sends the agent with its settings, and mints no key', async () => {
        const t = fakeTynn(); const a = agent('atlas', { permissions: 'ask', autoApprove: true });
        expect(await vault('A', [a]).register({ projectId: PROJECT, agent: a, tynn: t.tynn as never })).toBe('registered');
        expect(t.agents).toMatchObject([{ name: 'atlas', external_id: a.id, config: { permissions: ['ask'], auto_approve: true, access_scope: 'self' } }]);
        expect(t.calls.some((c) => c.path.endsWith('/agent-token'))).toBe(false);
        // Again: already there, nothing sent.
        expect(await vault('A', [a]).register({ projectId: PROJECT, agent: a, tynn: t.tynn as never })).toBe('registered');
        expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('a name another machine registered is the shared agent: nothing is registered (it mounts when it starts)', async () => {
        const t = fakeTynn(); const a = agent('atlas');
        await vault('A', [a]).register({ projectId: PROJECT, agent: a, tynn: t.tynn as never });
        const b = agent('atlas');
        expect(await vault('B', [b]).register({ projectId: PROJECT, agent: b, tynn: t.tynn as never })).toBe('shared');
        expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('a local twin of that name is a conflict, never a second registration', async () => {
        const t = fakeTynn(); const a = agent('atlas'); const twin = agent('atlas');
        const v = vault('A', [a, twin]);
        await v.register({ projectId: PROJECT, agent: a, tynn: t.tynn as never });
        expect(await v.register({ projectId: PROJECT, agent: twin, tynn: t.tynn as never })).toBe('conflict');
        expect(t.agents).toHaveLength(1);
    });

    it('the host registers an agent the first time it sees it after its start, and tries a failed one again', async () => {
        let roster: AgentRecord[] = [agent('atlas')];
        const did: string[] = [];
        let answer: 'registered' | 'failed' = 'failed';
        const sync = agentTynnSync({ agents: () => roster, push: async () => 'sent', register: async (a) => { did.push(`register ${a.name}`); return answer; } });
        sync.prime();
        roster = [...roster, agent('bolt')];
        await sync.changed();
        expect(did).toEqual(['register bolt']);
        answer = 'registered';
        await sync.changed();
        expect(did, 'the failed registration is tried again').toEqual(['register bolt', 'register bolt']);
        await sync.changed();
        expect(did).toHaveLength(2);
    });
});

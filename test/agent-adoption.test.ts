import { describe, expect, it } from 'vitest';
import { adoptionRefusal, importedAgents, importedAgentsOffer, RESERVED_AGENT_NAMES, sacredNameOf } from '../src/core/agent-adoption.js';
import { adoptAgent, readImportedAgents, type AgentAdoptionPorts } from '../src/main/agent-adoption-host.js';

/**
 * "IT CAME WITH AGENTS" (Add workspace parity item 6; Genie 1 genie#459 — AddWorkspaceModal.tsx :161-174, :629-660,
 * ImportedAgents.tsx, lib/imported-agents.ts, main/agents/roster.ts, reserved-names.ts).
 *
 * `.agents/<name>/AGENT.md` travels with the repo; the registry that names agents lives on each machine. So a workspace
 * added here arrives with its agents ON DISK and none registered. Genie 1 said so after the add and offered to ADOPT each
 * one — never automatically: a `git pull` must not be a way to gain agents. Adopting registers the agent with its
 * AGENT.md as its instructions and never rewrites the file.
 *
 * Never a name Genie refuses: Genie 1's reserved terms (`general`, `genie`, `tynn`) unless the workspace's Tynn project
 * grants exactly that one (`sacred_agent_name`, MeApiController::projectRow); a folder that is not an agent name Genie 2
 * takes (createAgent's shape); an AGENT.md whose `tuis:` names no provider Genie 2 runs. Never a duplicate: a name the
 * workspace already has (any case) is not offered, and adopting it twice registers it once.
 */

const persona = (front: string) => `---\n${front}\n---\n\n# Persona\n\nDoes the work.\n`;

describe('which agents a workspace brought (pure)', () => {
    it('lists each unregistered .agents/<name>/AGENT.md; a registered name (any case) is not offered again', () => {
        const list = importedAgents({
            files: [{ folder: 'atlas', text: persona('name: atlas') }, { folder: 'bolt', text: '# Bolt' }, { folder: 'cass', text: persona('name: cass') }],
            registered: [{ name: 'Cass' }],
        });
        expect(list.map((a) => a.name)).toEqual(['atlas', 'bolt']);
        expect(list[0]).toEqual({ name: 'atlas', provider: 'claude', instructions: '.agents/atlas/AGENT.md', refusal: null });
    });

    it('the provider is the AGENT.md’s own word (`tuis:`): its first provider Genie 2 runs; none it runs is a refusal', () => {
        const [codex, inline, aider] = importedAgents({
            files: [{ folder: 'coder', text: persona('tuis:\n  - codex\n  - claude') }, { folder: 'inline', text: persona('tuis: [aider, claude]') }, { folder: 'old', text: persona('tuis: [aider]') }],
            registered: [],
        });
        expect(codex).toMatchObject({ name: 'coder', provider: 'codex', refusal: null });
        expect(inline).toMatchObject({ provider: 'claude', refusal: null });
        expect(aider).toMatchObject({ provider: null, refusal: expect.stringMatching(/tuis: aider.*claude or codex/) });
    });

    it('Genie 1’s reserved names are refused — unless the workspace is granted THAT one term', () => {
        expect(RESERVED_AGENT_NAMES).toEqual(['general', 'genie', 'tynn']);
        for (const name of RESERVED_AGENT_NAMES) expect(adoptionRefusal(name, null)).toMatch(/reserved name/);
        expect(adoptionRefusal('tynn', 'tynn')).toBeNull();
        // One grant unlocks one term, never a skeleton key; a grant that is not reserved is inert.
        expect(adoptionRefusal('genie', 'tynn')).toMatch(/reserved name/);
        expect(adoptionRefusal('general', 'frontend')).toMatch(/reserved name/);
        // Whole names only: `tynnbuilder` and `genie-cloud` are their own agents.
        expect(adoptionRefusal('tynnbuilder', null)).toBeNull();
        expect(adoptionRefusal('genie-cloud', null)).toBeNull();
    });

    it('a folder that is not a name Genie 2 takes (createAgent’s shape) is refused, naming the folder', () => {
        for (const folder of ['My Agent', 'Atlas', '9lives', 'a'.repeat(41)]) expect(adoptionRefusal(folder, null)).toMatch(new RegExp(`\\.agents/${folder.slice(0, 8)}`));
        expect(adoptionRefusal('reviewer-2', null)).toBeNull();
    });

    it('a refused file is still LISTED, with its reason (an Adopt that always fails is worse than none, a silent gap worse still)', () => {
        const list = importedAgents({ files: [{ folder: 'tynn', text: '# Tynn' }, { folder: 'atlas', text: '# Atlas' }], registered: [] });
        expect(list.map((a) => [a.name, a.refusal === null])).toEqual([['atlas', true], ['tynn', false]]);
    });

    it('the offer: only when something is unregistered; Genie 1’s headline counts them', () => {
        expect(importedAgentsOffer([])).toEqual({ offer: false, headline: '' });
        const one = importedAgents({ files: [{ folder: 'atlas', text: '' }], registered: [] });
        expect(importedAgentsOffer(one).headline).toBe('1 agent already belongs to this project and is not registered on this machine.');
        const two = importedAgents({ files: [{ folder: 'atlas', text: '' }, { folder: 'bolt', text: '' }], registered: [] });
        expect(importedAgentsOffer(two)).toEqual({ offer: true, headline: '2 agents already belong to this project and are not registered on this machine.' });
    });

    it('the sacred grant is Tynn’s, from the linked project’s row; nothing else grants it', () => {
        const rows = [{ id: 42, sacred_agent_name: 'tynn' }, { id: '7', sacred_agent_name: null }, { id: '8', sacred_agent_name: '' }];
        expect(sacredNameOf(rows, '42')).toBe('tynn');
        expect(sacredNameOf(rows, '7')).toBeNull();
        expect(sacredNameOf(rows, '8')).toBeNull();
        expect(sacredNameOf(rows, '99')).toBeNull();
        expect(sacredNameOf(rows, null)).toBeNull();
    });
});

function fakes(over: { files?: Record<string, string>; dirs?: string[]; registered?: string[]; sacred?: string | null } = {}) {
    const root = '/w/acme.agi';
    const dirs = over.dirs ?? ['_genie', 'skills', 'atlas', 'bolt', 'tynn'];
    const files: Record<string, string> = over.files ?? {
        [`${root}/.agents/atlas/AGENT.md`]: persona('name: atlas\ntuis: [claude]'),
        [`${root}/.agents/bolt/AGENT.md`]: persona('tuis: [codex]'),
        [`${root}/.agents/tynn/AGENT.md`]: '# Tynn',
    };
    let agents = (over.registered ?? ['cass']).map((name, i) => ({ id: `agent_${i}`, workspaceId: 'acme', name }));
    const registered: Array<{ workspaceId: string; provider: string; name: string; instructions?: string | null }> = [];
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports: AgentAdoptionPorts = {
        workspace: (id) => (id === 'acme' ? { id, path: root } : null),
        agentsOf: (id) => agents.filter((a) => a.workspaceId === id),
        listDirs: async (p) => { if (key(p) !== `${root}/.agents`) throw new Error('ENOENT'); return dirs; },
        readText: async (p) => files[key(p)] ?? null,
        register: async (input) => {
            // A tick between the check and the write, as the real store's disk write has.
            await new Promise((r) => setTimeout(r, 1));
            registered.push(input);
            agents = [...agents, { id: `agent_${agents.length}`, workspaceId: input.workspaceId, name: input.name }];
            return { id: `agent_new_${registered.length}`, name: input.name };
        },
        sacredName: async () => over.sacred ?? null,
    };
    return { ports, registered };
}

describe('reading and adopting on the host', () => {
    it('lists what is on disk and unregistered — `_genie/` and `skills/` have no AGENT.md and are not agents', async () => {
        const f = fakes();
        const r = await readImportedAgents(f.ports, 'acme');
        expect(r).toMatchObject({ ok: true, agents: [{ name: 'atlas', provider: 'claude', refusal: null }, { name: 'bolt', provider: 'codex', refusal: null }, { name: 'tynn', refusal: expect.stringMatching(/reserved/) }] });
        expect(f.registered).toEqual([]);
    });

    it('a workspace with no .agents/ brings nothing; an unknown workspace is refused', async () => {
        expect(await readImportedAgents(fakes({ dirs: [] }).ports, 'acme')).toEqual({ ok: true, agents: [] });
        const missing = fakes();
        missing.ports.listDirs = async () => { throw new Error('ENOENT'); };
        expect(await readImportedAgents(missing.ports, 'acme')).toEqual({ ok: true, agents: [] });
        expect(await readImportedAgents(fakes().ports, 'nope')).toEqual({ ok: false, reason: 'no workspace nope' });
    });

    it('adopt registers it ONCE, its AGENT.md as its instructions, on the provider its file names — the file untouched', async () => {
        // The ports have no write to the workspace at all: adoption can only READ the file (the type is the guarantee).
        const f = fakes();
        expect(await adoptAgent(f.ports, 'acme', 'bolt')).toEqual({ ok: true, id: 'agent_new_1', name: 'bolt' });
        expect(f.registered).toEqual([{ workspaceId: 'acme', provider: 'codex', name: 'bolt', instructions: '.agents/bolt/AGENT.md' }]);
        // Now registered: not offered again, and a second adopt registers nothing.
        const after = await readImportedAgents(f.ports, 'acme');
        expect(after.ok ? after.agents.map((a) => a.name) : after).toEqual(['atlas', 'tynn']);
        expect(await adoptAgent(f.ports, 'acme', 'bolt')).toEqual({ ok: false, reason: 'acme already has an agent named bolt' });
        expect(f.registered.length).toBe(1);
    });

    it('two adopts of one agent at once register it once (COUNTED)', async () => {
        const f = fakes();
        const results = await Promise.all([adoptAgent(f.ports, 'acme', 'atlas'), adoptAgent(f.ports, 'acme', 'atlas')]);
        expect(results.filter((r) => r.ok).length).toBe(1);
        expect(f.registered.filter((r) => r.name === 'atlas').length).toBe(1);
    });

    it('a refused name is never registered; the sacred grant lets exactly that one through (positive control)', async () => {
        const plain = fakes();
        expect(await adoptAgent(plain.ports, 'acme', 'tynn')).toMatchObject({ ok: false, reason: expect.stringMatching(/reserved name/) });
        expect(plain.registered).toEqual([]);
        const sacred = fakes({ sacred: 'tynn' });
        expect(await adoptAgent(sacred.ports, 'acme', 'tynn')).toMatchObject({ ok: true, name: 'tynn' });
        expect(sacred.registered.map((r) => r.name)).toEqual(['tynn']);
    });

    it('a name with no AGENT.md here, or a path-shaped name, is refused and nothing is read outside .agents/', async () => {
        const f = fakes();
        const read: string[] = [];
        const real = f.ports.readText;
        f.ports.readText = async (p) => { read.push(p.replace(/\\/g, '/')); return real(p); };
        expect(await adoptAgent(f.ports, 'acme', 'ghost')).toEqual({ ok: false, reason: 'acme has no unregistered agent ghost in .agents/' });
        expect(await adoptAgent(f.ports, 'acme', '../../etc')).toMatchObject({ ok: false });
        expect(read.every((p) => p.startsWith('/w/acme.agi/.agents/'))).toBe(true);
        expect(read.some((p) => p.includes('..'))).toBe(false);
        expect(f.registered).toEqual([]);
    });

    it('a sacred lookup that fails grants nothing: reserved stays refused', async () => {
        const f = fakes();
        f.ports.sacredName = async () => { throw new Error('Sign in to Tynn first'); };
        expect(await adoptAgent(f.ports, 'acme', 'tynn')).toMatchObject({ ok: false, reason: expect.stringMatching(/reserved name/) });
        // CONTROL: the same failing lookup does not stop an ordinary adoption.
        expect(await adoptAgent(f.ports, 'acme', 'atlas')).toMatchObject({ ok: true });
    });
});

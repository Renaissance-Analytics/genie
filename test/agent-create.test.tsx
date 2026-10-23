import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentFileText, agentSlug, newAgentRefusal } from '../src/core/agent-create.js';
import { parseAgentManifest } from '../src/core/agent-manifest.js';
import { createAgent, type AgentCreatePorts } from '../src/main/agent-create-host.js';
import { NewAgentView } from '../src/renderer/components/NewAgentModal.js';

/**
 * A NEW AGENT IS ASKED FOR, NOT INVENTED (the owner, 2026-10-23: "the agent creation UX is totally busted. It didn't give
 * me any ux to choose name, purpose or anything that genie 1 could even. it just created an agent with some dumb name and
 * default settings"). Genie 2's "+ Add agent" registered `agent-<time>` on Claude with no purpose and no AGENT.md. Genie
 * 1's NewAgentModal asked for a name (shown as the folder it becomes), a purpose (required, written into AGENT.md) and a
 * starting provider, refused reserved and duplicate names, and wrote `.agents/<name>/AGENT.md` — never over one that is
 * there. This is that, on Genie 2's rules: claude or codex, the same name pattern and reserved list adoption uses.
 */

describe('the form’s rules', () => {
    it('the name becomes its folder: lower-case, runs of anything else a dash, ends trimmed', () => {
        expect(agentSlug('  Laravel App Work!! ')).toBe('laravel-app-work');
        expect(agentSlug('Ops_2')).toBe('ops-2');
        expect(agentSlug('***')).toBe('');
    });

    it('refuses what cannot be an agent — saying why — and accepts what can (control)', () => {
        const ok = { name: 'scout', purpose: 'Reads issues and triages them', provider: 'codex', existing: ['atlas'], sacredName: null };
        expect(newAgentRefusal(ok)).toBeNull();
        expect(newAgentRefusal({ ...ok, name: '' })).toMatch(/needs a name/);
        expect(newAgentRefusal({ ...ok, name: '9lives' })).toMatch(/start with a letter/);
        expect(newAgentRefusal({ ...ok, name: 'genie' })).toMatch(/"genie" is a reserved name/);
        expect(newAgentRefusal({ ...ok, name: 'Atlas'.toLowerCase() })).toMatch(/already has an agent named atlas/);
        expect(newAgentRefusal({ ...ok, purpose: '   ' })).toMatch(/needs a purpose/);
        expect(newAgentRefusal({ ...ok, provider: 'gemini' })).toMatch(/claude or codex/);
        // The workspace's one Tynn grant unlocks exactly that reserved name.
        expect(newAgentRefusal({ ...ok, name: 'tynn', sacredName: 'tynn' })).toBeNull();
        expect(newAgentRefusal({ ...ok, name: 'genie', sacredName: 'tynn' })).toMatch(/reserved/);
    });

    it('AGENT.md says the name, the purpose and the provider it starts on — and reads back as itself', () => {
        const text = agentFileText({ name: 'scout', purpose: 'Reads issues and triages them', provider: 'codex' });
        expect(text).toMatch(/^---\nname: scout\npurpose: Reads issues and triages them\ntuis: \[codex\]\n---\n/);
        expect(text).toContain('You are scout. Reads issues and triages them');
        expect(parseAgentManifest(text, 'scout')).toMatchObject({ name: 'scout', tuis: ['codex'] });
    });
});

describe('creating it on the host', () => {
    const WS = join('/w', 'shop');
    const ports = (opts: { existingFile?: string; agents?: string[] } = {}) => {
        const written: Array<[string, string]> = [];
        const registered: unknown[] = [];
        const file = join(WS, '.agents', 'scout', 'AGENT.md');
        const p: AgentCreatePorts = {
            workspace: (id) => (id === 'shop' ? { id: 'shop', path: WS } : null),
            agentsOf: () => (opts.agents ?? []).map((name) => ({ name })),
            exists: async (path) => path === file && opts.existingFile !== undefined,
            mkdirp: async () => {},
            writeText: async (path, text) => { written.push([path, text]); },
            register: async (input) => { registered.push(input); return { id: 'agent_new', name: input.name }; },
            sacredName: async () => null,
        };
        return { p, written, registered, file };
    };

    it('writes .agents/<name>/AGENT.md, then registers it with that file as its instructions, on the chosen provider', async () => {
        const { p, written, registered, file } = ports();
        const r = await createAgent(p, 'shop', { name: 'Scout', purpose: 'Reads issues and triages them', provider: 'codex' });
        expect(r).toEqual({ ok: true, id: 'agent_new', name: 'scout' });
        expect(written).toHaveLength(1);
        expect(written[0]![0]).toBe(file);
        expect(written[0]![1]).toContain('purpose: Reads issues and triages them');
        expect(registered).toEqual([{ workspaceId: 'shop', provider: 'codex', name: 'scout', instructions: '.agents/scout/AGENT.md' }]);
    });

    it('never overwrites an AGENT.md that is already there: it is kept, and the agent registers on it', async () => {
        const { p, written, registered } = ports({ existingFile: 'their own words' });
        const r = await createAgent(p, 'shop', { name: 'scout', purpose: 'Something new', provider: 'claude' });
        expect(r).toMatchObject({ ok: true });
        expect(written).toEqual([]);
        expect(registered).toHaveLength(1);
    });

    it('a refused form writes nothing and registers nothing, and says why', async () => {
        const { p, written, registered } = ports({ agents: ['scout'] });
        const r = await createAgent(p, 'shop', { name: 'scout', purpose: 'x', provider: 'claude' });
        expect(r).toEqual({ ok: false, reason: expect.stringMatching(/already has an agent named scout/) });
        expect(await createAgent(p, 'nope', { name: 'other', purpose: 'x', provider: 'claude' })).toMatchObject({ ok: false });
        expect(written).toEqual([]);
        expect(registered).toEqual([]);
    });
});

describe('the New agent form', () => {
    const view = (over: Partial<Parameters<typeof NewAgentView>[0]> = {}) =>
        renderToStaticMarkup(<NewAgentView workspaceName="shop" name="" purpose="" provider="claude" busy={false} error={null} onName={() => {}} onPurpose={() => {}} onProvider={() => {}} onCreate={() => {}} onCancel={() => {}} {...over} />);

    it('asks for a name, a purpose and a provider (claude, codex); Create is disabled until both are filled', () => {
        const html = view();
        expect(html).toContain('New agent in shop');
        expect(html).toMatch(/data-new-agent-field="name"/);
        expect(html).toMatch(/data-new-agent-field="purpose"/);
        expect(html).toMatch(/data-new-agent-field="provider"/);
        expect(html).toMatch(/<option value="claude"/);
        expect(html).toMatch(/<option value="codex"/);
        expect(html).toMatch(/<button[^>]*data-action="create-agent"[^>]*disabled=""/);
    });

    it('shows the folder the name becomes; Create is live once name and purpose are there (control); a refusal is said', () => {
        const html = view({ name: 'Laravel App', purpose: 'App work' });
        expect(html).toMatch(/Created as[^<]*<strong>laravel-app<\/strong>/);
        expect(html).not.toMatch(/<button[^>]*data-action="create-agent"[^>]*disabled=""/);
        expect(view({ name: 'genie', purpose: 'x', error: '"genie" is a reserved name' })).toMatch(/data-new-agent-error=""[^>]*>[^<]*reserved/);
    });
});

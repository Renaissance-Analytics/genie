import { describe, expect, it } from 'vitest';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { allGenieTools, type AllToolsDeps } from '../src/main/mcp-registrations.js';

/**
 * EVERY GENIE TOOL, ONCE (§6.9). The six tool modules (core, more, attention, hosting, processes, plugins)
 * compose into one registration list for the server; names are unique or the server refuses to start, so the
 * composition is counted here: the twelve Genie tools, plus one per enabled plugin tool under its plugin's
 * namespace. The deps are fakes with exactly the shape main.ts hands in — the composition is the subject,
 * not the tools.
 */

function deps(pluginTools: AllToolsDeps['plugins']['plugins']['tools'] = () => []): AllToolsDeps {
    const never = () => { throw new Error('not exercised'); };
    return {
        genie: { inbox: never as never, attention: never as never, roster: () => [], resolveCaller: () => null, workspaceSetting: never as never, userActive: () => true, glow: () => false, thumbsUp: () => {} },
        more: { knowledge: never as never, terminals: never as never, approve: async () => 'denied', resolveCaller: () => null },
        attention: { resolveCaller: () => null, openFile: async () => ({ ok: false, reason: 'x' }) },
        hosting: { resolveCaller: () => null, approve: async () => 'denied', services: null },
        processes: { resolveCaller: () => null, approve: async () => 'denied', processes: null },
        plugins: { plugins: { tools: pluginTools, guard: () => null }, run: never as never, approve: async () => 'denied', resolveCaller: () => null },
    };
}

describe('allGenieTools', () => {
    // `submitFeedback` was REMOVED (the owner, 2026-10-18: "get rid of the submit feedback feature"); the person's
    // Feedback window (Ctrl+Shift+W, Tynn #760) is how feedback reaches Tynn now.
    // NO SIDECAR (the owner, 2026-10-19: "get rid of the whole sidecar concept"; "do not list tools and instructions an
    // agent cannot use"): `runAgent` was only the sidecar; it is gone, and no skill tells an agent about one.
    // `plan` added 2026-10-20 (the owner: the Active Plan column had no way for an agent to fill it).
    it('is the thirteen Genie tools, unique, in a stable order — no submitFeedback, no runAgent sidecar', () => {
        const names = allGenieTools(deps()).map((r) => r.definition.name);
        expect(names).toEqual(['imDone', 'ForceTheQuestion', 'agentinbox', 'lists', 'thumbsUp', 'checkIssues', 'knowledge', 'manageTerminals', 'openFileForUser', 'plan', 'services', 'sites', 'processes']);
        expect(new Set(names).size).toBe(names.length);
    });

    it('with the agents part (normal Genie, not doctor): createAgent after processes — the ONLY tool that is not for every caller', () => {
        const withAgents: AllToolsDeps = { ...deps(), agents: { resolveCaller: () => null, defaultAgentOf: () => null, roster: () => [], approve: async () => 'denied', register: (() => { throw new Error('x'); }) as never, addressOf: () => '' } };
        const regs = allGenieTools(withAgents);
        expect(regs.map((r) => r.definition.name)).toEqual(['imDone', 'ForceTheQuestion', 'agentinbox', 'lists', 'thumbsUp', 'checkIssues', 'knowledge', 'manageTerminals', 'openFileForUser', 'plan', 'services', 'sites', 'processes', 'createAgent']);
        expect(regs.filter((r) => r.visible !== undefined).map((r) => r.definition.name)).toEqual(['createAgent']);
    });

    it('adds every enabled plugin tool under its plugin’s namespace, after the Genie tools', () => {
        const manifest = { id: 'acme.lint', name: 'Acme Lint', version: '1.0.0', publisher: { name: 'Acme', keyId: 'k' }, mcpTools: [], capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [] };
        const tool = { name: 'lint', description: 'Lint', inputSchema: { type: 'object' }, run: 'tools/lint.js', process: 'subprocess' as const, gated: false };
        const names = allGenieTools(deps(() => [{ pluginId: 'acme.lint', dir: '/p', manifest: { ...manifest, mcpTools: [tool] }, tool }])).map((r) => r.definition.name);
        expect(names).toHaveLength(14);
        expect(names[13]).toBe('acme.lint.lint');
    });
});

describe('no agent is told about a sidecar', () => {
    it('no skill mentions a sidecar, `-slave` or `runAgent` (COUNTED: 0)', () => {
        const text = GENIE_SKILLS.map((k) => [k.description, k.body].join(' ')).join(' ');
        expect(text.match(/sidecar|-slave|runAgent/gi) ?? []).toHaveLength(0);
        // The positive control: the skills ARE read here (one of them names manageTerminals).
        expect(text).toContain('manageTerminals');
    });
});

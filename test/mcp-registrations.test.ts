import { describe, expect, it } from 'vitest';
import { allGenieTools, type AllToolsDeps } from '../src/main/mcp-registrations.js';

/**
 * EVERY GENIE TOOL, ONCE (§6.9). The six tool modules (core, more, attention, sidecar, hosting, plugins) compose into
 * one registration list for the server; names are unique or the server refuses to start, so the
 * composition is counted here: the twelve Genie tools, plus one per enabled plugin tool under its plugin's
 * namespace. The deps are fakes with exactly the shape main.ts hands in — the composition is the subject,
 * not the tools.
 */

function deps(pluginTools: AllToolsDeps['plugins']['plugins']['tools'] = () => []): AllToolsDeps {
    const never = () => { throw new Error('not exercised'); };
    return {
        genie: { inbox: never as never, attention: never as never, roster: () => [], resolveCaller: () => null, workspaceSetting: never as never, userActive: () => true, glow: () => false, thumbsUp: () => {} },
        more: { knowledge: never as never, terminals: never as never, approve: async () => 'denied', resolveCaller: () => null },
        attention: { resolveCaller: () => null, openFile: async () => ({ ok: false, reason: 'x' }), feedback: never as never },
        sidecar: { resolveCaller: () => null, roster: () => [], register: never as never, start: never as never, running: () => false, addressOf: () => '' },
        hosting: { resolveCaller: () => null, approve: async () => 'denied', services: null },
        plugins: { plugins: { tools: pluginTools, guard: () => null }, run: never as never, approve: async () => 'denied', resolveCaller: () => null },
    };
}

describe('allGenieTools', () => {
    it('is the twelve Genie tools, unique, in a stable order', () => {
        const names = allGenieTools(deps()).map((r) => r.definition.name);
        expect(names).toEqual(['imDone', 'ForceTheQuestion', 'agentinbox', 'lists', 'thumbsUp', 'knowledge', 'manageTerminals', 'openFileForUser', 'submitFeedback', 'runAgent', 'services', 'sites']);
        expect(new Set(names).size).toBe(names.length);
    });

    it('adds every enabled plugin tool under its plugin’s namespace, after the Genie tools', () => {
        const manifest = { id: 'acme.lint', name: 'Acme Lint', version: '1.0.0', publisher: { name: 'Acme', keyId: 'k' }, mcpTools: [], capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [] };
        const tool = { name: 'lint', description: 'Lint', inputSchema: { type: 'object' }, run: 'tools/lint.js', process: 'subprocess' as const, gated: false };
        const names = allGenieTools(deps(() => [{ pluginId: 'acme.lint', dir: '/p', manifest: { ...manifest, mcpTools: [tool] }, tool }])).map((r) => r.definition.name);
        expect(names).toHaveLength(13);
        expect(names[12]).toBe('acme.lint.lint');
    });
});

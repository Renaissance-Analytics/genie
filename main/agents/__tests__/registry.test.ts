import { describe, expect, it, vi } from 'vitest';

import {
    PROVIDER_REGISTRY,
    agentProviders,
    providerDef,
    providerSettingDefaults,
    providerSettingKeys,
} from '../registry';
import { agentName, isAgentProvider } from '../identity';
import { AGENT_PROVIDERS } from '../provider';
import { savedAgentsOf } from '../saved';
import { resolveAgentCommand } from '../command';
import { handleMcpMessage, type McpContext } from '../../mcp/protocol';

/**
 * ONE place defines a provider (genie#261).
 *
 * Before this, the provider set was a string-literal union restated in ~37
 * places, of which only ~11 were compiler-enforced. The unenforced ones are the
 * reason this exists: they do not fail to build, they fail to WORK, silently.
 *
 * These tests are all the same shape on purpose — every surface that names the
 * providers must equal `Object.keys(PROVIDER_REGISTRY)`. That is the property
 * that makes adding a provider DATA rather than a sweep: any surface still
 * carrying its own literal diverges from the registry the moment one is added,
 * and says so here.
 */

const REGISTRY_IDS = Object.keys(PROVIDER_REGISTRY).sort();

/**
 * Read the REAL advertised `runAgent` schema through `tools/list`, the way
 * `guide-sync.test.ts` does — this is what an MCP client actually receives, so a
 * schema that drifts from the registry fails here rather than at a client.
 */
async function advertisedAgentEnum(): Promise<string[]> {
    const ctx = { terminalId: 'term-1', serverName: 'genie', serverVersion: '0.0.0-test',
        runAgent: vi.fn(), isOpsProject: vi.fn().mockResolvedValue(false) } as unknown as McpContext;
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx);
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'runAgent');
    if (!tool) throw new Error('runAgent tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties;
    return props?.agent?.enum ?? [];
}

describe('the registry is the source of truth', () => {
    it('knows the providers Genie ships', () => {
        expect(REGISTRY_IDS).toEqual(['claude', 'codex', 'custom']);
    });

    it('gives every provider a complete definition', () => {
        for (const id of agentProviders()) {
            const def = providerDef(id);
            expect(def.id, `${id}.id`).toBe(id);
            expect(def.label.trim(), `${id}.label`).not.toBe('');
            expect(def.commandSettingKey, `${id}.commandSettingKey`).toBe(`agent_command_${id}`);
            expect(def.flagsSettingKey, `${id}.flagsSettingKey`).toBe(`agent_flags_${id}`);
        }
    });

    it('lists providers in a stable order, so every derived UI agrees', () => {
        expect(agentProviders()).toEqual(['claude', 'codex', 'custom']);
        expect(agentProviders()).toEqual(Object.keys(PROVIDER_REGISTRY));
    });
});

describe('every provider list is DERIVED, not restated', () => {
    /**
     * `main/agents/identity.ts` carried `const PROVIDERS: readonly string[]`,
     * deliberately outside the union so the compiler could not check it. That is
     * the single worst site in genie#261 — see the regression below.
     */
    it('identity.isAgentProvider accepts exactly the registry', () => {
        for (const id of agentProviders()) {
            expect(isAgentProvider(id), `isAgentProvider(${id})`).toBe(true);
        }
        for (const notOne of ['gemini', 'cursor', 'aider', '', 'CLAUDE']) {
            expect(isAgentProvider(notOne), `isAgentProvider(${notOne})`).toBe(false);
        }
    });

    it('provider.AGENT_PROVIDERS is the registry', () => {
        expect([...AGENT_PROVIDERS].sort()).toEqual(REGISTRY_IDS);
    });

    /**
     * The MCP JSON-Schema `enum`. Miss this one and an agent cannot NAME the
     * provider over the wire, whatever the TypeScript says.
     */
    it('the runAgent tool schema enum is the registry', async () => {
        expect((await advertisedAgentEnum()).sort()).toEqual(REGISTRY_IDS);
    });

    /**
     * The DEFAULTS block in `db.ts` listed all six keys by hand. A provider added
     * without its two lines gets `undefined` where a string is expected.
     */
    it('the settings defaults cover every provider, with the registry command', () => {
        const defaults = providerSettingDefaults();
        for (const id of agentProviders()) {
            const def = providerDef(id);
            expect(defaults[def.commandSettingKey], `${id} command default`).toBe(
                def.defaultCommand,
            );
            expect(defaults[def.flagsSettingKey], `${id} flags default`).toBe('');
        }
        expect(Object.keys(defaults)).toHaveLength(agentProviders().length * 2);
    });

    it('the settings keys are the registry', () => {
        const keys = providerSettingKeys();
        expect(keys.map((k) => k.command).sort()).toEqual(
            REGISTRY_IDS.map((id) => `agent_command_${id}`),
        );
        expect(keys.map((k) => k.flags).sort()).toEqual(
            REGISTRY_IDS.map((id) => `agent_flags_${id}`),
        );
    });
});

describe('the default command comes from the registry', () => {
    /**
     * `resolveAgentCommand` was an if/else ladder with `'claude'` and `'codex'`
     * spelled out twice each — once as the settings key and once as the fallback.
     * A provider added without a rung here resolves to null and simply does not
     * launch.
     */
    it('resolves every provider to its registry default when nothing is configured', () => {
        for (const id of agentProviders()) {
            const def = providerDef(id);
            const resolved = resolveAgentCommand(id, undefined, {});
            if (def.defaultCommand) {
                expect(resolved, `${id} default`).toBe(def.defaultCommand);
            } else {
                // `custom` has no built-in default on purpose — guessing one
                // would launch the wrong thing.
                expect(resolved, `${id} has no default`).toBeNull();
            }
        }
    });

    it('prefers an explicit override over everything', () => {
        expect(resolveAgentCommand('claude', '  my-claude  ', {})).toBe('my-claude');
    });

    it('prefers the configured setting over the registry default', () => {
        expect(resolveAgentCommand('claude', undefined, { agent_command_claude: 'claude-next' }))
            .toBe('claude-next');
    });

    it('falls back to the registry default when the setting is blank', () => {
        expect(resolveAgentCommand('claude', undefined, { agent_command_claude: '   ' }))
            .toBe('claude');
    });
});

describe('the silent skip this refactor exists to close', () => {
    /**
     * The worked example from genie#261.
     *
     * `savedAgentsOf` gates on `isAgentProvider(spec.meta.agent)`. When that read
     * its own literal, a provider added everywhere ELSE — union widened, launch
     * profile added, settings added, UI added — would still be dropped here, with
     * **no error anywhere**: the agent simply never appeared in the roster.
     *
     * Deriving the guard from the registry makes that unreachable: if it is in
     * the registry it is a provider, by construction.
     */
    it('lists a saved agent for EVERY provider in the registry', () => {
        const specs = agentProviders().map((provider, i) => ({
            id: `spec-${i}`,
            workspace_id: 'ws-1',
            meta: { agent: provider, whisper_purpose: 'tynn', agent_id: `agent-${i}` },
        }));

        const found = savedAgentsOf(specs, 'ws-1', () => false);

        expect(found.map((a) => a.provider)).toEqual(agentProviders());
        expect(found).toHaveLength(Object.keys(PROVIDER_REGISTRY).length);
    });

    it('still drops a spec whose agent is not a provider at all', () => {
        const found = savedAgentsOf(
            [{ id: 's1', workspace_id: 'ws-1', meta: { agent: 'gemini' } }],
            'ws-1',
            () => false,
        );
        expect(found).toEqual([]);
    });

    /**
     * A positive control for the negative above: the same call shape, with a real
     * provider, must still return something. Otherwise "returns []" would also
     * pass if `savedAgentsOf` were broken outright.
     */
    it('positive control — the same shape with a real provider is kept', () => {
        const found = savedAgentsOf(
            [{ id: 's1', workspace_id: 'ws-1', meta: { agent: 'claude' } }],
            'ws-1',
            () => false,
        );
        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe(agentName(undefined));
    });
});

import { describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { PluginManifest } from '../src/core/plugins.js';
import type { Caller, ToolContext } from '../src/main/mcp-tools.js';
import { pluginTools, type PluginToolsDeps } from '../src/main/mcp-tools-plugins.js';

/**
 * PLUGIN TOOLS ON GENIE'S MCP SURFACE (§6.7). Every ENABLED plugin's tools are offered to agents as
 * `<pluginId>.<tool>`; a disabled, refused or invalid plugin offers nothing. A call runs the tool through
 * the runner with the plugin's own guard — the bridge's enforcement — and a GATED tool parks the person's
 * approval first (denied → nothing runs). The runner is a port here; nothing spawns.
 */

const manifest = (id: string, gated = false): PluginManifest => ({
    id,
    name: id,
    version: '1.0.0',
    publisher: { name: 'Acme', keyId: 'acme-1' },
    mcpTools: [{ name: 'lint', description: 'Lint a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, run: 'tools/lint.js', process: 'subprocess', gated }],
    capabilities: { network: { hosts: [] }, genieApi: ['knowledge.search'] },
    panels: [],
});

const atlas: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };
const ctx = (tool: string): ToolContext => ({ server: 'genie', tool, headers: { 'x-genie-terminal-id': 'term_1' } });

function deps(over: Partial<PluginToolsDeps> = {}) {
    const runs: Array<{ pluginId: string; tool: string; args: unknown }> = [];
    const approvals: string[] = [];
    const d: PluginToolsDeps = {
        plugins: {
            tools: () => [
                { pluginId: 'acme.lint', dir: '/plugins/acme.lint', manifest: manifest('acme.lint'), tool: manifest('acme.lint').mcpTools[0]! },
                { pluginId: 'acme.gated', dir: '/plugins/acme.gated', manifest: manifest('acme.gated', true), tool: manifest('acme.gated', true).mcpTools[0]! },
            ],
            guard: (pluginId) => (pluginId.startsWith('acme.') ? () => ({ allowed: true }) : null),
        },
        run: async (input) => { runs.push({ pluginId: input.manifest.id, tool: input.tool.name, args: input.args }); return { ok: true, result: { fixed: 1 } }; },
        approve: async (_caller, action, detail) => { approvals.push(`${action}:${detail}`); return 'denied'; },
        resolveCaller: (terminalId) => (terminalId === 'term_1' ? atlas : null),
        ...over,
    };
    return { d, runs, approvals };
}

describe('pluginTools', () => {
    it('offers every enabled plugin tool as <pluginId>.<tool> with the plugin’s own schema and description', () => {
        const { d } = deps();
        const tools = pluginTools(d);
        expect(tools.map((t) => t.definition.name).sort()).toEqual(['acme.gated.lint', 'acme.lint.lint']);
        expect(tools[0]!.definition.description).toContain('Lint a file');
        expect(tools[0]!.definition.description).toMatch(/plugin/i);
    });

    it('a call resolves the caller, runs through the runner with the plugin’s guard, and answers the plugin’s result', async () => {
        const { d, runs } = deps();
        const reg = pluginTools(d).find((t) => t.definition.name === 'acme.lint.lint')!;
        const r = await reg.handler({ path: 'src/a.ts', terminalId: 'term_1' }, ctx('acme.lint.lint'));
        expect(r.isError).toBe(false);
        expect(JSON.parse(r.text)).toEqual({ ok: true, result: { fixed: 1 } });
        expect(runs).toEqual([{ pluginId: 'acme.lint', tool: 'lint', args: { path: 'src/a.ts' } }]);
    });

    it('a GATED tool asks the person first; denied → an error in words and NOTHING runs; allowed → runs', async () => {
        const { d, runs, approvals } = deps();
        const reg = pluginTools(d).find((t) => t.definition.name === 'acme.gated.lint')!;
        const denied = await reg.handler({ terminalId: 'term_1' }, ctx('acme.gated.lint'));
        expect(denied.isError).toBe(true);
        expect(denied.text).toMatch(/denied/);
        expect(approvals).toEqual(['plugin:acme.gated.lint']);
        expect(runs).toEqual([]);
        const allowed = deps({ approve: async () => 'allowed' });
        const reg2 = pluginTools(allowed.d).find((t) => t.definition.name === 'acme.gated.lint')!;
        expect((await reg2.handler({ terminalId: 'term_1' }, ctx('acme.gated.lint'))).isError).toBe(false);
        expect(allowed.runs).toHaveLength(1);
    });

    it('no terminal id, an unknown terminal, a plugin whose guard is gone (disabled since the list), or a runner error: errors in words, nothing run', async () => {
        const { d, runs } = deps({ run: async () => ({ ok: false, reason: 'acme.lint.lint exited with code 2 before answering: boom' }) });
        const reg = pluginTools(d).find((t) => t.definition.name === 'acme.lint.lint')!;
        // No id anywhere — neither the argument nor the mirrored header.
        expect((await reg.handler({}, { server: 'genie', tool: 'acme.lint.lint', headers: {} })).text).toMatch(/GENIE_TERMINAL_ID/);
        expect((await reg.handler({ terminalId: 'term_9' }, ctx('acme.lint.lint'))).text).toMatch(/no agent/);
        const gone = deps({ plugins: { tools: d.plugins.tools, guard: () => null } });
        expect((await pluginTools(gone.d)[0]!.handler({ terminalId: 'term_1' }, ctx('acme.gated.lint'))).text).toMatch(/not enabled/);
        expect(gone.runs).toEqual([]);
        const failed = await reg.handler({ terminalId: 'term_1' }, ctx('acme.lint.lint'));
        expect(failed.isError).toBe(true);
        expect(failed.text).toMatch(/exited with code 2/);
        // The two refusals above never reached the runner; `runs` is the first harness's recorder and that harness's runner was replaced, so count from `gone` only.
        expect(runs).toEqual([]);
    });
});

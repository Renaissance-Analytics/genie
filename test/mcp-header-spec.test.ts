import { MirroredParameters } from '@particle-academy/prism-mcp';
import { describe, expect, it } from 'vitest';
import { allGenieTools, type AllToolsDeps } from '../src/main/mcp-registrations.js';

/**
 * EVERY GENIE TOOL PUBLISHES A SCHEMA A SPEC CLIENT KEEPS. Measured on the owner's beta.20 (2026-10-13): Claude Code
 * 2.1.296 connected to Genie's MCP and then dropped all ten tools — "excluding tool 'imDone' from tools/list: invalid
 * x-mcp-header declaration — terminalId: x-mcp-header MUST be a non-empty string". Genie declared the mirror as an
 * object (`{ type: 'string' }`); the spec makes it the header NAME. prism-mcp's own parser skips a non-string
 * annotation instead of refusing it, so Genie's server served the broken schema and the old assertion
 * (`toBeDefined()`) passed. No agent in Genie had Genie's tools.
 *
 * Counted, over every registered tool (a plugin tool included): each `x-mcp-header` is a legal header-name string,
 * and prism-mcp's mirror parser resolves `terminalId` for every tool that takes one.
 */
function deps(): AllToolsDeps {
    const never = () => { throw new Error('not exercised'); };
    const manifest = { id: 'acme.lint', name: 'Acme Lint', version: '1.0.0', publisher: { name: 'Acme', keyId: 'k' }, mcpTools: [], capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [] };
    const tool = { name: 'lint', description: 'Lint', inputSchema: { type: 'object' }, run: 'tools/lint.js', process: 'subprocess' as const, gated: false };
    return {
        genie: { inbox: never as never, attention: never as never, roster: () => [], resolveCaller: () => null, workspaceSetting: never as never, userActive: () => true, glow: () => false, thumbsUp: () => {} },
        more: { knowledge: never as never, terminals: never as never, approve: async () => 'denied', resolveCaller: () => null },
        attention: { resolveCaller: () => null, openFile: async () => ({ ok: false, reason: 'x' }), feedback: never as never },
        sidecar: { resolveCaller: () => null, roster: () => [], register: never as never, start: never as never, running: () => false, addressOf: () => '' },
        hosting: { resolveCaller: () => null, approve: async () => 'denied', services: null },
        processes: { resolveCaller: () => null, approve: async () => 'denied', processes: null },
        plugins: { plugins: { tools: () => [{ pluginId: 'acme.lint', dir: '/p', manifest: { ...manifest, mcpTools: [tool] }, tool }], guard: () => null }, run: never as never, approve: async () => 'denied', resolveCaller: () => null },
    };
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
type Props = Record<string, Record<string, unknown>>;

describe('Genie’s published tool schemas', () => {
    const tools = allGenieTools(deps()).map((r) => r.definition);
    const withTerminalId = tools.filter((d) => (d.inputSchema as { properties?: Props }).properties?.terminalId);

    it('every x-mcp-header is a header-name string — the tools that break the rule are named', () => {
        const broken = tools.filter((d) => Object.values((d.inputSchema as { properties?: Props }).properties ?? {})
            .some((p) => 'x-mcp-header' in p && !(typeof p['x-mcp-header'] === 'string' && HEADER_TOKEN.test(p['x-mcp-header'] as string))));
        expect(broken.map((d) => d.name)).toEqual([]);
    });

    it('the mirror resolves terminalId on every tool that takes it — counted, with the tool set as the control', () => {
        expect(withTerminalId.length).toBe(14); // the thirteen Genie tools and the plugin tool
        const mirrored = withTerminalId.filter((d) => {
            const p = MirroredParameters.fromSchema(d.name, d.inputSchema as never).parameters as Record<string, { path: string[] }>;
            return p.terminalId?.path.join('.') === 'terminalId';
        });
        expect(mirrored.map((d) => d.name)).toEqual(withTerminalId.map((d) => d.name));
    });
});

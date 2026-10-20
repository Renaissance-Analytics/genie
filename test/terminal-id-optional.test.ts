import { describe, expect, it } from 'vitest';
import { allGenieTools, type AllToolsDeps } from '../src/main/mcp-registrations.js';

/**
 * A GENIE SESSION CALLS GENIE'S TOOLS WITHOUT KNOWING ANY ID. Measured on the owner's machine (2026-10-13), against the
 * real Genie server with the exact MCP config Genie gives its agents: Claude saw every tool's `terminalId` REQUIRED,
 * described as "the value of GENIE_TERMINAL_ID", found no such variable in a session, and either stopped and asked for it
 * or invented one ("genie" → "terminal genie is not one Genie knows"). A session is identified by the
 * `Mcp-Param-terminalId` header Genie configures for it; the model must be free to leave the argument out. So no tool
 * requires it, and its description tells a session to omit it — only a plain terminal passes GENIE_TERMINAL_ID.
 */
function deps(): AllToolsDeps {
    const never = () => { throw new Error('not exercised'); };
    const manifest = { id: 'acme.lint', name: 'Acme Lint', version: '1.0.0', publisher: { name: 'Acme', keyId: 'k' }, mcpTools: [], capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [] };
    const tool = { name: 'lint', description: 'Lint', inputSchema: { type: 'object' }, run: 'tools/lint.js', process: 'subprocess' as const, gated: false };
    return {
        genie: { inbox: never as never, attention: never as never, roster: () => [], resolveCaller: () => null, workspaceSetting: never as never, userActive: () => true, glow: () => false, thumbsUp: () => {} },
        more: { knowledge: never as never, terminals: never as never, approve: async () => 'denied', resolveCaller: () => null },
        attention: { resolveCaller: () => null, openFile: async () => ({ ok: false, reason: 'x' }) },
        hosting: { resolveCaller: () => null, approve: async () => 'denied', services: null },
        processes: { resolveCaller: () => null, approve: async () => 'denied', processes: null },
        plugins: { plugins: { tools: () => [{ pluginId: 'acme.lint', dir: '/p', manifest: { ...manifest, mcpTools: [tool] }, tool }], guard: () => null }, run: never as never, approve: async () => 'denied', resolveCaller: () => null },
    };
}

describe('terminalId', () => {
    const tools = allGenieTools(deps()).map((r) => r.definition);
    const schemaOf = (d: (typeof tools)[number]) => d.inputSchema as { required?: string[]; properties?: Record<string, { description?: string }> };

    it('is required by NO tool — counted, the offenders named (the control: tools that take it exist)', () => {
        expect(tools.filter((d) => schemaOf(d).properties?.terminalId).length).toBe(14); // thirteen Genie tools (no runAgent sidecar since 2026-10-19; plan since 2026-10-20) + the plugin tool
        expect(tools.filter((d) => schemaOf(d).required?.includes('terminalId')).map((d) => d.name)).toEqual([]);
    });

    it('tells a Genie session to leave it out, and a terminal to pass GENIE_TERMINAL_ID', () => {
        const description = schemaOf(tools[0]!).properties!.terminalId!.description ?? '';
        expect(description).toMatch(/leave (it|this) out/i);
        expect(description).toMatch(/GENIE_TERMINAL_ID/);
    });
});

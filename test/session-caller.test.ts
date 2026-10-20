import { describe, expect, it } from 'vitest';
import { genieMcpServers } from '../src/main/mcp-callers.js';
import { allGenieTools, type AllToolsDeps } from '../src/main/mcp-registrations.js';

/**
 * A GENIE SESSION IS KNOWN BY A KEY THE MODEL CANNOT WRITE. Measured on the owner's machine (2026-10-13, the genie
 * agent's own transcript, after #227 made terminalId optional): the agent still passed `terminalId` — "genie", then its
 * own agent id — and every call came back "terminal genie is not one Genie knows". Genie had put the session's key in
 * `Mcp-Param-terminalId`, which is exactly the header the spec's `x-mcp-header` mirror fills from the model's
 * `terminalId` argument: Claude wrote the invented value over Genie's, and the server read the argument first anyway.
 * So the key rides its own header, `Mcp-Param-Genie-Session` (prism-mcp-server hands every `Mcp-Param-*` header to the
 * handler, lower-cased and unprefixed — README), which no tool declares as a mirror; when it is present it is the
 * caller, and whatever `terminalId` the model sends is ignored. Five copies of the caller check had drifted three ways
 * (two still said "terminalId is required", the plugin tools read a header nothing sends); there is one now.
 */
function deps(asked: string[]): AllToolsDeps {
    const never = () => { throw new Error('not exercised'); };
    const resolveCaller = (id: string) => { asked.push(id); return null; };
    const manifest = { id: 'acme.lint', name: 'Acme Lint', version: '1.0.0', publisher: { name: 'Acme', keyId: 'k' }, mcpTools: [], capabilities: { network: { hosts: [] }, genieApi: [] }, panels: [] };
    const tool = { name: 'lint', description: 'Lint', inputSchema: { type: 'object' }, run: 'tools/lint.js', process: 'subprocess' as const, gated: false };
    return {
        genie: { inbox: never as never, attention: never as never, roster: () => [], resolveCaller, workspaceSetting: never as never, userActive: () => true, glow: () => false, thumbsUp: () => {} },
        more: { knowledge: never as never, terminals: never as never, approve: async () => 'denied', resolveCaller },
        attention: { resolveCaller, openFile: async () => ({ ok: false, reason: 'x' }) },
        hosting: { resolveCaller, approve: async () => 'denied', services: null },
        processes: { resolveCaller, approve: async () => 'denied', processes: null },
        plugins: { plugins: { tools: () => [{ pluginId: 'acme.lint', dir: '/p', manifest: { ...manifest, mcpTools: [tool] }, tool }], guard: () => null }, run: never as never, approve: async () => 'denied', resolveCaller },
    };
}

/** Call every tool once with these arguments and headers; per tool, the ids Genie asked to resolve and the error text. */
async function callAll(args: Record<string, unknown>, headers: Record<string, string>) {
    const asked: string[] = [];
    const out: Array<{ name: string; asked: string[]; text: string }> = [];
    for (const r of allGenieTools(deps(asked))) {
        asked.length = 0;
        const result = await r.handler({ action: 'show', ...args } as never, { server: 'genie', tool: r.definition.name, headers });
        out.push({ name: r.definition.name, asked: [...asked], text: result.text });
    }
    return out;
}

describe('the session key', () => {
    it('rides Mcp-Param-Genie-Session — never Mcp-Param-terminalId, the header the terminalId argument writes', () => {
        expect(genieMcpServers({ url: 'http://127.0.0.1:4100/mcp', token: 't0k' }, 'session-abc')).toEqual([
            { type: 'http', name: 'genie', url: 'http://127.0.0.1:4100/mcp', headers: [{ name: 'Authorization', value: 'Bearer t0k' }, { name: 'Mcp-Param-Genie-Session', value: 'session-abc' }] },
        ]);
    });

    it('is the caller for EVERY tool, whatever terminalId the model invents — counted, the offenders named', async () => {
        const calls = await callAll({ terminalId: 'genie' }, { 'genie-session': 'session-k' });
        expect(calls.length).toBe(14); // thirteen Genie tools (no runAgent sidecar since 2026-10-19; plan since 2026-10-20) + the plugin tool
        expect(calls.filter((c) => c.asked.join() !== 'session-k').map((c) => `${c.name}: ${c.asked.join()}`)).toEqual([]);
    });

    it('a key Genie did not mint (an earlier run of Genie) says to restart the agent, not "terminal genie"', async () => {
        const calls = await callAll({ terminalId: 'genie' }, { 'genie-session': 'session-k' });
        for (const c of calls) {
            expect(c.text).not.toContain('terminal genie');
            expect(c.text).toMatch(/restart/i);
        }
    });

    it('the control: with no session key, a plain terminal is still known by its terminalId — every tool', async () => {
        const calls = await callAll({ terminalId: 'term_7' }, {});
        expect(calls.filter((c) => c.asked.join() !== 'term_7').map((c) => c.name)).toEqual([]);
        expect(calls.length).toBe(14);
    });

    it('with neither, one message everywhere: a session leaves it out, a terminal passes GENIE_TERMINAL_ID', async () => {
        const texts = new Set((await callAll({}, {})).map((c) => JSON.parse(c.text).error as string));
        expect([...texts]).toHaveLength(1);
        expect([...texts][0]).toMatch(/GENIE_TERMINAL_ID/);
    });
});

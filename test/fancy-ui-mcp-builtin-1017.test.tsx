import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_MCP_SERVERS, FANCY_UI_MCP, MCP_WORDS, builtInMcpFor, mcpRows, withMcpServer, withWorkspaceMcpServer, workspaceMcpRows } from '../src/core/agent-mcp.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { McpServerSwitches } from '../src/renderer/components/AgentSkills.js';

/**
 * GENIE PROVIDES THE FANCY DEV KIT MCP TO EVERY AGENT (Tynn #1017; the owner: "the fancy mcp needs to be provided by Genie so
 * all agents can have access to that. It should be able to be turned off though if devs don't want their agents using
 * it or taking up context. It is on by default.").
 *
 * The Fancy Dev Kit's hosted registry MCP (`fancy-ui`, https://ui.particle.academy/mcp: the fancy-ui plugin's own
 * config, confirmed by the fancy agent; public, read-only, no headers) is a BUILT-IN row in every workspace's MCP list:
 * listed before any session reports it, ON by default, with a switch. Off in a workspace: no session there is handed it.
 */
const show = (rows: readonly { name: string; required: boolean; on: boolean; inherited?: boolean; builtIn?: boolean }[]) =>
    rows.map((r) => `${r.name}:${r.required ? 'required' : r.on ? 'on' : 'off'}${r.builtIn ? ':built-in' : ''}${r.inherited ? ':inherited' : ''}`);
const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

describe('the server Genie provides', () => {
    it('is the Fancy Dev Kit registry, over streamable HTTP, with no headers', () => {
        expect(FANCY_UI_MCP).toEqual({ type: 'http', name: 'fancy-ui', url: 'https://ui.particle.academy/mcp', headers: [] });
        expect(BUILT_IN_MCP_SERVERS.map((s) => s.name)).toEqual(['fancy-ui']);
    });
});

describe('the built-in row', () => {
    it('a workspace lists it ON with no session having reported it, after Genie’s required ones', () => {
        expect(show(workspaceMcpRows({}))).toEqual(['genie:required', 'tynn:required', 'fancy-ui:on:built-in']);
    });

    it('switched off as the workspace default it stays listed, off, and switches back on', () => {
        const off = withWorkspaceMcpServer([], 'fancy-ui', false);
        expect(off).toEqual({ ok: true, mcpOff: ['fancy-ui'] });
        expect(show(workspaceMcpRows({ mcpOff: ['fancy-ui'] }))).toEqual(['genie:required', 'tynn:required', 'fancy-ui:off:built-in']);
        expect(withWorkspaceMcpServer(['fancy-ui'], 'fancy-ui', true)).toEqual({ ok: true, mcpOff: [] });
    });

    it('is listed once, even when a session reported it too', () => {
        expect(show(workspaceMcpRows({ mcpSeen: ['fancy-ui', 'github'] }))).toEqual(['genie:required', 'tynn:required', 'fancy-ui:on:built-in', 'github:on']);
    });

    it('an agent lists it, inheriting the workspace’s off', () => {
        expect(show(mcpRows({}))).toEqual(['genie:required', 'tynn:required', 'fancy-ui:on:built-in']);
        expect(show(mcpRows({}, ['fancy-ui']))).toEqual(['genie:required', 'tynn:required', 'fancy-ui:off:built-in:inherited']);
        const own = withMcpServer({}, 'fancy-ui', false);
        expect(own).toMatchObject({ ok: true, record: { mcpOff: ['fancy-ui'] } });
    });

    it('the page gives it a switch and says Genie provides it', () => {
        const html = renderToStaticMarkup(<McpServerSwitches rows={workspaceMcpRows({})} agentName="tynn" workspace onSet={async () => ({ ok: true })} />);
        const row = html.split('data-mcp-server="fancy-ui"')[1] ?? '';
        expect(row).toContain('role="switch"');
        expect(row).toContain('data-mcp-built-in=""');
        expect(row).toContain(MCP_WORDS.builtIn);
        expect(row).not.toContain('data-mcp-required');
    });

    // The owner: the product is the "Fancy Dev Kit", not "Fancy UI". The server's id stays `fancy-ui` (what providers
    // and the stored switches know it by); every word a person reads names the product.
    it('names the product, Fancy Dev Kit, in its label, its description and its switch; the id stays fancy-ui', () => {
        expect(workspaceMcpRows({})[2]).toMatchObject({ name: 'fancy-ui', label: 'Fancy Dev Kit', description: MCP_WORDS.fancyDevKit });
        expect(mcpRows({})[2]).toMatchObject({ name: 'fancy-ui', label: 'Fancy Dev Kit', description: MCP_WORDS.fancyDevKit });
        expect(MCP_WORDS.fancyDevKit).toMatch(/^The Fancy Dev Kit /);
        const html = renderToStaticMarkup(<McpServerSwitches rows={workspaceMcpRows({})} agentName="tynn" workspace onSet={async () => ({ ok: true })} />);
        const row = html.split('data-mcp-server="fancy-ui"')[1] ?? '';
        expect(row).toContain('<span data-mcp-label="" title="' + MCP_WORDS.fancyDevKit + '"');
        expect(row).toContain('>Fancy Dev Kit</span>');
        expect(row).toContain('aria-label="Fancy Dev Kit, on by default in tynn"');
        expect(row).toContain('>fancy-ui</span>');
        const agentHtml = renderToStaticMarkup(<McpServerSwitches rows={mcpRows({})} agentName="atlas" onSet={async () => ({ ok: true })} />);
        expect(agentHtml).toContain('aria-label="Fancy Dev Kit, on for atlas"');
        expect(`${html}${agentHtml}`).not.toMatch(/fancy[ -]?ui(?!<\/span>|")/i);
    });

    it('CONTROL: a server with no label keeps its id in its switch, and gets no label', () => {
        const html = renderToStaticMarkup(<McpServerSwitches rows={workspaceMcpRows({ mcpSeen: ['github'] })} agentName="tynn" workspace onSet={async () => ({ ok: true })} />);
        const row = html.split('data-mcp-server="github"')[1] ?? '';
        expect(row).toContain('aria-label="github, on by default in tynn"');
        expect(row).not.toContain('data-mcp-label');
    });
});

describe('which sessions are handed it', () => {
    const agent = (extra: Record<string, unknown> = {}) => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas' }), ...extra });

    it('on by default; not when the workspace or the agent has it off; the agent’s own on wins', () => {
        expect(builtInMcpFor(agent(), []).map((s) => s.name)).toEqual(['fancy-ui']);
        expect(builtInMcpFor(agent(), ['fancy-ui'])).toEqual([]);
        expect(builtInMcpFor(agent({ mcpOff: ['fancy-ui'] }), [])).toEqual([]);
        expect(builtInMcpFor(agent({ mcpOn: ['fancy-ui'] }), ['fancy-ui']).map((s) => s.name)).toEqual(['fancy-ui']);
    });
});

describe('the session host hands it to the provider', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-fancy-mcp-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    const GENIE: McpServer = { type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] };

    const launch = async (workspaceOff: readonly string[], deferred: boolean) => {
        const handed: Array<readonly McpServer[]> = [];
        const driverFor: DriverFor = (_r, _c, _s, extras) => { handed.push(extras?.mcpServers ?? []); return () => ({ start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null }); };
        const host = new SessionHost({
            userData: dir, driverFor, processTree: tree, stopGraceMs: 0, mcpServersFor: () => [GENIE],
            builtInMcpServers: BUILT_IN_MCP_SERVERS, workspaceMcpOffFor: () => workspaceOff,
            ...(deferred ? { prepareMcpServers: async () => [GENIE] } : {}),
        });
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas' });
        expect(host.start(record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(handed).toHaveLength(1));
        const probe = host.probe(record.id)?.mcpServers;
        host.stopAll(); await host.drained(0); await host.settled();
        return { servers: handed[0]!, probe };
    };

    for (const deferred of [false, true]) {
        it(`${deferred ? 'prepared' : 'direct'} start: handed it when on, and the session says so`, async () => {
            const on = await launch([], deferred);
            expect(on.servers).toEqual([GENIE, FANCY_UI_MCP]);
            expect(on.probe).toEqual(['genie', 'fancy-ui']);
        });

        it(`${deferred ? 'prepared' : 'direct'} start: not handed it when the workspace has it off`, async () => {
            const off = await launch(['fancy-ui'], deferred);
            expect(off.servers).toEqual([GENIE]);
            expect(off.probe).toEqual(['genie']);
        });
    }

    it('the host process gives its session host the built-in servers', () => {
        expect(src('src/main/genie-host.ts')).toMatch(/new SessionHost\(\{[\s\S]*?builtInMcpServers:\s*BUILT_IN_MCP_SERVERS/);
    });
});

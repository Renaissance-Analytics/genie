import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_WORDS, mcpOffFor, mcpRows, withMcpServer, withWorkspaceMcpServer, workspaceMcpRows } from '../src/core/agent-mcp.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { capabilityOf, REMOTE_METHODS, WORKSPACE_SCOPED_METHODS } from '../src/core/remote-protocol.js';
import { setMcpServer } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { McpServerSwitches } from '../src/renderer/components/AgentSkills.js';

/**
 * A WORKSPACE'S DEFAULT FOR MCP SERVERS, WHICH ITS AGENTS INHERIT (Tynn #628). A workspace keeps the servers that are
 * off by default for every agent in it. An agent with no choice of its own inherits; its own switch wins either way.
 * What is off for an agent, its own and inherited, is what its provider is told to leave out at its next session start.
 */
const captured = vi.hoisted(() => [] as Array<{ provider: string; options: Record<string, unknown> }>);
vi.mock('@particle-academy/prism-acp', async (original) => ({
    ...await original<typeof import('@particle-academy/prism-acp')>(),
    ClaudeDriver: class { constructor(options: Record<string, unknown>) { captured.push({ provider: 'claude', options }); } },
    CodexDriver: class { constructor(options: Record<string, unknown>) { captured.push({ provider: 'codex', options }); } },
}));
import { realDriverFor } from '../src/main/session-host.js';

const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const show = (rows: readonly { name: string; required: boolean; on: boolean; inherited?: boolean; overrides?: boolean }[]) =>
    rows.map((r) => `${r.name}:${r.required ? 'required' : r.on ? 'on' : 'off'}${r.inherited ? ':inherited' : ''}${r.overrides ? ':overrides' : ''}`);

describe('what an agent inherits', () => {
    it('a server its workspace has off is off for it, and its row says it is inherited', () => {
        expect(mcpOffFor({}, ['slack'])).toEqual(['slack']);
        expect(show(mcpRows({ mcpSeen: ['github'] }, ['slack']))).toEqual(['genie:required', 'tynn:required', 'github:on', 'slack:off:inherited']);
    });

    it('its own switch wins: on although the workspace has it off, and its row says so', () => {
        const on = withMcpServer({}, 'slack', true, ['slack']);
        expect(on).toMatchObject({ ok: true, record: { mcpOn: ['slack'], mcpOff: [] } });
        if (!on.ok) return;
        expect(mcpOffFor(on.record, ['slack'])).toEqual([]);
        expect(show(mcpRows(on.record, ['slack']))).toEqual(['genie:required', 'tynn:required', 'slack:on:overrides']);
    });

    it('its own off stays off when the workspace has it on', () => {
        const off = withMcpServer({ mcpSeen: ['github'] }, 'github', false, ['slack']);
        expect(off).toMatchObject({ ok: true, record: { mcpOff: ['github'] } });
        if (!off.ok) return;
        expect(mcpOffFor(off.record, ['slack'])).toEqual(['github', 'slack']);
        expect(show(mcpRows(off.record, ['slack']))).toEqual(['genie:required', 'tynn:required', 'github:off', 'slack:off:inherited']);
    });

    it('a choice equal to the workspace’s is not kept: the agent inherits again', () => {
        const back = withMcpServer({ mcpOn: ['slack'] }, 'slack', false, ['slack']);
        expect(back).toMatchObject({ ok: true, record: { mcpOn: [], mcpOff: [] } });
        const backOn = withMcpServer({ mcpOff: ['github'] }, 'github', true, ['slack']);
        expect(backOn).toMatchObject({ ok: true, record: { mcpOn: [], mcpOff: [] } });
    });

    it('Genie’s own is never off, whatever the workspace holds', () => {
        expect(mcpOffFor({}, ['genie', 'tynn', 'slack'])).toEqual(['slack']);
        expect(show(mcpRows({}, ['genie', 'slack'])).slice(0, 2)).toEqual(['genie:required', 'tynn:required']);
    });

    it('CONTROL: with no workspace default nothing is inherited', () => {
        expect(mcpOffFor({ mcpOff: ['slack'] })).toEqual(['slack']);
        expect(show(mcpRows({ mcpSeen: ['slack'] }))).toEqual(['genie:required', 'tynn:required', 'slack:on']);
    });
});

describe('the workspace’s own list', () => {
    it('Genie’s own required, then what its agents’ sessions reported and what it has off', () => {
        expect(show(workspaceMcpRows({ mcpSeen: ['github', 'genie'], mcpOff: ['slack'] }))).toEqual(['genie:required', 'tynn:required', 'github:on', 'slack:off']);
    });

    it('off, on again, and Genie’s own refused in words', () => {
        expect(withWorkspaceMcpServer([], 'slack', false)).toEqual({ ok: true, mcpOff: ['slack'] });
        expect(withWorkspaceMcpServer(['slack', 'github'], 'slack', true)).toEqual({ ok: true, mcpOff: ['github'] });
        expect(withWorkspaceMcpServer([], 'genie', false)).toEqual({ ok: false, reason: 'genie is Genie’s own server and stays on.' });
        expect(withWorkspaceMcpServer([], '', false)).toEqual({ ok: false, reason: 'Name the MCP server, and say on or off.' });
    });
});

describe('kept, and read at the next launch', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-ws-mcp-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const open = async () => { const r = new Registry(new Store(dir)); await r.load({ name: 'host', healthy: true }); return r; };

    it('the workspace’s default is kept across a reload and is one workspace’s only', async () => {
        const registry = await open();
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        await registry.addWorkspace({ id: 'fancy', path: '/w/fancy' });
        expect(await registry.setWorkspaceMcpServer('tynn', 'slack', false)).toEqual({ ok: true });
        expect(await registry.setWorkspaceMcpServer('tynn', 'genie', false)).toEqual({ ok: false, reason: 'genie is Genie’s own server and stays on.' });
        expect(await registry.setWorkspaceMcpServer('nowhere', 'slack', false)).toEqual({ ok: false, reason: 'no workspace nowhere' });
        const again = await open();
        expect(again.workspaceMcpOff('tynn')).toEqual(['slack']);
        expect(again.workspaceMcpOff('fancy')).toEqual([]);
        expect(again.snapshot().workspaces?.find((w) => w.id === 'tynn')).toMatchObject({ mcpOff: ['slack'] });
    });

    it('the snapshot’s workspace lists what its agents’ sessions reported', async () => {
        const registry = await open();
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const b = await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'bolt' });
        await registry.noteMcpSeen(a.id, ['slack']);
        await registry.noteMcpSeen(b.id, ['github', 'slack']);
        expect(registry.snapshot().workspaces?.find((w) => w.id === 'tynn')).toMatchObject({ mcpSeen: ['github', 'slack'] });
    });

    it('an agent’s switch is judged against its workspace’s default: on over an inherited off is kept as its own', async () => {
        const registry = await open();
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.setWorkspaceMcpServer('tynn', 'slack', false);
        expect(await setMcpServer({ registry } as never, a.id, 'slack', true)).toMatchObject({ ok: true });
        const again = await open();
        expect(again.find(a.id)).toMatchObject({ mcpOn: ['slack'] });
        expect(mcpOffFor(again.find(a.id)!, again.workspaceMcpOff('tynn'))).toEqual([]);
    });
});

describe('the options handed to the provider’s driver', () => {
    const GENIE = [
        { type: 'http' as const, name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] },
        { type: 'http' as const, name: 'tynn', url: 'https://tynn.ai/mcp/tynn', headers: [{ name: 'Authorization', value: 'Bearer synthetic-private' }] },
    ];
    for (const provider of ['claude', 'codex'] as const) {
        const agent = (more: { mcpOff?: readonly string[]; mcpOn?: readonly string[] } = {}) => ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider, name: 'atlas' }), ...more });
        const launched = (record: ReturnType<typeof agentRecord>, workspaceMcpOff?: readonly string[]) => {
            realDriverFor(record, '/workspace', null, { mcpServers: GENIE, ...(workspaceMcpOff ? { workspaceMcpOff } : {}) })!({ cwd: '/workspace', events: {} });
            return captured.at(-1)!.options.disabledMcpServers ?? [];
        };

        it(`${provider}: a server the workspace has off is disabled for an agent that made no choice`, () => {
            expect(launched(agent(), ['slack'])).toEqual(['slack']);
        });

        it(`${provider}: an agent that switched it on is launched with it; its own off is added to the workspace’s`, () => {
            expect(launched(agent({ mcpOn: ['slack'] }), ['slack'])).toEqual([]);
            expect(launched(agent({ mcpOff: ['github'] }), ['slack'])).toEqual(['github', 'slack']);
        });

        it(`${provider}: Genie’s own is never disabled by a workspace default; CONTROL: no default, nothing disabled`, () => {
            expect(launched(agent(), ['genie', 'tynn'])).toEqual([]);
            expect(launched(agent())).toEqual([]);
        });
    }

    it('the session host asks the registry for the workspace’s default before each launch', () => {
        const host = src('src/main/session-host.ts');
        expect(host.match(/workspaceMcpOff: this\.#workspaceMcpOffFor\?\.\(record\) \?\? \[\]/g) ?? []).toHaveLength(2);
        expect(host.match(/mcpPolicyOptions\(record, extras\?\.mcpServers \?\? \[\], extras\?\.workspaceMcpOff \?\? \[\]\)/g) ?? []).toHaveLength(2);
        expect(src('src/main/genie-host.ts')).toMatch(/workspaceMcpOffFor: \(record\) => hostRegistry\.workspaceMcpOff\(record\.workspaceId\)/);
    });
});

describe('the pages', () => {
    const row = (html: string, name: string) => { const at = html.indexOf(`data-mcp-server="${name}"`); return html.slice(at, html.indexOf('</li>', at)); };

    it('the agent’s row says an off is inherited from the workspace, and keeps its switch to override it', () => {
        const html = renderToStaticMarkup(<McpServerSwitches rows={mcpRows({}, ['slack'])} agentName="atlas" onSet={async () => ({ ok: true })} />);
        expect(row(html, 'slack')).toContain('Off, inherited from the workspace');
        expect(row(html, 'slack')).toMatch(/role="switch" aria-checked="false"/);
    });

    it('an override says what it overrides', () => {
        const html = renderToStaticMarkup(<McpServerSwitches rows={mcpRows({ mcpOn: ['slack'] }, ['slack'])} agentName="atlas" onSet={async () => ({ ok: true })} />);
        expect(row(html, 'slack')).toContain('On for this agent; the workspace has it off');
        expect(row(html, 'slack')).toMatch(/role="switch" aria-checked="true"/);
    });

    it('the workspace’s list says it is the default, where it comes from, and when a change applies', () => {
        const html = renderToStaticMarkup(<McpServerSwitches workspace rows={workspaceMcpRows({ mcpSeen: ['slack'] })} agentName="Tynn.ai" onSet={async () => ({ ok: true })} initialOutcome={{ name: 'slack', ok: true, text: MCP_WORDS.workspaceSaved }} />);
        expect(html).toContain('The default for every agent in this workspace; an agent’s own switch wins.');
        expect(html).toContain('A server that no session has reported yet is not listed.');
        expect(row(html, 'slack')).toContain('Saved. It applies the next time each agent here starts a session.');
        expect(row(html, 'genie')).toContain('Required by Genie');
    });

    it('nothing on either page says a server is blocked or cannot be used', () => {
        const agent = renderToStaticMarkup(<McpServerSwitches rows={mcpRows({ mcpOff: ['github'] }, ['slack'])} agentName="atlas" onSet={async () => ({ ok: true })} />);
        const workspace = renderToStaticMarkup(<McpServerSwitches workspace rows={workspaceMcpRows({ mcpOff: ['slack'] })} agentName="Tynn.ai" onSet={async () => ({ ok: true })} />);
        expect(`${agent}${workspace}`).not.toMatch(/blocked|cannot be used|can’t be used|prevented/i);
    });
});

describe('carried to every window', () => {
    it('a write, scoped to its workspace, in the protocol', () => {
        expect(REMOTE_METHODS).toContain('workspaces.setMcpServer' as never);
        expect(capabilityOf('workspaces.setMcpServer' as never)).toBe('write');
        expect(WORKSPACE_SCOPED_METHODS).toContain('workspaces.setMcpServer' as never);
    });

    it('the host answers it, both bridges ask it, and both pages are wired', () => {
        expect(src('src/main/host-api.ts')).toContain('return deps.workspaceOps.setMcpServer(str(args[0]), args[1], args[2]);');
        expect(src('src/main/workspace-lifecycle-api.ts')).toContain('setMcpServer: (id, name, on) => wiring.registry()!.setWorkspaceMcpServer(id, name, on).finally(touch),');
        expect(src('src/renderer/local-session.ts')).toContain('setMcpServer: (id, name, on) => request((ws) => ws.setMcpServer(id, name, on)),');
        expect(src('src/renderer/remote-bridge.ts')).toMatch(/setMcpServer: \(workspaceId, name, on\) => answer\('workspaces\.setMcpServer', workspaceId, name, on\)/);
        expect(src('src/renderer/components/Workspace.tsx')).toMatch(/<McpServerSwitches workspace rows=\{ops\.mcp\.rows\} agentName=\{name\} onSet=\{ops\.mcp\.onSet\} \/>/);
        expect(src('src/renderer/App.tsx')).toMatch(/mcp: mcpRows\(\{ mcpOff: detail\?\.agent\.mcpOff, mcpOn: detail\?\.agent\.mcpOn, mcpSeen: detail\?\.agent\.mcpSeen \}, detail\?\.agent\.workspaceMcpOff \?\? \[\]\)/);
    });
});

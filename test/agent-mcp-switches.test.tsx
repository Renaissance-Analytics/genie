import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_WORDS, mcpOffFor, mcpRows, withMcpSeen, withMcpServer } from '../src/core/agent-mcp.js';
import { AGENT_SCOPED_METHODS, capabilityOf, REMOTE_METHODS } from '../src/core/remote-protocol.js';
import { setMcpServer } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { mcpPolicyOptions } from '../src/main/session-host.js';
import { Store } from '../src/main/store.js';
import { McpServerSwitches } from '../src/renderer/components/AgentSkills.js';

/**
 * AN AGENT'S MCP SERVERS, SWITCHED ON AND OFF (Tynn #628; the owner, beta.61: "I need the ability to enable and disable
 * mcp … an agent can use … not just let claude or codex have all the stuff they ship with or get connected to on an
 * account level"). Per agent, kept on its record, and handed to its provider as disabled servers when its next session
 * starts (prism-acp's `disabledMcpServers`, for Claude Code and for Codex). Genie's own servers are never switched off.
 */
const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const show = (rows: readonly { name: string; required: boolean; on: boolean }[]) => rows.map((r) => `${r.name}:${r.required ? 'required' : r.on ? 'on' : 'off'}`);

describe('what is listed', () => {
    it('Genie’s own first and required; then every server a session reported, by name', () => {
        expect(show(mcpRows({ mcpSeen: ['slack', 'claude.ai Drive', 'genie', 'tynn', 'github'] }))).toEqual(['genie:required', 'tynn:required', 'claude.ai Drive:on', 'github:on', 'slack:on']);
    });

    it('a server switched off stays listed, off, so it can be switched back on; even one no longer reported', () => {
        expect(show(mcpRows({ mcpSeen: ['github'], mcpOff: ['slack'] }))).toEqual(['genie:required', 'tynn:required', 'github:on', 'slack:off']);
    });

    it('an agent with no session yet has Genie’s own alone', () => {
        expect(show(mcpRows({}))).toEqual(['genie:required', 'tynn:required']);
    });

    it('what a session reports is added to what was seen; nothing new is no change', () => {
        expect(withMcpSeen({ mcpSeen: ['github'] }, ['slack', 'github', 'genie'])?.mcpSeen).toEqual(['genie', 'github', 'slack']);
        expect(withMcpSeen({ mcpSeen: ['github', 'slack'] }, ['slack'])).toBeNull();
    });
});

describe('the switch', () => {
    it('off, then on again', () => {
        const off = withMcpServer({ mcpSeen: ['slack'] }, 'slack', false);
        expect(off).toMatchObject({ ok: true, record: { mcpOff: ['slack'] } });
        const on = withMcpServer({ mcpOff: ['slack', 'github'] }, 'slack', true);
        expect(on).toMatchObject({ ok: true, record: { mcpOff: ['github'] } });
    });

    it('Genie’s own cannot be switched off, and the refusal says so', () => {
        expect(withMcpServer({}, 'genie', false)).toEqual({ ok: false, reason: 'genie is Genie’s own server and stays on.' });
        expect(withMcpServer({}, 'tynn', false)).toEqual({ ok: false, reason: 'tynn is Genie’s own server and stays on.' });
    });

    it('a name that is not a server’s, or a value that is not on or off, is refused', () => {
        expect(withMcpServer({}, '', false)).toEqual({ ok: false, reason: 'Name the MCP server, and say on or off.' });
        expect(withMcpServer({}, 'slack', 'no')).toEqual({ ok: false, reason: 'Name the MCP server, and say on or off.' });
        expect(withMcpServer({}, 'a\nb', false)).toEqual({ ok: false, reason: 'Name the MCP server, and say on or off.' });
    });
});

describe('enforced where the session is launched', () => {
    const genie = [{ name: 'genie' }, { name: 'tynn' }];

    it('a switched-off server is in THAT agent’s disabled servers, and not in another agent’s', () => {
        expect(mcpPolicyOptions({ mcpOff: ['slack'] }, genie).disabledMcpServers).toEqual(['slack']);
        expect(mcpPolicyOptions({}, genie).disabledMcpServers ?? []).toEqual([]);
        expect(mcpPolicyOptions({ mcpOff: ['github'] }, genie).disabledMcpServers).toEqual(['github']);
    });

    it('Genie’s own server can never be in it, whatever the record holds', () => {
        const got = mcpPolicyOptions({ mcpOff: ['genie', 'tynn', 'slack'] }, genie).disabledMcpServers ?? [];
        expect(got).toEqual(['slack']);
        expect(mcpOffFor({ mcpOff: ['genie', 'tynn', 'slack', 'slack'] })).toEqual(['slack']);
    });

    it('CONTROL: with no Tynn server of Genie’s, an inherited one is still disabled (the rule from before), beside the agent’s own', () => {
        expect(mcpPolicyOptions({}, [{ name: 'genie' }]).disabledMcpServers).toEqual(['tynn']);
        expect(mcpPolicyOptions({ mcpOff: ['slack'] }, [{ name: 'genie' }]).disabledMcpServers).toEqual(['slack', 'tynn']);
    });

    it('both providers’ drivers are built with it, from the record being launched', () => {
        const host = src('src/main/session-host.ts');
        expect(host.match(/\.\.\.mcpPolicyOptions\(record, extras\?\.mcpServers \?\? \[\]\)/g) ?? []).toHaveLength(2);
        expect(host).not.toMatch(/inheritedPolicy/);
    });
});

describe('kept on the agent’s record', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-switch-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const open = async () => { const r = new Registry(new Store(dir)); await r.load({ name: 'host', healthy: true }); return r; };

    it('set through the host’s agent operation, kept across a reload, and one agent’s only', async () => {
        const registry = await open();
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const b = await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'bolt' });
        await registry.noteMcpSeen(a.id, ['slack', 'github']);
        expect(await setMcpServer({ registry } as never, a.id, 'slack', false)).toMatchObject({ ok: true });
        const again = await open();
        expect(again.find(a.id)).toMatchObject({ mcpOff: ['slack'], mcpSeen: ['github', 'slack'] });
        expect(again.find(b.id)?.mcpOff ?? []).toEqual([]);
        expect(mcpPolicyOptions(again.find(a.id)!, [{ name: 'genie' }, { name: 'tynn' }]).disabledMcpServers).toEqual(['slack']);
        expect(mcpPolicyOptions(again.find(b.id)!, [{ name: 'genie' }, { name: 'tynn' }]).disabledMcpServers ?? []).toEqual([]);
    });

    it('Genie’s own is refused in words and nothing is written; an agent that is not there is refused', async () => {
        const registry = await open();
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(await setMcpServer({ registry } as never, a.id, 'genie', false)).toEqual({ ok: false, reason: 'genie is Genie’s own server and stays on.' });
        expect(registry.find(a.id)?.mcpOff ?? []).toEqual([]);
        expect(await setMcpServer({ registry } as never, 'agent_nope', 'slack', false)).toMatchObject({ ok: false });
    });
});

describe('the page', () => {
    const rows = mcpRows({ mcpSeen: ['slack', 'github'], mcpOff: ['slack'] });
    const draw = (more: Partial<Parameters<typeof McpServerSwitches>[0]> = {}) => renderToStaticMarkup(<McpServerSwitches rows={rows} agentName="atlas" onSet={async () => ({ ok: true })} {...more} />);
    const row = (html: string, name: string) => { const at = html.indexOf(`data-mcp-server="${name}"`); return html.slice(at, html.indexOf('</li>', at)); };

    it('Genie’s own: required, said, and no switch', () => {
        const r = row(draw(), 'genie');
        expect(r).toContain('Required by Genie');
        expect(r).not.toMatch(/role="switch"/);
    });

    it('any other server: a switch, on or off as kept', () => {
        expect(row(draw(), 'github')).toMatch(/role="switch" aria-checked="true"/);
        expect(row(draw(), 'slack')).toMatch(/role="switch" aria-checked="false"/);
    });

    it('says where the list comes from, and that a server never reported cannot be listed yet', () => {
        expect(draw()).toContain('This list is Genie’s own servers and every server one of atlas’s sessions reported when it started. A server that no session has reported yet is not listed, and cannot be switched off here until it is.');
    });

    it('a change says when it applies; a failure is said in its words; a change under way shows progress', () => {
        expect(row(draw({ initialOutcome: { name: 'slack', ok: true, text: MCP_WORDS.saved('atlas') } }), 'slack')).toContain('Saved. It applies the next time atlas starts a session.');
        expect(row(draw({ initialOutcome: { name: 'slack', ok: false, text: 'The host did not answer.' } }), 'slack')).toMatch(/role="alert"[^>]*>The host did not answer\./);
        const busy = row(draw({ initialBusy: 'slack' }), 'slack');
        expect(busy).toMatch(/data-mcp-busy=""/);
        expect(busy).toContain('Saving…');
    });

    it('CONTROL: a window that cannot change them shows the list and no switch', () => {
        const html = renderToStaticMarkup(<McpServerSwitches rows={rows} agentName="atlas" />);
        expect(html).toContain('data-mcp-server="github"');
        expect(html).not.toMatch(/role="switch"/);
    });
});

describe('carried to every window', () => {
    it('a write, scoped to its agent, in the protocol', () => {
        expect(REMOTE_METHODS).toContain('agents.setMcpServer' as never);
        expect(capabilityOf('agents.setMcpServer' as never)).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setMcpServer' as never);
    });

    it('the host answers it, both bridges ask it, and what a session reports is kept', () => {
        expect(src('src/main/host-api.ts')).toContain('return deps.agentOps.setMcpServer(args[0], args[1], args[2]);');
        expect(src('src/renderer/local-session.ts')).toContain('setMcpServer: (id, name, on) => requestAgent((agents) => agents.setMcpServer(id, name, on))');
        expect(src('src/renderer/remote-bridge.ts')).toMatch(/setMcpServer: \(agentId, name, on\) => answer\('agents\.setMcpServer', agentId, name, on\)/);
        expect(src('src/main/main.ts')).toMatch(/noteMcpSeen\(agentId, reports\.map\(\(r\) => r\.name\)\)/);
    });

    it('the agent’s Skills page draws the switches from its record', () => {
        expect(src('src/renderer/components/AgentView.tsx')).toMatch(/<McpServerSwitches rows=\{ops\.mcp\} agentName=\{agent\.name\} onSet=\{ops\.onSetMcpServer\} \/>/);
    });
});

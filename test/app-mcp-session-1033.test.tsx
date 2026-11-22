import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_MCP_WORDS, type AppMcpEntry } from '../src/core/app-mcp.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { REMOTE_METHODS, AGENT_SCOPED_METHODS } from '../src/core/remote-protocol.js';
import { setAppMcp, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { AppMcpServers } from '../src/renderer/components/AgentSkills.js';

/**
 * AN AGENT'S APP MCP SERVERS REACH ITS SESSION (Tynn #1033): handed through the same per-session MCP path as genie and
 * tynn (SessionHost `appMcpServersFor`, after Genie's own, never in their place), on the direct start and the prepared one.
 * The person's own path is the agent's settings: `agents.setAppMcp`, and an "App MCP" list there.
 */
const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

describe('the session host hands them to the provider', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-app-mcp-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    const GENIE: McpServer = { type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] };
    const SHOP: McpServer = { type: 'http', name: 'shop', url: 'http://127.0.0.1:41001/mcp', headers: [] };

    const launch = async (app: readonly McpServer[], deferred: boolean) => {
        const handed: Array<readonly McpServer[]> = [];
        const asked: AgentRecord[] = [];
        const driverFor: DriverFor = (_r, _c, _s, extras) => { handed.push(extras?.mcpServers ?? []); return () => ({ start: () => {}, prompt: () => {}, kill: () => {}, cliSessionId: null }); };
        const host = new SessionHost({
            userData: dir, driverFor, processTree: tree, stopGraceMs: 0, mcpServersFor: () => [GENIE],
            appMcpServersFor: (record) => { asked.push(record); return app; },
            ...(deferred ? { prepareMcpServers: async () => [GENIE] } : {}),
        });
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'scout' });
        expect(host.start(record, dir)).toEqual({ ok: true });
        await vi.waitFor(() => expect(handed).toHaveLength(1));
        const probe = host.probe(record.id)?.mcpServers;
        host.stopAll(); await host.drained(0); await host.settled();
        return { servers: handed[0]!, probe, asked };
    };

    for (const deferred of [false, true]) {
        it(`${deferred ? 'prepared' : 'direct'} start: Genie’s own first, then the agent’s app servers; the session lists them`, async () => {
            const got = await launch([SHOP], deferred);
            expect(got.servers).toEqual([GENIE, SHOP]);
            expect(got.probe).toEqual(['genie', 'shop']);
            expect(got.asked).toHaveLength(1);
        });

        it(`${deferred ? 'prepared' : 'direct'} start: an app server never takes the place of one of Genie’s own`, async () => {
            const got = await launch([{ ...SHOP, name: 'genie' }], deferred);
            expect(got.servers).toEqual([GENIE]);
        });

        it(`${deferred ? 'prepared' : 'direct'} start, CONTROL: none, and only Genie’s own are handed`, async () => {
            expect((await launch([], deferred)).servers).toEqual([GENIE]);
        });
    }

    it('the host process resolves them per launch from the agent’s CURRENT record, its sites, the router and the trust verdict', () => {
        const host = src('src/main/genie-host.ts');
        expect(host).toMatch(/new SessionHost\(\{[\s\S]*?appMcpServersFor:/);
        expect(host).toMatch(/appMcpServersFor\(hostRegistry\.find\(record\.id[\s\S]{0,40}\?\? record/);
        expect(host).toMatch(/trusted: !hostUntrustedNow\(record\)/);
    });
});

describe('the person’s path: agents.setAppMcp', () => {
    const SITES = [{ id: 's1', name: 'shop', host: 'shop.gen' }];
    const ports = () => {
        let record = { ...agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'scout' }) } as AgentRecord;
        const writes: Array<readonly AppMcpEntry[]> = [];
        const p = {
            registry: {
                find: (id: string) => (id === record.id ? record : null),
                setAppMcp: async (_id: string, list: readonly AppMcpEntry[]) => { writes.push(list); record = { ...record, appMcp: list } as AgentRecord; return record; },
            },
            appSites: () => SITES,
        } as unknown as AgentOpsPorts;
        return { p, writes, id: () => record.id };
    };

    it('adds a site’s /mcp and removes it again; each change is written to the record', async () => {
        const t = ports();
        expect(await setAppMcp(t.p, t.id(), { add: { site: 'shop' } })).toMatchObject({ ok: true });
        expect(t.writes).toEqual([[{ name: 'shop', site: 's1', path: '/mcp' }]]);
        expect(await setAppMcp(t.p, t.id(), { remove: 'shop' })).toMatchObject({ ok: true });
        expect(t.writes.at(-1)).toEqual([]);
    });

    it('refuses what is not local, and writes nothing', async () => {
        const t = ports();
        expect(await setAppMcp(t.p, t.id(), { add: { url: 'https://mcp.example.com/mcp' } })).toEqual({ ok: false, reason: APP_MCP_WORDS.localOnly });
        expect(t.writes).toEqual([]);
    });

    it('is a write, scoped to the agent, in the remote protocol', () => {
        expect(REMOTE_METHODS).toContain('agents.setAppMcp');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setAppMcp');
    });
});

describe('the App MCP list in the agent’s settings', () => {
    const draw = (over: Partial<Parameters<typeof AppMcpServers>[0]> = {}) => renderToStaticMarkup(
        <AppMcpServers
            agentName="scout"
            entries={[{ name: 'shop', site: 's1', path: '/mcp' }]}
            candidates={[
                { kind: 'site', name: 'shop', site: 's1', label: 'shop.gen', url: 'https://shop.gen/mcp', added: true },
                { kind: 'process', name: 'api', label: 'api', url: 'http://127.0.0.1:7000/mcp', added: false },
            ]}
            onChange={async () => ({ ok: true })}
            {...over}
        />,
    );

    it('lists what it has, each with Remove; offers what it does not, each with Add; and a local URL field', () => {
        const html = draw();
        expect(html).toContain('data-rail="app-mcp"');
        expect(html).toContain('App MCP');
        const own = html.split('data-app-mcp="shop"')[1]?.split('</li>')[0] ?? '';
        expect(own).toContain('shop.gen/mcp');
        expect(own).toContain('>Remove<');
        const offer = html.split('data-app-mcp-candidate="api"')[1]?.split('</li>')[0] ?? '';
        expect(offer).toContain('http://127.0.0.1:7000/mcp');
        expect(offer).toContain('>Add<');
        expect(html).not.toContain('data-app-mcp-candidate="shop"');
        expect(html).toContain('data-field="app-mcp-url"');
        expect(html).toContain(APP_MCP_WORDS.note('scout'));
    });

    it('CONTROL: with no onChange it is the list alone, no buttons', () => {
        const html = draw({ onChange: undefined });
        expect(html).toContain('data-app-mcp="shop"');
        expect(html).not.toContain('>Remove<');
        expect(html).not.toContain('data-field="app-mcp-url"');
    });
});

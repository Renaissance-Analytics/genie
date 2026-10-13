import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { parseRoute } from '../src/core/route.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { AgentView } from '../src/renderer/components/AgentView.js';
import { mcpToolsList } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * WHAT AN AGENT'S GENIE MCP GIVES IT, ON SCREEN (the owner: "I have no way to check to see what it even should have
 * available"). Settings lists every tool Genie's MCP serves, with what each does. An agent's rail says whether its
 * session was STARTED with Genie's MCP (the servers the session host handed the driver — a fact, not a hope), with a
 * door to that list; a session started without it says so, and an agent not running says nothing.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-mcpvis-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const tree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const driverFor: DriverFor = () => (() => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } })) as SessionDriverFactory;

describe('the session records the servers it was started with', () => {
    it('their names on the live session; none given is an empty list (positive control)', () => {
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const given = new SessionHost({ userData: dir, driverFor, processTree: tree, mcpServersFor: () => [{ type: 'http', name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] }] });
        given.start(r, dir);
        expect(given.probe(r.id)?.mcpServers).toEqual(['genie']);
        const none = new SessionHost({ userData: dir, driverFor, processTree: tree });
        none.start(r, dir);
        expect(none.probe(r.id)?.mcpServers).toEqual([]);
    });
});

describe('the Agent view rail', () => {
    const session = (mcpServers: readonly string[] | undefined) => ({ running: true, turnState: 'idle' as const, startedAt: null, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...(mcpServers ? { mcpServers } : {}) });
    const render = (s: ReturnType<typeof session> | null) => renderToStaticMarkup(
        <AgentView agent={{ id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared', cwd: '.' }} session={s} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 1} />,
    );

    it('says the session was given Genie\'s MCP, with the door to its tools; or that it was not', () => {
        expect(render(session(['genie']))).toMatch(/data-rail-mcp="given"[\s\S]*Genie’s MCP — given to this session[\s\S]*data-door="mcp-tools"/);
        expect(render(session([]))).toMatch(/data-rail-mcp="missing"[^>]*>[\s\S]*not given Genie’s MCP/);
        expect(render(null)).not.toContain('data-rail-mcp');
    });

    it('the door is the Settings group that lists the tools', () => {
        expect(parseRoute('genie://settings/mcp')).toMatchObject({ surface: 'settings', group: 'workstation' });
    });
});

describe('Settings lists what every agent gets', () => {
    it('each tool by name with what it does; none known says so', () => {
        const html = renderToStaticMarkup(mcpToolsList([{ name: 'imDone', description: 'Tell the human you are finished.' }, { name: 'agentinbox', description: 'Send and receive agent mail.' }]));
        expect(html).toMatch(/data-mcp-tool="imDone"[\s\S]*Tell the human you are finished\./);
        expect(html).toMatch(/data-mcp-tool="agentinbox"/);
        expect(html).toMatch(/data-mcp-tools="2"/);
        expect(renderToStaticMarkup(mcpToolsList([]))).toContain('No tools are registered.');
    });
});

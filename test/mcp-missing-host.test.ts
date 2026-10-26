import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/** prism-acp 0.27.0's MCP server report reaches the host's owner with the agent it is about (genie#1202). */
let dir: string;
let events: DriverEvents | null = null;
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const driverFor: DriverFor = () => {
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-mcp-missing-')); events = null; });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

it('a session update carrying particle.academy/mcp_servers is reported with its agent; one without is not', () => {
    const seen: Array<{ agentId: AgentId; names: string[] }> = [];
    const host = new SessionHost({ userData: dir, driverFor, processTree: noTree, onMcpServers: (agentId, reports) => seen.push({ agentId, names: reports.map((r) => `${r.name}:${r.status}:${r.toolCount}`) }) });
    const a = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'kai' });
    host.start(a, dir);
    events!.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'info', message: 'Claude session started' }, _meta: { 'particle.academy/mcp_servers': [{ name: 'tynn', status: 'connected', toolCount: 0 }, { name: 'genie', status: 'connected', toolCount: 19 }] } });
    events!.onUpdate?.({ sessionUpdate: 'notice', notice: { level: 'info', message: 'something else' } });
    expect(seen).toEqual([{ agentId: a.id, names: ['tynn:connected:0', 'genie:connected:19'] }]);
    host.stopAll();
});

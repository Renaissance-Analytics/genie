import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { CallerBook, genieMcpServers } from '../src/main/mcp-callers.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * GENIE'S MCP, HANDED TO EVERY AGENT SESSION (the owner: "the genie mcp doesn't seem to be available to an agent").
 * Two causes, both fixed here. An agent found Genie only through config-synced files (`.mcp.json`) whose URL goes stale
 * whenever the port changes; now each session is started with Genie's server in its `mcpServers` (prism-acp 0.7.0).
 * And every Genie tool identified its caller by a Take Over TERMINAL id, which an agent session does not have, so
 * imDone / ForceTheQuestion / AgentInbox refused every agent; now each agent has its own unguessable caller key, sent
 * the way a terminal id is (`Mcp-Param-terminalId`), and it resolves to that agent.
 */
describe('the caller book', () => {
    it('one key per agent, stable for the run, distinct between agents, not guessable from the id; unknown keys resolve to nothing', () => {
        const book = new CallerBook();
        const a = book.keyFor('agent_a');
        expect(book.keyFor('agent_a')).toBe(a);
        expect(book.keyFor('agent_b')).not.toBe(a);
        expect(a).toMatch(/^session-[0-9a-f]{32}$/);
        expect(a).not.toContain('agent_a');
        expect(book.agentFor(a)).toBe('agent_a');
        expect(book.agentFor('session-0000')).toBeNull();
        expect(book.agentFor('agent_a')).toBeNull();
    });
});

describe('the server entry', () => {
    it('Genie over HTTP with its bearer token and the agent\'s caller key; no endpoint, no entry', () => {
        expect(genieMcpServers({ url: 'http://127.0.0.1:4100/mcp', token: 't0k' }, 'session-abc')).toEqual([
            { type: 'http', name: 'genie', url: 'http://127.0.0.1:4100/mcp', headers: [{ name: 'Authorization', value: 'Bearer t0k' }, { name: 'Mcp-Param-Genie-Session', value: 'session-abc' }] },
        ]);
        expect(genieMcpServers(null, 'session-abc')).toEqual([]);
    });
});

describe('a session starts with them', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-sesmcp-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

    it('the driver factory is given the agent\'s servers; without the port it is given none (positive control)', () => {
        const seen: unknown[] = [];
        const driverFor: DriverFor = (_r, _cwd, _resume, extras) => {
            seen.push(extras?.mcpServers ?? 'none');
            return (() => ({ start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } })) as SessionDriverFactory;
        };
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const servers = [{ type: 'http' as const, name: 'genie', url: 'http://127.0.0.1:1/mcp', headers: [] }];
        new SessionHost({ userData: dir, driverFor, processTree: tree, mcpServersFor: (record) => (record.id === r.id ? servers : []) }).start(r, dir);
        new SessionHost({ userData: dir, driverFor, processTree: tree }).start(r, dir);
        expect(seen).toEqual([servers, []]);
    });
});

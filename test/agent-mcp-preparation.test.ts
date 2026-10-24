import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
const GENIE: McpServer = { type: 'http', name: 'genie', url: 'http://127.0.0.1:12345/mcp', headers: [] };
const TOKEN = `rpk_${'0'.repeat(26)}.${'a'.repeat(64)}`;
const TYNN: McpServer = { type: 'http', name: 'tynn', url: 'https://tynn.ai/mcp/tynn', headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }] };
let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-mcp-prepare-')); });
afterEach(async () => { for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); } await rm(dir, { recursive: true, force: true }); });

function fixture(provider: 'claude' | 'codex' = 'codex') {
    const preparation = deferred<readonly McpServer[]>();
    const readiness = deferred<void>();
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider, name: 'atlas' });
    const created: Array<{ id: string; servers: readonly McpServer[] }> = [];
    const started: number[] = []; const sent: Array<{ id: string; content: unknown }> = [];
    const killed: number[] = []; const spawns: Array<readonly number[]> = [];
    const events = new Map<string, DriverEvents>();
    let signal: AbortSignal | undefined;
    let inTurn = false;
    let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
    const neighbor: ProcessInfo = { pid: process.pid + 2_000_000, ppid: process.pid, started: 2, name: 'other-agent' };
    const tree: ProcessTree = {
        snapshot: () => [...processes],
        killTree: (targets) => { killed.push(...targets.map((p) => p.pid)); const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
    };
    const driverFor: DriverFor = (agent, _cwd, _resume, extras) => {
        created.push({ id: agent.id, servers: extras?.mcpServers ?? [] });
        return ({ events: callbacks }) => {
            const pid = process.pid + 1_000_000 + created.length;
            events.set(agent.id, { ...callbacks, onTurnEnd: (outcome) => { inTurn = false; callbacks.onTurnEnd?.(outcome); } });
            return {
                start: () => { started.push(pid); processes.push({ pid, ppid: process.pid, started: 3, name: `${agent.provider}-fixture` }); },
                prompt: (content) => { if (provider === 'codex' && inTurn) throw new Error('turn already running'); inTurn = true; sent.push({ id: agent.id, content }); },
                kill: () => { processes = processes.filter((p) => p.pid !== pid); },
                cliSessionId: null, ready: readiness.promise,
            };
        };
    };
    const options: ConstructorParameters<typeof SessionHost>[0] & {
        prepareMcpServers(agent: typeof record, cwd: string, signal: AbortSignal): Promise<readonly McpServer[]>;
    } = {
        userData: dir, driverFor, processTree: tree, stopGraceMs: 0, mcpServersFor: () => [GENIE],
        prepareMcpServers: async (_record, _cwd, cancel) => { signal = cancel; return preparation.promise; },
        lifecycle: { spawned: (_id, _run, children) => { spawns.push(children.map((p) => p.pid)); }, ended: () => {}, straggler: () => {} },
    };
    const host = new SessionHost(options); hosts.push(host);
    return { host, record, preparation, readiness, created, started, sent, killed, spawns, events, neighbor,
        addNeighbor: () => { processes.push(neighbor); }, processes: () => [...processes], signal: () => signal };
}

describe('agent-specific MCP is ready before provider launch', () => {
    for (const provider of ['claude', 'codex'] as const) {
        it(`${provider} waits for its private MCP context before constructing or starting the provider`, async () => {
            const t = fixture(provider);
            expect(t.host.start(t.record, dir)).toEqual({ ok: true });
            expect(t.created).toEqual([]); expect(t.started).toEqual([]);
            t.preparation.resolve([GENIE, TYNN]); t.readiness.resolve();
            await vi.waitFor(() => expect(t.started).toHaveLength(1));
            expect(t.created[0]?.servers).toEqual([GENIE, TYNN]);
            expect(t.host.probe(t.record.id)?.mcpServers).toEqual(['genie', 'tynn']);
            expect(JSON.stringify(t.host.probe(t.record.id))).not.toContain(TOKEN);
        });
    }

    it('keeps input queued through both preparation and the real driver handshake, then sends FIFO once', async () => {
        const t = fixture(); t.host.start(t.record, dir);
        expect(t.host.deliver(t.record.id, 'first', 'peer-one')).toBe(true);
        expect(t.host.deliver(t.record.id, 'second', 'peer-two')).toBe(true);
        await t.host.settled(); expect(t.sent).toEqual([]);
        t.preparation.resolve([GENIE, TYNN]);
        await vi.waitFor(() => expect(t.started).toHaveLength(1));
        expect(t.sent).toEqual([]);
        t.readiness.resolve();
        await vi.waitFor(() => expect(t.sent.map((p) => p.content)).toEqual(['first']));
        t.events.get(t.record.id)!.onTurnEnd!({ stopReason: 'end_turn', isError: false, raw: 'end_turn' });
        await vi.waitFor(() => expect(t.sent.map((p) => p.content)).toEqual(['first', 'second']));
    });

    it('Stop cancels preparation and a later result never creates or launches a provider', async () => {
        const t = fixture(); t.host.start(t.record, dir);
        await vi.waitFor(() => expect(t.signal()).toBeDefined());
        expect(t.host.stop(t.record.id, { graceful: false })).toBe(true);
        expect(t.signal()?.aborted).toBe(true);
        t.preparation.resolve([GENIE, TYNN]); t.readiness.resolve();
        await t.host.ended(t.record.id); await Promise.resolve(); await Promise.resolve();
        expect(t.created).toEqual([]); expect(t.started).toEqual([]);
        expect(await t.host.ended(t.record.id)).toMatchObject({ verified: true, ended: 0 });
    });

    it('an immediate Stop never begins preparation in a later microtask', async () => {
        const t = fixture(); t.host.start(t.record, dir);
        t.host.stop(t.record.id, { graceful: false });
        await t.host.ended(t.record.id); await Promise.resolve(); await Promise.resolve();
        expect(t.signal()).toBeUndefined();
        expect(t.created).toEqual([]); expect(t.started).toEqual([]);
    });

    it('tracks the actual delayed spawn without claiming another agent that started during preparation', async () => {
        const t = fixture(); t.host.start(t.record, dir); t.addNeighbor();
        t.preparation.resolve([GENIE, TYNN]); t.readiness.resolve();
        await vi.waitFor(() => expect(t.started).toHaveLength(1));
        const own = t.started[0]!;
        expect(t.processes().some((p) => p.pid === own)).toBe(true);
        expect(t.spawns.at(-1)).toEqual([own]);
        t.host.stop(t.record.id, { graceful: false });
        expect(await t.host.ended(t.record.id)).toMatchObject({ verified: true, ended: 1 });
        expect(t.killed).toContain(own); expect(t.killed).not.toContain(t.neighbor.pid);
        expect(t.processes().map((p) => p.pid)).toContain(t.neighbor.pid);
        expect(t.processes().map((p) => p.pid)).not.toContain(own);
    });

    it('a failed preparation creates no provider and never exposes a credential from its exception', async () => {
        const t = fixture(); t.host.start(t.record, dir);
        t.preparation.reject(new Error(`credential lookup failed ${TOKEN}`));
        await vi.waitFor(() => expect(t.host.probe(t.record.id)?.failure).toBeTruthy());
        expect(t.created).toEqual([]); expect(t.started).toEqual([]);
        expect(JSON.stringify(t.host.probe(t.record.id))).not.toContain(TOKEN);
    });
});

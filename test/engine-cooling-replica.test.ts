import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { COOLING_MS, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * COOLING THROUGH THE HOST'S REPLICA (the host split × #1433). Cooling is derived on the session (core/session.ts) and sent
 * in its probe; with the agent engine in genie-host the window reads a REPLICA of that probe. So the window must see the
 * same three steps the host does: Working, Cooling once the turn ends, and Idle when the 15 s wait ends — the last one
 * pushed by the host on its own timer, with nothing asked of it.
 */

const TOKEN = 'cooling-token';
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

const fakes = new Map<string, DriverEvents>();
const driverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        fakes.set(record.id, options.events);
        return { start: () => {}, prompt: () => {}, kill: () => {}, cancel: () => {}, cliSessionId: null };
    };
    return factory;
};

let dir: string;
let host: SessionHost;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-cooling-replica-'));
    fakes.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('Cooling, as the window reads it from genie-host', () => {
    it('Working → Cooling when the turn ends → Idle when the wait ends, each step pushed to the window', async () => {
        // State pushes coalesced on an immediate schedule (no fake-clock wait between a change and its push).
        const server = new SessionEngineServer({ token: TOKEN, build: 't', schedule: (_ms, fn) => { const t = setImmediate(fn); return () => clearImmediate(t); } });
        host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree, ...server.hostOptions() });
        server.attach(host);
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        const client = new SessionEngineClient();
        expect(await client.connect(windowSide, TOKEN)).toMatchObject({ ok: true });

        const r = agentRecord({ id: mintAgentId(), workspaceId: 'pa', provider: 'claude', name: 'atlas' });
        expect(await client.start(r, dir)).toEqual({ ok: true });
        expect(await client.prompt(r.id as AgentId, 'go', 'you')).toBe(true);
        await settle();
        expect(client.probe(r.id as AgentId)?.turnState).toBe('working');
        expect(client.probe(r.id as AgentId)?.cooling).toBe(false); // CONTROL: not cooling while it works

        fakes.get(r.id)!.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        await settle();
        expect(host.probe(r.id as AgentId)?.cooling).toBe(true);
        expect(client.probe(r.id as AgentId)?.cooling).toBe(true);
        expect(client.probe(r.id as AgentId)?.turnState).toBe('idle');

        vi.advanceTimersByTime(COOLING_MS);
        await settle();
        expect(host.probe(r.id as AgentId)?.cooling).toBe(false);
        expect(client.probe(r.id as AgentId)?.cooling).toBe(false);
    });
});

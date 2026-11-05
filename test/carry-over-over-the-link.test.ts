import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE CARRY-OVER'S ROWS COME OVER THE ENGINE LINK (Tynn story #380, the coordinator's 7E rule: the window never reads the
 * host's files). The host owns and writes each agent's thread log; a window reading that JSONL from disk could read a torn
 * append, and a remote window could not read it at all. So the window asks the host — `historyRows`, bounded — and the
 * host reads its own store. What it answers carries no tool input or output and no thinking: the carry-over never uses
 * them, and they are the bulk of a ledger.
 */
let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-carry-link-')); });
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const TOKEN = 'carry-token';

function rig() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((o: { events: DriverEvents }) => {
        events = o.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const server = new SessionEngineServer({ token: TOKEN, build: 't' });
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree, ...server.hostOptions() });
    hosts.push(host);
    server.attach(host);
    return { server, host, events: () => events };
}

describe('historyRows over the link', () => {
    it('answers the agent’s recorded rows, bounded, read by the host from its own store — no tool input/output, no thinking', async () => {
        const r = rig();
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        r.host.start(record, dir);
        r.host.prompt(record.id, 'Fix the login bug', 'you');
        r.events().onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read src/login.ts', status: 'completed', rawInput: { path: 'SECRET-INPUT' }, rawOutput: 'SECRET-OUTPUT' } as never);
        r.events().onUpdate?.({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE-THOUGHT' } } as never);
        r.events().onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found it.' } } as never);
        r.events().onTurnEnd?.({ stopReason: 'end_turn' } as never);
        await r.host.settled();

        const [h, w] = memoryPair();
        r.server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        const ask = (client as unknown as { historyRows?: (id: string, o: { limit: number }) => Promise<readonly { event: Record<string, unknown>; at: number | null }[]> }).historyRows;
        expect(ask, 'SessionEngineClient.historyRows').toBeTypeOf('function');
        const rows = await vi.waitFor(async () => {
            const got = await ask!.call(client, record.id, { limit: 3000 });
            expect(got.some((x) => x.event['kind'] === 'message' && x.event['text'] === 'Found it.')).toBe(true);
            return got;
        }, { timeout: 3000 });
        // Positive control: the person's words and the tool's title are there.
        expect(rows.some((x) => x.event['kind'] === 'message' && x.event['text'] === 'Fix the login bug')).toBe(true);
        expect(rows.some((x) => x.event['kind'] === 'tool' && x.event['title'] === 'Read src/login.ts')).toBe(true);
        const wire = JSON.stringify(rows);
        expect(wire).not.toContain('SECRET-INPUT');
        expect(wire).not.toContain('SECRET-OUTPUT');
        expect(wire).not.toContain('PRIVATE-THOUGHT');
        // Bounded: never more rows than asked.
        expect((await ask!.call(client, record.id, { limit: 2 })).length).toBeLessThanOrEqual(2);
    });
});

describe('the window never reads the host’s thread logs', () => {
    // Comment lines dropped by LINE, CRLF-safe: a guard that matched a comment would pass on prose.
    const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    it('main.ts opens no session store and reads no history (the Doctor’s own offline module is the one exception, by name)', () => {
        expect(code('src/main/main.ts')).not.toMatch(/openDurableStore|readHistory\(/);
        // Positive control: the Doctor's module does read it, so the pattern is the right one.
        expect(code('src/main/doctor-data.ts')).toMatch(/openDurableStore/);
    });

    it('the switch’s history port asks the engine', () => {
        expect(code('src/main/main.ts')).toMatch(/history: [^\n]*historyRows\(/);
    });
});

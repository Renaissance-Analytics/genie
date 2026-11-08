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
// ---- PROBE (throwaway, never merged): time each phase of this file's hooks and its long-ledger test on Windows.
const probeT = () => performance.now();
const probeLog = (phase: string, ms: number) => console.log(`GENIE-PROBE file=carry phase=${phase} ms=${Math.round(ms)} test="${String(expect.getState().currentTestName ?? '?')}"`);
beforeEach(async () => { const t = probeT(); dir = await mkdtemp(join(tmpdir(), 'genie2-carry-link-')); probeLog('before-mkdtemp', probeT() - t); });
afterEach(async () => {
    let t = probeT();
    await Promise.all(hosts.splice(0).map((h) => h.settled()));
    probeLog('after-settled', probeT() - t);
    t = probeT();
    await rm(dir, { recursive: true, force: true });
    probeLog('after-rm', probeT() - t);
});
const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const TOKEN = 'carry-token';

function rig() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((o: { events: DriverEvents }) => {
        events = o.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const server = new SessionEngineServer({ token: TOKEN, build: 't' });
    // No hostOptions: their MCP preparation defers the driver, and this test drives the driver's events at once.
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree });
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
        const ask = askOf(client);
        const rows = await vi.waitFor(async () => {
            const got = (await ask(record.id, { limit: 3000, maxBytes: 128 * 1024 })).rows ?? [];
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
        expect(((await ask(record.id, { limit: 2, maxBytes: 128 * 1024 })).rows ?? []).length).toBeLessThanOrEqual(2);
    });

    it('a long ledger: the reply stays under the byte bound, keeps the NEWEST rows in order, and says it cut; a caller asking more is held to the host’s ceiling', async () => {
        const r = rig();
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        let pt = probeT();
        r.host.start(record, dir);
        probeLog('long-start', probeT() - pt); pt = probeT();
        // 120 turns of an 8 KB reply: about a megabyte of ledger.
        for (let n = 1; n <= 120; n += 1) {
            r.host.prompt(record.id, `question ${n}`, 'you');
            r.events().onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${n} ${'x'.repeat(8000)}` } } as never);
            r.events().onTurnEnd?.({ stopReason: 'end_turn' } as never);
        }
        probeLog('long-120-turns-sync', probeT() - pt); pt = probeT();
        await r.host.settled();
        probeLog('long-settled', probeT() - pt); pt = probeT();
        const [h, w] = memoryPair();
        r.server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        probeLog('long-connect', probeT() - pt); pt = probeT();
        const ask = askOf(client);
        const bytes = (rows: unknown) => Buffer.byteLength(JSON.stringify(rows ?? []), 'utf8');

        const small = await vi.waitFor(async () => {
            const got = await ask(record.id, { limit: 3000, maxBytes: 64 * 1024 });
            expect((got.rows ?? []).some((x) => x.event['text'] === 'question 120')).toBe(true);
            return got;
        }, { timeout: 5000 });
        probeLog('long-first-ask', probeT() - pt); pt = probeT();
        expect(bytes(small.rows)).toBeLessThanOrEqual(64 * 1024);
        expect(small.cut).toBe(true);
        // The newest kept, in order: the last turn's question before its answer, and nothing from the start.
        const texts = (small.rows ?? []).flatMap((x) => (x.event['kind'] === 'message' ? [String(x.event['text']).split(' ').slice(0, 2).join(' ')] : []));
        expect(texts.at(-2)).toBe('question 120');
        expect(texts.at(-1)).toBe('answer 120');
        expect(texts).not.toContain('question 1');

        // Asking for 10 MB is held to the host's ceiling (256 KiB).
        const greedy = await ask(record.id, { limit: 3000, maxBytes: 10 * 1024 * 1024 });
        expect(bytes(greedy.rows)).toBeLessThanOrEqual(256 * 1024);
        expect(greedy.cut).toBe(true);
        // Control: a bound that holds everything cuts nothing.
        const all = await ask(record.id, { limit: 5, maxBytes: 128 * 1024 });
        expect(all.cut).toBe(false);
        expect((all.rows ?? []).length).toBe(5);
        probeLog('long-other-asks', probeT() - pt);
    });
});

type Reply = { rows?: readonly { event: Record<string, unknown>; at: number | null }[]; cut?: boolean };
/** The client's `historyRows`, reached loosely: before it exists or changes shape, these are red by assertion. */
function askOf(client: SessionEngineClient): (id: string, o: { limit: number; maxBytes: number }) => Promise<Reply> {
    const fn = (client as unknown as { historyRows?: (id: string, o: { limit: number; maxBytes: number }) => Promise<unknown> }).historyRows;
    expect(fn, 'SessionEngineClient.historyRows').toBeTypeOf('function');
    return async (id, o) => {
        const got = await fn!.call(client, id, o);
        return Array.isArray(got) ? {} : (got as Reply);
    };
}

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
        // It asks for what a carry-over needs, never the whole ledger.
        expect(code('src/main/main.ts')).toMatch(/historyRows\(record\.id, \{ limit: CARRY_OVER_ROWS, maxBytes: CARRY_OVER_BYTES \}\)/);
    });
});

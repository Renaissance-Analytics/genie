import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { ClientTransport } from '../src/core/remote-protocol.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { applyPatch, NOT_CONNECTED, SessionEngineClient, type EngineClientOptions } from '../src/main/session-engine-client.js';
import { adoptWindowEnv, SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE AGENT ENGINE BEHIND THE PROTOCOL (the host split, phase 1).
 *
 * A REAL SessionHost (only the provider driver is fake, as in session-host.test.ts) sits behind the server; the window's
 * client reads it through the protocol over an in-memory transport. The claim under test is that the client is the same
 * session host to main.ts: every read it answers equals what the host itself answers, after every command, and nothing
 * a window needs is lost when the window goes away.
 */

const TOKEN = 'a'.repeat(64);
let dir: string;
let host: SessionHost;
let server: SessionEngineServer;
const drivers = new Map<string, DriverEvents>();
let prompts: string[] = [];

const fakeDriverFor: DriverFor = (record) => {
    const factory: SessionDriverFactory = (options) => {
        drivers.set(record.id, options.events);
        return { start: () => {}, prompt: (text: unknown) => { prompts.push(String(text)); }, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

const record = (over: Partial<Parameters<typeof agentRecord>[0]> = {}): AgentRecord =>
    agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'codex', name: 'atlas', ...over });

/** The host's coalescing timer, run by hand: a test says when the host pushes. */
let timers: Array<() => void> = [];
const runTimers = (): void => { const due = timers; timers = []; for (const fn of due) fn(); };
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) { runTimers(); await new Promise((r) => setTimeout(r, 0)); } };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-engine-'));
    drivers.clear();
    prompts = [];
    timers = [];
    server = new SessionEngineServer({ token: TOKEN, build: 'test', schedule: (_ms, fn) => { timers.push(fn); return () => { timers = timers.filter((t) => t !== fn); }; } });
    host = new SessionHost({ userData: dir, driverFor: fakeDriverFor, processTree: noProcessTree, ...server.hostOptions() });
    server.attach(host);
});

afterEach(async () => {
    await host.stopAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function window(options: EngineClientOptions = {}): Promise<{ client: SessionEngineClient; transport: ClientTransport }> {
    const [hostSide, windowSide] = memoryPair();
    server.accept(hostSide);
    const client = new SessionEngineClient(options);
    const result = await client.connect(windowSide, TOKEN);
    expect(result).toMatchObject({ ok: true });
    return { client, transport: windowSide };
}

/** A started agent whose (deferred) driver is up: `start` prepares its MCP servers through the window first. */
async function started(client: SessionEngineClient, r: AgentRecord): Promise<DriverEvents> {
    expect(await client.start(r, dir)).toEqual({ ok: true });
    for (let i = 0; i < 50 && !drivers.has(r.id); i += 1) await settle();
    const events = drivers.get(r.id);
    if (!events) throw new Error('the driver never started');
    return events;
}

describe('the handshake', () => {
    it('REFUSES a wrong token and closes, and the client says why', async () => {
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        let closed = false;
        windowSide.onClose(() => { closed = true; });
        const result = await new SessionEngineClient().connect(windowSide, 'b'.repeat(64));
        expect(result).toEqual({ ok: false, reason: 'this host does not know that token' });
        await settle();
        expect(closed).toBe(true);
        expect(server.clients).toBe(0);
    });

    it('welcomes the right token with its protocol, build and pid', async () => {
        const { client } = await window();
        expect(client.welcome).toMatchObject({ protocol: 1, build: 'test', pid: process.pid });
        expect(server.clients).toBe(1);
    });
});

describe('the replica reads what the host answers', () => {
    it('after an awaited start, the probe, the run and the started list already match the host (state before answers)', async () => {
        const { client } = await window();
        const r = record();
        expect(await client.start(r, dir)).toEqual({ ok: true });
        // No settle: the host pushed the start's effect BEFORE its answer, on the same ordered link.
        expect(client.runOf(r.id)).toBe(host.runOf(r.id));
        expect(client.runOf(r.id)).not.toBeNull();
        expect(client.probe(r.id)?.running).toBe(true);
        expect(client.startedIds()).toEqual(host.startedIds());
        expect(client.count).toBe(1);
    });

    it('a refused start answers the host\'s reason, and the refusal is in the replica', async () => {
        const { client } = await window();
        const r = record();
        const answer = await client.start(r, join(dir, 'missing-folder'));
        expect(answer.ok).toBe(false);
        expect(answer).toEqual({ ok: false, reason: host.refusals.get(r.id) });
        expect(client.refusals.get(r.id)).toBe(host.refusals.get(r.id));
    });

    it('streamed chunks arrive as patches: rows equal the host\'s, unchanged rows keep their identity, the array grows in place', async () => {
        const { client } = await window();
        const r = record();
        const events = await started(client, r);
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on ' } });
        events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'npm test' });
        await settle();
        const before = client.rowsFor(r.id);
        expect(before).toEqual(host.rowsFor(r.id));
        const first = before[0];
        const length = before.length;

        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'it' } });
        await settle();
        const after = client.rowsFor(r.id);
        expect(after).toEqual(host.rowsFor(r.id));
        // Grown in place (the session host's own rule), so main's push finds what changed by identity.
        expect(after).toBe(before);
        expect(after.length).toBe(length + 1);
        expect(after[0]).toBe(first);
    });

    it('the ledger is sent only once the window reads it, then equals the host\'s ledger after every change', async () => {
        const { client } = await window();
        const r = record();
        const events = await started(client, r);
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
        await settle();
        // Not watched yet: nothing of the ledger was sent.
        expect(client.ledgerFor(r.id)).toEqual([]);
        await settle();
        expect(client.ledgerFor(r.id)).toEqual(host.ledgerFor(r.id));
        expect(client.ledgerFor(r.id).length).toBeGreaterThan(0);
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } });
        events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        await settle();
        expect(client.ledgerFor(r.id)).toEqual(host.ledgerFor(r.id));
        expect(client.lastTurnEnd(r.id)).toBe(host.lastTurnEnd(r.id));
        expect(client.turnsEndedThisRun(r.id)).toBe(host.turnsEndedThisRun(r.id));
        expect(client.promptable(r.id)).toBe(host.promptable(r.id));
    });

    it('an awaited prompt is in the replica\'s rows when it answers', async () => {
        const { client } = await window();
        const r = record();
        await started(client, r);
        expect(await client.prompt(r.id, 'run the suite', 'you')).toBe(true);
        expect(client.rowsFor(r.id)).toEqual(host.rowsFor(r.id));
        expect(JSON.stringify(client.rowsFor(r.id))).toContain('run the suite');
    });

    it('a stop: the replica reads not running once the stop answers, and ended() is the host\'s verdict', async () => {
        const { client } = await window();
        const r = record();
        await started(client, r);
        expect(await client.stop(r.id)).toBe(true);
        expect(await client.ended(r.id)).toEqual(await host.ended(r.id));
        await settle();
        expect(client.runOf(r.id)).toBeNull();
        expect(client.probe(r.id)).toBeNull();
        expect(client.startedIds()).toEqual([]);
    });

    it('the window\'s comms cell is added on read (the inbox is the window\'s in phase 1)', async () => {
        const { client } = await window({ comms: () => ({ collaborators: 2, commsAgeSeconds: 5, links: [] }) });
        const r = record();
        await started(client, r);
        expect(client.probe(r.id)).toMatchObject({ collaborators: 2, commsAgeSeconds: 5 });
    });
});

describe('the host asks the window, and tells it', () => {
    it('an agent\'s MCP servers are prepared BY THE WINDOW (its secrets) before its driver starts', async () => {
        const asked: string[] = [];
        const { client } = await window({ prepareMcpServers: async (rec) => { asked.push(rec.id); return []; } });
        const r = record();
        await started(client, r);
        expect(asked).toEqual([r.id]);
    });

    it('a thread id reaches the window\'s onThreadId', async () => {
        const seen: Array<[string, string]> = [];
        const { client } = await window({ onThreadId: (id, thread) => seen.push([id, thread]) });
        const r = record();
        await started(client, r);
        server.callback({ name: 'threadId', agentId: r.id, threadId: 'thread_1' });
        await settle();
        expect(seen).toEqual([[r.id, 'thread_1']]);
    });

    it('a thread id while NO window is connected is queued and given to the next window — a crash never loses a resume', async () => {
        server.callback({ name: 'threadId', agentId: 'agent_x', threadId: 'thread_kept' });
        server.callback({ name: 'action', agentId: 'agent_x', kind: 'replied' }); // a moment's sound: not kept
        const seen: string[] = [];
        const actions: string[] = [];
        await window({ onThreadId: (_id, thread) => seen.push(thread), onAction: (_id, kind) => actions.push(kind) });
        await settle();
        expect(seen).toEqual(['thread_kept']);
        expect(actions).toEqual([]);
    });
});

describe('the window goes away; the agent does not', () => {
    it('a window that closes leaves the session running on the host, and the next window adopts it with its rows', async () => {
        const first = await window();
        const r = record();
        const events = await started(first.client, r);
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
        await settle();
        first.transport.close(); // the window crashed
        await settle();
        expect(server.clients).toBe(0);
        // The agent kept working with no window.
        events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't9', name: 'Bash', title: 'while nobody watched' });
        expect(host.probe(r.id)?.running).toBe(true);

        const second = await window();
        expect(second.client.runOf(r.id)).toBe(host.runOf(r.id));
        expect(second.client.rowsFor(r.id)).toEqual(host.rowsFor(r.id));
        expect(JSON.stringify(second.client.rowsFor(r.id))).toContain('while nobody watched');
    });

    it('commands with no host connected answer the refusal and never reject', async () => {
        const client = new SessionEngineClient();
        const r = record();
        await expect(client.start(r, dir)).resolves.toEqual({ ok: false, reason: NOT_CONNECTED });
        await expect(client.prompt(r.id, 'x')).resolves.toBe(false);
        await expect(client.stop(r.id)).resolves.toBe(false);
        await expect(client.cancel(r.id)).resolves.toEqual({ ok: false, reason: 'refused' });
        await expect(client.deliverOwed(r.id)).resolves.toBe(0);
        await expect(client.ended(r.id)).resolves.toBeNull();
        await expect(client.drained(10)).resolves.toBeUndefined();
        expect(client.probe(r.id)).toBeNull();
    });

    it('an agent that stopped while the window was away reads stopped in the next window', async () => {
        const first = await window();
        const r = record();
        await started(first.client, r);
        const kept = first.client;
        first.transport.close();
        await settle();
        host.stop(r.id as AgentId);
        await host.ended(r.id as AgentId);
        // The same client reconnects (main reconnects its one client).
        const [hostSide, windowSide] = memoryPair();
        server.accept(hostSide);
        expect(await kept.connect(windowSide, TOKEN)).toMatchObject({ ok: true });
        expect(kept.runOf(r.id)).toBeNull();
        expect(kept.probe(r.id)).toBeNull();
    });
});

describe('the window\'s environment reaches the host before each start (hot-swappable toolchain)', () => {
    it('adds, changes and removes what the window has, and never touches what is the host\'s own', () => {
        const target: NodeJS.ProcessEnv = { PATH: '/old', GONE: 'x', ELECTRON_RUN_AS_NODE: '1', GENIE_HOME: '/h' };
        adoptWindowEnv(target, { PATH: '/repaired', NPM_CONFIG_PREFIX: '/npm', ELECTRON_RUN_AS_NODE: '0' }, 'linux');
        expect(target).toEqual({ PATH: '/repaired', NPM_CONFIG_PREFIX: '/npm', ELECTRON_RUN_AS_NODE: '1', GENIE_HOME: '/h' });
    });

    it('compares names as Windows does (Path and PATH are one variable)', () => {
        const target: NodeJS.ProcessEnv = { Path: 'C:/old' };
        adoptWindowEnv(target, { PATH: 'C:/new' }, 'win32');
        expect(Object.values(target)).toEqual(['C:/new']);
    });

    it('a start carries the window\'s environment of that moment', async () => {
        const seen: Array<Record<string, string>> = [];
        const [hostSide, windowSide] = memoryPair();
        // A host-side spy on the frames: what engine.start carried.
        const send = windowSide.send.bind(windowSide);
        windowSide.send = (text: string) => { const f = JSON.parse(text) as { method?: string; args?: unknown[] }; if (f.method === 'engine.start') seen.push(f.args?.[3] as Record<string, string>); send(text); };
        server.accept(hostSide);
        let path = '/before';
        const client = new SessionEngineClient({ env: () => ({ ...process.env, PATH: path }) });
        await client.connect(windowSide, TOKEN);
        path = '/after-repair';
        // The host here is THIS process: its PATH is put back whatever happens.
        const original = { ...process.env };
        try {
            await client.start(record(), join(dir, 'missing'));
        } finally {
            adoptWindowEnv(process.env, Object.fromEntries(Object.entries(original).filter((e): e is [string, string] => typeof e[1] === 'string')));
        }
        expect(seen[0]?.PATH).toBe('/after-repair');
    });
});

describe('applyPatch keeps the session host\'s identity rules', () => {
    const row = (id: string) => ({ id, event: { kind: 'notice', level: 'info', message: id } as never, at: 1 });

    it('an append or a replaced last row grows the SAME array; anything else is a new one', () => {
        const a = row('a'), b = row('b'), c = row('c');
        const held = applyPatch(null, { base: null, keep: 0, append: [a, b] }, 1);
        const appended = applyPatch(held, { base: 1, keep: 2, append: [c] }, 2);
        expect(appended.rows).toBe(held.rows);
        expect(appended.rows).toEqual([a, b, c]);
        const b2 = row('b2');
        const replaced = applyPatch(appended, { base: 2, keep: 2, append: [b2] }, 3);
        expect(replaced.rows).toBe(held.rows);
        expect(replaced.rows[0]).toBe(a);
        const rebuilt = applyPatch(replaced, { base: 3, keep: 0, append: [c] }, 4);
        expect(rebuilt.rows).not.toBe(held.rows);
        expect(rebuilt.rows).toEqual([c]);
    });
});

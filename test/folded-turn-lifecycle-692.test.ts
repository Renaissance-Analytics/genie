import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { COOLING_MS, type DriverEvents, type SessionDriverFactory, type TurnOutcomeLike } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { wireInboxPush } from '../src/main/inbox-push.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost } from '../src/main/session-host.js';

/**
 * Release-independent #692 regressions: the current #1927 workaround is expected to make these pass. This pins the
 * observable lifecycle before adoption, using the current driver's held callback order from #684. Once the typed
 * release exists this fixture must follow its measured reporting contract; it does not invent that unreleased API.
 * The unchanged real-driver / stand-in CLI scenario in turn-end-held-real-driver-684.test.ts runs alongside this file.
 */
const END: TurnOutcomeLike = { stopReason: 'end_turn', isError: false, raw: 'end_turn' };
const processTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise<void>((done) => setImmediate(done)); };

let dir: string;
let host: SessionHost | undefined;
let client: SessionEngineClient | undefined;
let unwire: (() => void) | undefined;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-folded-lifecycle-692-'));
    host = undefined;
    client = undefined;
    unwire = undefined;
    // Only display timers are advanced. Transport, persistence and microtasks remain real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(async () => {
    unwire?.();
    vi.useRealTimers();
    client?.disconnect();
    host?.stopAll();
    await host?.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function open() {
    let events: DriverEvents = {};
    let alive = true;
    const prompts: string[] = [];
    const pending: Array<{ index: number; outcome: TurnOutcomeLike | null }> = [];
    const flush = () => {
        while (pending.length > 0 && pending[0]!.outcome !== null) events.onTurnEnd?.(pending.shift()!.outcome!);
    };
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return {
            start: () => {}, kill: () => { alive = false; },
            prompt: (text) => { pending.push({ index: prompts.length, outcome: null }); prompts.push(String(text)); },
            get running() { return alive; }, cliSessionId: null,
        };
    };
    const result = (index: number) => {
        events.onUpdate?.({ sessionUpdate: 'usage_update', used: 1200, size: 200000,
            _meta: { 'particle.academy/usage': { scope: 'turn', inputTokens: 10, outputTokens: 20 } } });
        const prompt = pending.find((p) => p.index === index);
        if (prompt) prompt.outcome = END;
        flush();
    };
    const server = new SessionEngineServer({ token: 'folded-692', build: 'test',
        schedule: (_ms, fire) => { const tick = setImmediate(fire); return () => clearImmediate(tick); } });
    const owner = new SessionHost({ processTree, userData: dir, driverFor: () => factory, ...server.hostOptions() });
    host = owner;
    server.attach(owner);
    const [hostLink, windowLink] = memoryPair();
    server.accept(hostLink);
    const replica = new SessionEngineClient();
    client = replica;
    expect(await replica.connect(windowLink, 'folded-692')).toMatchObject({ ok: true });
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'fixture', provider: 'claude', name: 'scout' });
    const id = record.id as AgentId;
    expect(await replica.start(record, dir)).toEqual({ ok: true });
    await settle();
    const finished = () => owner.rowsFor(id).flatMap(({ event }) => event.kind === 'finished' ? [event.n] : []);
    const persistedFinished = async () => {
        await owner.settled();
        const rows = await openAgentThread(openDurableStore(sessionsDir(dir)), id).messages();
        return rows.filter((row) => (row.message as { kind: string }).kind === 'finished');
    };
    return { owner, replica, id, prompts, result, finished, persistedFinished,
        exit: (code: number) => { alive = false; events.onExit?.(code, null); } };
}

/** The first turn ends, but the folded prompt has no outcome, so the old driver holds the next turn's callback. */
async function foldOne(s: Awaited<ReturnType<typeof open>>) {
    expect(await s.replica.prompt(s.id, 'first turn', 'you')).toBe(true); // index 0
    expect(await s.replica.prompt(s.id, 'fold this into it', 'you')).toBe(true); // index 1
    s.result(0);
    await settle();
    expect(s.finished()).toEqual([1]);
}

describe('a provider-ended folded sequence reaches the window and the automatic inbox push (Tynn #692)', () => {
    it('the next turn leaves Working, reads Cooling for 15 seconds, then pushes Idle without another read request', async () => {
        const s = await open();
        await foldOne(s);
        expect(await s.replica.prompt(s.id, 'the next ordinary turn', 'you')).toBe(true); // index 2
        await settle();
        expect(s.replica.probe(s.id)).toMatchObject({ turnState: 'working', cooling: false });
        s.result(2); // result exists, but its callback is behind the folded prompt
        await settle();
        expect(s.finished()).toEqual([1, 2]);
        expect(s.replica.probe(s.id)).toMatchObject({ turnState: 'idle', cooling: true });
        vi.advanceTimersByTime(COOLING_MS - 1);
        await settle();
        expect(s.replica.probe(s.id)?.cooling).toBe(true);
        vi.advanceTimersByTime(1);
        await settle();
        expect(s.replica.probe(s.id)).toMatchObject({ turnState: 'idle', cooling: false });
        expect(s.finished()).toEqual([1, 2]);
    });

    it('automatic mail after a folded notice starts and settles its own turn without a person sending input', async () => {
        const s = await open();
        let onSend: ((to: string) => void) | undefined;
        let due = false, sending = false;
        const settled: boolean[] = [];
        unwire = wireInboxPush({
            inbox: { onSend: (listener) => { onSend = listener; return () => { onSend = undefined; }; } },
            host: s.owner,
            reminders: ({ run }) => {
                if (!due || sending || run(s.id) === null) return [];
                sending = true;
                return [{ agentId: s.id, text: 'AgentInbox delivery: 1 message' }];
            },
            settled: (_id, delivered) => { settled.push(delivered); sending = false; if (delivered) due = false; },
        });
        expect(await s.replica.prompt(s.id, 'first turn', 'you')).toBe(true); // index 0
        due = true; onSend!(s.id); // automatic notice, index 1, folded into the first turn
        expect(s.prompts).toHaveLength(2);
        s.result(0);
        await settle();
        expect(settled).toEqual([true]);
        expect(s.finished()).toEqual([1]);

        vi.advanceTimersByTime(COOLING_MS);
        await settle();
        expect(s.replica.probe(s.id)).toMatchObject({ turnState: 'idle', cooling: false });
        due = true; onSend!(s.id); // index 2: the inbox starts the next turn, with no client.prompt
        expect(s.prompts).toHaveLength(3);
        expect(s.owner.inTurn(s.id)).toBe(true);
        s.result(2);
        await settle();
        expect(settled).toEqual([true, true]);
        expect(due).toBe(false);
        expect(s.finished()).toEqual([1, 2]);
        expect(s.replica.probe(s.id)).toMatchObject({ turnState: 'idle', cooling: true });
    });

    it.each([0, 1])('a provider exiting with code %i before any result cannot leave its replica Working or Cooling', async (code) => {
        const s = await open();
        expect(await s.replica.prompt(s.id, 'work with no final report', 'you')).toBe(true);
        await settle();
        expect(s.replica.probe(s.id)).toMatchObject({ running: true, turnState: 'working' });
        s.exit(code);
        await settle();
        expect(s.replica.probe(s.id)).toMatchObject({ running: false, turnState: 'stopped', cooling: false });
        expect(await s.persistedFinished()).toEqual([]); // exit is not a claimed successful reply
    });

    it('a person stopping a provider before its report clears Working without inventing a finished turn', async () => {
        const s = await open();
        expect(await s.replica.prompt(s.id, 'work with no final report', 'you')).toBe(true);
        await settle();
        expect(s.replica.probe(s.id)).toMatchObject({ running: true, turnState: 'working' });
        expect(await s.replica.stop(s.id, { graceful: false })).toBe(true);
        await settle();
        expect(s.replica.probe(s.id)).toBeNull(); // Stop removes the session, and the pushed replica must remove it too.
        expect(await s.persistedFinished()).toEqual([]);
    });
});

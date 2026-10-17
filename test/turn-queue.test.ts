import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';

/**
 * ONE PROMPT, ONE TURN, ONE NUMBER (the owner, 2026-10-14, pointing at the Turns column: Turn 30 twice, Turn 29 three
 * times, Turn 25 three times). Measured in the owner's own record: markers read `10, 10, 10, 10, 11, 12, 14, 14…`. A
 * prompt sent mid-turn was marked with the RUNNING turn's number, and the provider ran it as its own turn later, which
 * ended unmarked, so the count skipped. A queued prompt is marked when its turn starts.
 *
 * The markers are read after the thread's writes SETTLE, never on a clock: a 1 s waitFor read [] under a loaded batch
 * (2026-10-17, Tynn #790).
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { descendantsOf: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-turnq-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const prompts: unknown[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: (t) => { prompts.push(t); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree });
    session.start();
    const end = (isError = false) => events.onTurnEnd?.({ stopReason: isError ? null : 'end_turn', isError, raw: isError ? 'api error' : null });
    const markers = async () => (await openAgentThread(store, id).messages())
        .map((r) => r.message as { kind: string; n?: number; by?: string | null })
        .filter((e) => e.kind === 'turn')
        .map((e) => `${e.n}:${e.by ?? '-'}`);
    return { session, end, markers, prompts, events: () => events };
}

describe('prompts sent while a turn runs', () => {
    it('each gets its OWN number, written when its turn starts; nothing repeats, nothing is skipped', async () => {
        const { session, end, markers, prompts } = open();
        session.prompt('first', 'you');
        session.prompt('while you work', 'you');
        session.prompt('from a peer', 'kai');
        // Every prompt still reaches the provider at once; only its MARKER waits.
        expect(prompts).toHaveLength(3);
        await session.settled();
        expect(await markers()).toEqual(['1:you']);

        end();
        expect(session.turnState).toBe('working');
        end();
        expect(session.turnState).toBe('working');
        end();
        expect(session.turnState).toBe('idle');

        // COUNTED: three turns, numbered 1, 2, 3, each by whoever sent it.
        await session.settled();
        expect(await markers()).toEqual(['1:you', '2:you', '3:kai']);
        expect(session.turns).toBe(3);
    });

    it('POSITIVE CONTROL: prompts one after another (each after the last ended) are numbered in order, as before', async () => {
        const { session, end, markers } = open();
        session.prompt('a', 'you');
        end();
        session.prompt('b', 'you');
        end();
        await session.settled();
        expect(await markers()).toEqual(['1:you', '2:you']);
    });

    it('a CRASHED turn drops the queue: nothing is assumed to run after it, and the failure stands', async () => {
        const { session, end, markers } = open();
        session.prompt('a', 'you');
        session.prompt('queued', 'you');
        end(true);
        expect(session.turnState).toBe('failed');
        await session.settled();
        expect(await markers()).toEqual(['1:you']);
        // The next prompt starts the next number.
        session.prompt('again', 'you');
        await session.settled();
        expect(await markers()).toEqual(['1:you', '2:you']);
    });

    it('a turn the agent starts itself after the queue drains still gets the next number', async () => {
        const { session, end, markers, events } = open();
        session.prompt('a', 'you');
        session.prompt('b', 'you');
        end();
        end();
        events().onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a background task finished' } });
        await session.settled();
        expect(await markers()).toEqual(['1:you', '2:you', '3:-']);
    });
});

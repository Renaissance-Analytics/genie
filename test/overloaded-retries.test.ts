import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, OVERLOAD_RETRY_MS, OVERLOAD_RESUME_PROMPT, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';

/**
 * AN OVERLOADED PROVIDER IS WAITED OUT, NOT CALLED BROKEN (the owner, 2026-10-23, a Codex agent reading "Broken ·
 * 8h 45m · serverOverloaded": "we need to catch codex errors like this one"). prism-acp sorts Codex's
 * `codexErrorInfo: serverOverloaded` and Claude's 529 `overloaded_error` into `failure.kind: 'overloaded'`; Genie handled
 * `rate_limit`, `auth` and `billing` and let `overloaded` fall through to Broken, where the agent sat for nine hours.
 * Overload is the provider's, and it passes: Genie says so in the chat, waits (30 s, then doubling), and sends the turn
 * on again — the person's own queued messages if there are any, else "continue". Five overloads in a row and it gives
 * up: THEN Broken, with the reason. A turn that goes through resets the count.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-overload-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const prompts: string[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: (t: string) => { prompts.push(t); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({
        agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree,
        retryLater: (ms, fire) => { timers.push({ ms, fire }); return () => {}; },
    });
    session.start();
    const overloaded = () => events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error', failure: { kind: 'overloaded', reason: 'serverOverloaded' } } as never);
    const endOk = () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
    const notices = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; message?: string }).filter((m) => m.kind === 'notice' && /overloaded/i.test(m.message ?? ''));
    };
    return { session, prompts, timers, overloaded, endOk, notices };
}

describe('an overloaded turn', () => {
    it('is not Broken: the agent waits, says so in the chat, and the turn is sent on again after 30 s', async () => {
        const { session, prompts, timers, overloaded, notices } = open();
        session.prompt('build it', 'you');
        overloaded();
        expect(session.turnState).not.toBe('failed');
        expect(session.failure).toBeNull();
        expect(timers.map((t) => t.ms)).toEqual([OVERLOAD_RETRY_MS[0]]);
        expect((await notices())[0]!.message).toMatch(/overloaded \(serverOverloaded\).*retries in 30 s/);
        timers[0]!.fire();
        expect(prompts).toEqual(['build it', OVERLOAD_RESUME_PROMPT]);
    });

    it('a message the person sends while it waits goes out on the retry, instead of "continue"', () => {
        const { session, prompts, timers, overloaded } = open();
        session.prompt('build it', 'you');
        overloaded();
        session.prompt('and run the tests', 'you');
        expect(prompts).toEqual(['build it']);
        timers[0]!.fire();
        expect(prompts).toEqual(['build it', 'and run the tests']);
    });

    it('backs off (30 s, 60 s, 120 s, 240 s), and the fifth overload in a row IS Broken, with the reason', () => {
        const { session, timers, overloaded } = open();
        session.prompt('build it', 'you');
        for (let i = 0; i < 4; i++) { overloaded(); timers[i]!.fire(); }
        expect(timers.map((t) => t.ms)).toEqual([30_000, 60_000, 120_000, 240_000]);
        overloaded();
        expect(timers).toHaveLength(4);
        expect(session.turnState).toBe('failed');
        expect(session.failure).toBe('serverOverloaded');
    });

    it('a turn that goes through resets the count (control: an ordinary failure is still Broken at once)', () => {
        const { session, timers, overloaded, endOk } = open();
        session.prompt('build it', 'you');
        overloaded(); timers[0]!.fire();
        endOk();
        session.prompt('next', 'you');
        overloaded();
        expect(timers.at(-1)!.ms).toBe(30_000);
    });
});

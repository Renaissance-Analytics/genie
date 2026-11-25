import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { turnStopOffered } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentSession, OVERLOAD_RESUME_PROMPT, OVERLOAD_RETRY_MS, overloadRetryMs, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';

/**
 * OVERLOAD AUTO-RETRY ON prism-acp 0.48.0's TURN FAILURE (Tynn #1060). 0.48.0 adds to `TurnOutcome.failure`, for the kinds
 * `overloaded` and `rate_limit` only: `retryable: true`, `resumable` (the same session takes the next prompt and continues
 * the conversation) and, when the provider stated one, `retryAfterMs`. It also sorts Claude Code's 529 (`error:
 * "server_error"`, `api_error_status: 529`) into `overloaded`, and Codex's `responseTooManyFailedAttempts` with HTTP 429 into
 * `rate_limit`. prism's advice: resend the FAILED PROMPT (Claude may or may not have kept it), on the same session while it
 * runs, and after an exit on the same conversation reloaded.
 *
 * Genie's rule, held here with a fake driver of that documented shape: the agent is kept, Genie waits on its own backoff
 * (or the provider's stated wait), resends the failed prompt, says "Provider busy, retrying in N s" with Stop, and gives up
 * after OVERLOAD_RETRY_MS runs out with the existing stop line. `rate_limit` stays the rate-limit pause.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

const CLAUDE_529 = { reason: 'server_error', kind: 'overloaded', retryable: true, resumable: true } as const;
const CODEX_429 = { reason: 'responseTooManyFailedAttempts', kind: 'rate_limit', retryable: true, resumable: true, providerDetails: { httpStatusCode: 429 } } as const;

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-overload-048-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    let running = true;
    const prompts: unknown[] = [];
    const breaches: string[] = [];
    const exitedRetries: Array<{ text: string; by: string | null }> = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return {
            start: () => {}, prompt: (t: unknown) => { if (!running) throw new Error('driver exited'); prompts.push(t); },
            cancel: () => Promise.resolve(), kill: () => { running = false; },
            get running() { return running; }, get cliSessionId() { return 'thread-1'; },
        };
    };
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({
        agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree,
        onLimitBreach: (reason) => { breaches.push(reason); },
        onOverloadExited: (p) => { exitedRetries.push({ text: p.text, by: p.by }); },
        retryLater: (ms, fire) => {
            const timer = { ms, fire }; timers.push(timer);
            return () => { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1); };
        },
    });
    session.start();
    const fail = (failure: Record<string, unknown>) => events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error', failure } as never);
    const exit = () => { running = false; events.onExit?.(1, null); };
    const rows = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; message?: string; by?: string | null });
    };
    return { session, prompts, timers, breaches, exitedRetries, fail, exit, rows };
}

describe('overloadRetryMs: Genie\'s backoff, or the provider\'s stated wait', () => {
    it('30 s, 60 s, 2 min, 4 min by attempt; a stated retryAfterMs is used as stated', () => {
        expect(OVERLOAD_RETRY_MS).toEqual([30_000, 60_000, 120_000, 240_000]);
        expect([0, 1, 2, 3].map((n) => overloadRetryMs(n, undefined))).toEqual([30_000, 60_000, 120_000, 240_000]);
        expect(overloadRetryMs(0, 90_000)).toBe(90_000);
        expect(overloadRetryMs(3, 5_000)).toBe(5_000);
    });

    it('CONTROL: a retryAfterMs that is not a finite number of ms >= 0 is ignored, and an over-long one is capped at prism\'s hour', () => {
        expect(overloadRetryMs(1, Number.NaN)).toBe(60_000);
        expect(overloadRetryMs(1, -1)).toBe(60_000);
        expect(overloadRetryMs(1, '9000' as never)).toBe(60_000);
        expect(overloadRetryMs(0, 7_200_000)).toBe(3_600_000);
    });
});

describe('an overloaded turn (prism-acp 0.48.0 failure)', () => {
    it('resumable: the FAILED PROMPT is resent on the same session, not "continue"', () => {
        const { session, prompts, timers, fail } = open();
        session.prompt('build it', 'you');
        fail(CLAUDE_529);
        expect(session.failure).toBeNull();
        expect(session.turnState).not.toBe('failed');
        expect(timers.map((t) => t.ms)).toEqual([30_000]);
        timers[0]!.fire();
        expect(prompts).toEqual(['build it', 'build it']);
        expect(prompts).not.toContain(OVERLOAD_RESUME_PROMPT);
    });

    it('the resend is not written as a second message from the person: one "you" row, and a line saying it was sent again', async () => {
        const { session, timers, fail, rows } = open();
        session.prompt('build it', 'you');
        fail(CLAUDE_529);
        timers[0]!.fire();
        const all = await rows();
        expect(all.filter((r) => r.kind === 'message' && r.by === 'you')).toHaveLength(1);
        expect(all.some((r) => r.kind === 'notice' && /sent your last message again/i.test(r.message ?? ''))).toBe(true);
    });

    it('the provider\'s stated retryAfterMs is the wait', () => {
        const { session, timers, fail } = open();
        session.prompt('build it', 'you');
        fail({ ...CLAUDE_529, retryAfterMs: 45_000 });
        expect(timers.map((t) => t.ms)).toEqual([45_000]);
    });

    it('CONTROL: no resumable claim keeps the old "continue" nudge', () => {
        const { session, prompts, timers, fail } = open();
        session.prompt('build it', 'you');
        fail({ reason: 'serverOverloaded', kind: 'overloaded' });
        timers[0]!.fire();
        expect(prompts).toEqual(['build it', OVERLOAD_RESUME_PROMPT]);
    });

    it('says "Provider busy, retrying in N s" with Stop while it waits', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const { session, fail } = open();
        session.prompt('build it', 'you');
        fail(CLAUDE_529);
        expect(session.overloadRetry).toEqual({ at: 1_030_000, attempt: 1, of: OVERLOAD_RETRY_MS.length, reason: 'server_error' });
        const live = { running: true, turnState: 'idle', failure: null, cancelTurn: true, overloadRetry: session.overloadRetry } as unknown as LiveSession;
        const context = chatContext({ agent: { id: 'a', name: 'a', provider: 'claude', fidelity: 'declared' }, session: live, rows: [] });
        expect(context.text).toBe('Provider busy, retrying in 30 s');
        expect(context.tone).toBe('warn');
        expect(context.retryAt).toBe(1_030_000);
        expect(turnStopOffered(live)).toBe(true);
        // CONTROL: an idle agent with no retry waiting offers no Stop.
        expect(turnStopOffered({ ...live, overloadRetry: null })).toBe(false);
    });

    it('Stop while it waits: nothing is resent, the wait is gone, and the chat says Stopped by you', async () => {
        const { session, prompts, timers, fail, rows } = open();
        session.prompt('build it', 'you');
        fail(CLAUDE_529);
        expect(session.cancel('you', 'stop')).toEqual({ ok: true });
        expect(timers).toEqual([]);
        expect(session.overloadRetry).toBeNull();
        expect(session.held).toBe(false);
        expect(prompts).toEqual(['build it']);
        expect((await rows()).some((r) => r.kind === 'stopped' && r.by === 'you')).toBe(true);
    });

    it('the agent exited while it waited: at the retry the host is asked to reload the conversation and resend', () => {
        const { session, prompts, timers, exitedRetries, fail, exit } = open();
        session.prompt('build it', 'you');
        fail(CLAUDE_529);
        exit();
        expect(timers).toHaveLength(1);
        timers[0]!.fire();
        expect(exitedRetries).toEqual([{ text: 'build it', by: 'you' }]);
        expect(prompts).toEqual(['build it']);
    });

    it('CONTROL: an agent STOPPED while it waited is not brought back', async () => {
        const { session, timers, exitedRetries, fail } = open();
        session.prompt('build it', 'you');
        fail(CLAUDE_529);
        await session.stop();
        expect(timers).toEqual([]);
        expect(exitedRetries).toEqual([]);
    });

    it('gives up after the last try with the existing stop line (Claude\'s 529 as 0.48.0 reports it)', () => {
        const { session, timers, fail } = open();
        session.prompt('build it', 'you');
        for (let i = 0; i < OVERLOAD_RETRY_MS.length; i++) { fail(CLAUDE_529); timers[i]!.fire(); }
        fail(CLAUDE_529);
        expect(timers).toHaveLength(OVERLOAD_RETRY_MS.length);
        expect(session.turnState).toBe('failed');
        expect(session.failure).toBe('server_error');
        expect(session.providerStop?.code).toBe('server_error');
        expect(session.overloadRetry).toBeNull();
    });
});

describe('a rate-limited turn stays the rate-limit pause (not double-handled)', () => {
    it("Codex's reclassified 429 (responseTooManyFailedAttempts, kind rate_limit) is held for the limit, with no overload retry", () => {
        const { session, prompts, timers, breaches, fail } = open();
        session.prompt('build it', 'you');
        fail(CODEX_429);
        expect(session.held).toBe(true);
        expect(session.failure).toBeNull();
        expect(breaches).toEqual(['responseTooManyFailedAttempts']);
        expect(timers).toEqual([]);
        expect(session.overloadRetry).toBeNull();
        expect(prompts).toEqual(['build it']);
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityFeed } from '../src/core/activity-feed.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { ActivityFeeds } from '../src/main/activity-feeds.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE PER-AGENT ACTIVITY FEED, PUSHED FROM THE HOST (beta.33 item 10). The renderer loads only the on-screen agent's
 * ledger, so the Dashboard's lanes had nothing live to draw. The host builds every agent's feed from the REAL session
 * (the rows the Stream shows, with their times), pushes it when the session changes — never polled — and holds only
 * the small feed per agent, never a second copy of the ledger.
 *
 * And "finished" is a REAL turn end: the session records one when the provider ends a turn with a reply. "Last
 * finished" read the last `imDone` handoff (attention-store.ts), which a session agent answering in chat never files,
 * so it sat at 2026-10-18 — the owner: "it doesn't even update".
 */

const noTree: ProcessTree = { descendantsOf: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
let events: DriverEvents = {};
const driverFor: DriverFor = () => {
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
    };
    return factory;
};

let dir: string;
let host: SessionHost;
let now: number;
/** Timers the test fires by hand: the coalescing window is real code, the clock is the test's. */
let timers: Array<{ fn: () => void; ms: number }>;
const flush = (): void => { const due = timers; timers = []; for (const t of due) t.fn(); };
const record = (name: string): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name });
const feedsOf = (): { feeds: ActivityFeeds; pushed: ActivityFeed[] } => {
    const feeds = new ActivityFeeds({ host, clock: () => now, schedule: (fn, ms) => { timers.push({ fn, ms }); } });
    const pushed: ActivityFeed[] = [];
    feeds.subscribe((f) => pushed.push(f));
    return { feeds, pushed };
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-activity-'));
    now = Date.UTC(2026, 9, 20, 14);
    timers = [];
    host = new SessionHost({ userData: dir, driverFor, clock: () => now, processTree: noTree });
});
afterEach(async () => {
    host.stopAll();
    await host.settled();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

describe('a turn that ends with a reply is RECORDED as finished', () => {
    it('one `finished` row per replied turn, numbered like its turn (COUNTED); a stopped turn is `stopped`, not finished', () => {
        const a = record('kai');
        host.start(a, dir);
        host.prompt(a.id, 'Fix the board', 'you');
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed.' } });
        now += 60_000;
        events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        host.prompt(a.id, 'And the lanes', 'you');
        events.onTurnEnd?.({ stopReason: 'cancelled', isError: false, raw: null });
        const kinds = host.rowsFor(a.id).map((r) => r.event.kind);
        expect(kinds.filter((k) => k === 'finished')).toHaveLength(1);
        expect(kinds.filter((k) => k === 'stopped')).toHaveLength(1);
        const finished = host.rowsFor(a.id).find((r) => r.event.kind === 'finished')!;
        expect(finished.event).toEqual({ kind: 'finished', n: 1 });
        expect(finished.at).toBe(now);
    });

    it('a crashed turn is NOT finished (CONTROL: only a reply finishes a turn)', () => {
        const a = record('kai');
        host.start(a, dir);
        host.prompt(a.id, 'Go', 'you');
        events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'api error 529' });
        expect(host.rowsFor(a.id).some((r) => r.event.kind === 'finished')).toBe(false);
    });
});

describe('the feed is PUSHED when the session changes', () => {
    it('a tool call reaches the feed with no request from the renderer; a burst of rows is ONE push', () => {
        const a = record('kai');
        host.start(a, dir);
        const { pushed } = feedsOf();
        events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'running the tests' } });
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' now' } });
        // Nothing yet: the burst is coalesced into one push, not one per streamed chunk.
        expect(pushed.filter((f) => f.agentId === a.id)).toHaveLength(0);
        flush();
        const mine = pushed.filter((f) => f.agentId === a.id);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.items.map((i) => i.text)).toEqual(['running the tests now', 'npm test']);
        expect(mine[0]!.items[1]).toMatchObject({ kind: 'command', status: 'running' });
    });

    it('no push when nothing a lane draws changed (a change that leaves the feed equal is not resent)', () => {
        const a = record('kai');
        host.start(a, dir);
        const { pushed } = feedsOf();
        events.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', kind: 'execute', status: 'completed', rawInput: { command: 'ls' } });
        flush();
        const before = pushed.length;
        events.onUpdate?.({ sessionUpdate: 'usage_update', used: 10, size: 100 });
        flush();
        // A usage report is a beat (activity), so it IS a change; a second identical emission is not.
        expect(pushed.length).toBe(before + 1);
        // The host announces this agent (a Stop with no turn running) and nothing in its rows changed.
        expect(host.cancel(a.id)).toEqual({ ok: false, reason: 'no-turn' });
        expect(timers.length).toBe(1);
        flush();
        expect(pushed.length).toBe(before + 1);
    });

    it("a STOPPED agent's feed is its recorded history: its last activity, and not running", async () => {
        const a = record('kai');
        host.start(a, dir);
        host.prompt(a.id, 'Fix it', 'you');
        events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
        events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        host.stop(a.id);
        await host.settled();
        // A fresh host, as after a relaunch: nothing in memory but what the thread recorded.
        host = new SessionHost({ userData: dir, driverFor, clock: () => now, processTree: noTree });
        const { feeds, pushed } = feedsOf();
        feeds.feedFor(a.id);
        // The history is read from disk once and ANNOUNCED when it lands; the feed follows it.
        await new Promise((r) => setTimeout(r, 50));
        flush();
        const f = pushed.filter((x) => x.agentId === a.id).at(-1) ?? feeds.feedFor(a.id);
        expect(f.running).toBe(false);
        expect(f.items.map((i) => i.kind)).toEqual(['finished', 'reply', 'prompt']);
        expect(f.lastAt).toBe(now);
    });
});

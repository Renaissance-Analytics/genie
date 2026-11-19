import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeToAcp } from '@particle-academy/prism-acp';
import { afterAll, describe, expect, it } from 'vitest';
import { chatMessages } from '../src/core/chat-view.js';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';

/**
 * TWO REPLIES ARE TWO ROWS, EVEN WITH ONLY A SUBAGENT BETWEEN THEM (Tynn #918; the owner, 2026-11-19, screenshot).
 *
 * The chat showed "…It's re-running its gate.All three flaky checks are now tracked:…" as one bubble. Ledger row 455871 of
 * the coordinator holds both replies as ONE message; everything that came between them (a subagent's tynn calls, `task
 * progress`/`task updated`/`task ended`/`background tasks` notices) was held beside it (genie#1456) and written after.
 * Claude's chunks carry no message id (prism-acp maps `text_delta` alone), so nothing told the session a new reply began.
 *
 * What does tell it: ONE streamed text block always carries the whitespace after a sentence ends. A piece that starts a new
 * sentence right after a finished one, with rows held between them, is a second reply. genie#1456's cuts (mid-word,
 * mid-sentence) still join; reply-one-row-1456.test.ts holds those.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie-918-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => {}, prompt: () => {}, kill: () => {},
            get running() { return true; },
            get cliSessionId() { return null; },
        };
        return driver;
    };
    const store = openDurableStore(dir);
    const agentId: AgentId = mintAgentId();
    const live: TimedEvent[] = [];
    const session = new AgentSession({
        agentId, cwd: dir, store, driverFactory: factory, processTree: noProcessTree,
        onEvent: (event, meta) => {
            if (meta?.replacesLast && live.length > 0) live[live.length - 1] = { ...live[live.length - 1]!, event };
            else live.push({ id: `r${live.length}`, event, at: live.length });
        },
    });
    session.start();
    const map = new ClaudeToAcp();
    return {
        live,
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        send: (frame: unknown) => { for (const u of map.frame(frame)) events.onUpdate?.(u as Record<string, unknown>); },
        end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
        kinds: () => live.map((r) => r.event.kind),
        bubbles: () => chatMessages({ agent: { id: agentId, name: 'main', provider: 'claude', fidelity: 'declared' }, session: null, rows: live }).filter((m) => m.who === 'agent').map((m) => m.text),
        stored: async (): Promise<StreamEvent[]> => { await session.settled(); return (await readHistory(store, agentId)).rows.map((r) => r.event); },
    };
}

const notice = (message: string) => ({ sessionUpdate: 'notice', notice: { level: 'debug', message } });
const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const subagentCall = (id: string, name: string) => ({ type: 'assistant', parent_tool_use_id: 'toolu_spawner', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }] } });
const subagentResult = (id: string) => ({ type: 'user', parent_tool_use_id: 'toolu_spawner', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

const FIRST = 'The crash-reports PR found and fixed two real problems. It\'s re-running its gate.';
const SECOND = 'All three flaky checks are now tracked:\n- the Windows relaunch, in **#916**;';

describe('two replies are two rows (Tynn #918)', () => {
    it('THE OWNER’S TURN: a reply, a subagent’s calls and task notices, another reply — two bubbles, the rows between them', async () => {
        const s = open();
        s.send(delta('The crash-reports PR found and fixed two real problems. It\'s re-running its'));
        s.send(delta(' gate.'));
        s.send(subagentCall('toolu_create', 'mcp__tynn__create'));
        s.emit(notice('task progress'));
        s.send(subagentResult('toolu_create'));
        s.emit(notice('task updated'));
        s.emit(notice('task ended'));
        s.emit(notice('background tasks'));
        s.send(delta('All three flaky checks are now tracked:\n'));
        s.send(delta('- the Windows relaunch, in **#916**;'));
        s.end();

        expect(s.bubbles()).toEqual([FIRST, SECOND]);
        const order = ['message', 'tool', 'notice', 'tool', 'notice', 'notice', 'notice', 'message'];
        expect(s.kinds().slice(0, order.length)).toEqual(order);
        const stored = await s.stored();
        expect(stored.filter((e) => e.kind === 'message').map((e) => e.kind === 'message' && e.text)).toEqual([FIRST, SECOND]);
        expect(stored.map((e) => e.kind).slice(0, order.length)).toEqual(order);
    });

    it('a question or an exclamation ends a reply the same way', () => {
        for (const end of ['?', '!']) {
            const s = open();
            s.send(delta(`Ready${end}`));
            s.emit(notice('task ended'));
            s.send(delta('Next one.'));
            expect(s.bubbles()).toEqual([`Ready${end}`, 'Next one.']);
        }
    });

    // CONTROLS: the cuts genie#1456 joins still join.

    it('CONTROL: a sentence that goes on after the rows (its space kept) stays one reply', () => {
        const s = open();
        s.send(delta('It is re-running its gate.'));
        s.emit(notice('task progress'));
        s.send(delta(' All three are tracked.'));
        expect(s.bubbles()).toEqual(['It is re-running its gate. All three are tracked.']);
    });

    it('CONTROL: a cut mid-word stays one reply', () => {
        const s = open();
        s.send(delta('the last C'));
        s.send(subagentCall('toolu_read', 'Read'));
        s.send(delta('I job.'));
        expect(s.bubbles()).toEqual(['the last CI job.']);
    });

    it('CONTROL: with nothing held between them, the pieces are one block and stay joined', () => {
        const s = open();
        s.send(delta('see v1.'));
        s.send(delta('Then go'));
        expect(s.bubbles()).toEqual(['see v1.Then go']);
    });
});

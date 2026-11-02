import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeToAcp, META_PARENT_TOOL_CALL } from '@particle-academy/prism-acp';
import { afterAll, describe, expect, it } from 'vitest';
import { chatMessages } from '../src/core/chat-view.js';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';

/**
 * ONE REPLY IS ONE ROW, WHATEVER ARRIVES BESIDE IT (genie#1456).
 *
 * The owner saw one reply as four bubbles, cut mid-word: `The secrets inventory for` / ` P3.4 did stop … the last C` /
 * `I job on the P1b mer` / `ge.`. The transcript holds ONE text block whose text is exactly those four ledger rows joined
 * (rows 220582, 220586, 220589, 220591 of the agent `tynn`). Between them the ledger holds only a background subagent's
 * tool calls and debug notices (their ids are in that subagent's transcript, none in the agent's own) — and the session
 * closed the open reply on anything that was not more of it. An agent with no subagent running showed nothing, which is
 * why it happens "on occasion". Codex does it through notices alone: one delta per `model/safetyBuffering/updated`.
 */
const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie-1456-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => {},
            prompt: () => {},
            kill: () => {},
            get running() { return true; },
            get cliSessionId() { return null; },
        };
        return driver;
    };
    const store = openDurableStore(dir);
    const agentId: AgentId = mintAgentId();
    // THE HOST'S RULE (main/session-host.ts): `replacesLast` overwrites the newest row, anything else appends.
    const live: TimedEvent[] = [];
    const session = new AgentSession({
        agentId, cwd: dir, store, driverFactory: factory, processTree: noProcessTree,
        onEvent: (event, meta) => {
            if (meta?.replacesLast && live.length > 0) live[live.length - 1] = { ...live[live.length - 1]!, event };
            else live.push({ id: `r${live.length}`, event, at: live.length });
        },
    });
    session.start();
    const detail = () => ({
        agent: { id: agentId, name: 'tynn', provider: 'claude', fidelity: 'declared' as const },
        session: null,
        rows: live,
    });
    return {
        session, live,
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
        exit: () => events.onExit?.(0, null),
        kinds: () => live.map((r) => r.event.kind),
        bubbles: () => chatMessages(detail()).filter((m) => m.who === 'agent').map((m) => m.text),
        stored: async (): Promise<StreamEvent[]> => { await session.settled(); return (await readHistory(store, agentId)).rows.map((r) => r.event); },
    };
}

const chunk = (text: string, messageId?: string) => ({ sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}), content: { type: 'text', text } });
const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const notice = (message: string, level = 'debug') => ({ sessionUpdate: 'notice', notice: { level, message } });
const mine = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, name: 'Bash', title: 'Bash', status: 'pending' });
const theirs = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, name: 'Grep', title: 'Grep', status: 'pending', _meta: { [META_PARENT_TOOL_CALL]: 'toolu_spawner' } });
const theirResult = (id: string) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', _meta: { [META_PARENT_TOOL_CALL]: 'toolu_spawner' } });

// The CLI's own frames for the broken turn, through prism-acp's real mapper: nothing here assumes how it marks a subagent.
const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const subagentCall = (id: string, name: string) => ({ type: 'assistant', parent_tool_use_id: 'toolu_spawner', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }] } });
const subagentResult = (id: string) => ({ type: 'user', parent_tool_use_id: 'toolu_spawner', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

describe('one reply is one row (genie#1456)', () => {
    const REPLY = 'The secrets inventory for P3.4 did stop when Genie restarted. I am also watching the last CI job on the P1b merge.';

    it('THE BROKEN TURN: a subagent working beside the reply leaves one bubble, whole, live and on disk', async () => {
        const s = open();
        const map = new ClaudeToAcp();
        const send = (frame: unknown) => { for (const u of map.frame(frame)) s.emit(u as Record<string, unknown>); };
        // Row for row as the ledger recorded it (220582-220591), with the words cut where they were.
        send(delta('The secrets inventory for'));
        send(subagentCall('toolu_grep', 'Grep'));
        s.emit(notice('task progress'));
        send(subagentResult('toolu_grep'));
        send(delta(' P3.4 did stop when Genie restarted. I am also watching the last C'));
        send(subagentCall('toolu_read', 'Read'));
        s.emit(notice('task progress'));
        send(delta('I job on the P1b mer'));
        send(subagentResult('toolu_read'));
        send(delta('ge.'));
        s.end();

        expect(s.bubbles()).toEqual([REPLY]);
        const stored = await s.stored();
        expect(stored.filter((e) => e.kind === 'message').map((e) => e.kind === 'message' && e.text)).toEqual([REPLY]);
        // Nothing is lost: all four tool rows and both notices are there, after the reply, in the order they came, in both.
        const order = ['message', 'tool', 'notice', 'tool', 'tool', 'notice', 'tool'];
        expect(s.kinds().slice(0, order.length)).toEqual(order);
        expect(stored.map((e) => e.kind).slice(0, order.length)).toEqual(order);
    });

    it('a Codex notice between every delta leaves one row, not one per word', () => {
        const s = open();
        for (const word of ['The', ' inline', '-image', ' tests', ' pass']) {
            s.emit(chunk(word, 'item_1'));
            s.emit(notice('unmapped Codex notification: model/safetyBuffering/updated'));
        }
        expect(s.bubbles()).toEqual(['The inline-image tests pass']);
    });

    it('a warning beside the reply does not cut it either, and is still shown', () => {
        const s = open();
        s.emit(chunk('That mak'));
        s.emit(notice('Rate limit: five_hour window at 92% used', 'warning'));
        s.emit(chunk('es it urgent.'));
        s.end();
        expect(s.bubbles()).toEqual(['That makes it urgent.']);
        expect(s.live.some((r) => r.event.kind === 'notice' && r.event.level === 'warning')).toBe(true);
    });

    it('a subagent’s result that comes unmarked still belongs to the call it answers', () => {
        const s = open();
        s.emit(chunk('one '));
        s.emit(theirs('t1'));
        s.emit({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        s.emit(chunk('reply'));
        expect(s.bubbles()).toEqual(['one reply']);
    });

    it('a thought is one row beside a subagent too', () => {
        const s = open();
        s.emit(thought('weighing '));
        s.emit(theirs('t1'));
        s.emit(notice('task progress'));
        s.emit(theirResult('t1'));
        s.emit(thought('the options'));
        s.end();
        const thoughts = s.live.map((r) => r.event).filter((e) => e.kind === 'think');
        expect(thoughts.map((e) => e.kind === 'think' && e.text)).toEqual(['weighing the options']);
    });

    // CONTROLS: what must still end a reply, and what must not be made to wait.

    it('CONTROL: the agent’s OWN tool call still ends the reply, with what was held between them', async () => {
        const s = open();
        s.emit(chunk('looking'));
        s.emit(theirs('t1'));
        s.emit(mine('t2'));
        s.emit(chunk('found it'));
        s.end();
        expect(s.bubbles()).toEqual(['looking', 'found it']);
        expect(s.kinds().slice(0, 4)).toEqual(['message', 'tool', 'tool', 'message']);
        expect((await s.stored()).map((e) => e.kind).slice(0, 4)).toEqual(['message', 'tool', 'tool', 'message']);
    });

    it('CONTROL: two Codex messages with only a notice between stay two, the notice between them', () => {
        const s = open();
        s.emit(chunk('First item.', 'item_1'));
        s.emit(notice('unmapped Codex notification: skills/changed'));
        s.emit(chunk('Second item.', 'item_2'));
        expect(s.bubbles()).toEqual(['First item.', 'Second item.']);
        expect(s.kinds()).toEqual(['message', 'notice', 'message']);
    });

    it('CONTROL: a usage report still ends a reply (it is how a provider says the message is over)', () => {
        const s = open();
        s.emit(chunk('Done.'));
        s.emit({ sessionUpdate: 'usage_update', used: 10, size: 100 });
        s.emit(chunk('Next.'));
        expect(s.bubbles()).toEqual(['Done.', 'Next.']);
    });

    it('CONTROL: with no reply open, a subagent’s rows and notices arrive at once', () => {
        const s = open();
        s.emit(theirs('t1'));
        s.emit(notice('task progress'));
        s.emit(theirResult('t1'));
        expect(s.kinds()).toEqual(['tool', 'notice', 'tool']);
    });

    it('what is held comes out when the turn ends, and when the provider exits: never lost', async () => {
        const ended = open();
        ended.emit(chunk('reply'));
        ended.emit(theirs('t1'));
        ended.end();
        expect(ended.kinds().slice(0, 2)).toEqual(['message', 'tool']);
        expect((await ended.stored()).map((e) => e.kind).slice(0, 2)).toEqual(['message', 'tool']);

        const gone = open();
        gone.emit(chunk('reply'));
        gone.emit(notice('task progress'));
        gone.exit();
        expect(gone.kinds().slice(0, 2)).toEqual(['message', 'notice']);
        expect((await gone.stored()).map((e) => e.kind).slice(0, 2)).toEqual(['message', 'notice']);
    });

    it('the newest row stays the growing reply: `replacesLast` never lands on a row beside it', () => {
        const s = open();
        s.emit(chunk('a'));
        s.emit(theirs('t1'));
        s.emit(chunk('b'));
        // While the reply grows nothing else is in the list, so the host's replace can only hit the reply.
        expect(s.kinds()).toEqual(['message']);
        expect(s.bubbles()).toEqual(['ab']);
    });
});

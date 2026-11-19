import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeToAcp } from '@particle-academy/prism-acp';
import { afterAll, describe, expect, it } from 'vitest';
import { chatMessages } from '../src/core/chat-view.js';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import * as sessionModule from '../src/core/session.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';

/**
 * A CLAUDE REPLY IS SPLIT BY ITS MESSAGE ID, NOT BY ITS TEXT (Tynn #921; prism-acp 0.43.0 G-312).
 *
 * Tynn #918: the owner saw two replies with only a subagent's rows between them as one bubble ("…re-running its gate.All
 * three flaky checks…"), because Claude's chunks carried no message id. Genie guessed the break from the text (an INTERIM
 * `startsAnotherReply`: a finished sentence, then a capital). prism-acp 0.43.0 now puts `messageId` at the root of every
 * Claude `agent_message_chunk`, as its Codex driver already did: the Anthropic id from `message_start`, or a generated
 * `prism_msg_<uuid>` kept until `message_stop`, per thread. So the session's `sameItem` rule splits exactly, and the guess
 * is gone: a new id is a new row whatever the text says; the same id is one row whatever arrives beside it (genie#1456).
 *
 * Every frame here goes through prism-acp's real `ClaudeToAcp`: nothing assumes how it assigns ids.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie-921-'));
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
    const seen: Record<string, unknown>[] = [];
    return {
        live, seen,
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        send: (frame: unknown) => { for (const u of map.frame(frame)) { seen.push(u as Record<string, unknown>); events.onUpdate?.(u as Record<string, unknown>); } },
        end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
        kinds: () => live.map((r) => r.event.kind),
        bubbles: () => chatMessages({ agent: { id: agentId, name: 'main', provider: 'claude', fidelity: 'declared' }, session: null, rows: live }).filter((m) => m.who === 'agent').map((m) => m.text),
        stored: async (): Promise<StreamEvent[]> => { await session.settled(); return (await readHistory(store, agentId)).rows.map((r) => r.event); },
    };
}

const notice = (message: string) => ({ sessionUpdate: 'notice', notice: { level: 'debug', message } });
const start = (id: string, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id, usage: { input_tokens: 1, output_tokens: 1 } } } });
const stop = (parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_stop' } });
const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const subagentCall = (id: string, name: string) => ({ type: 'assistant', parent_tool_use_id: 'toolu_spawner', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }] } });
const subagentResult = (id: string) => ({ type: 'user', parent_tool_use_id: 'toolu_spawner', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

describe('Claude replies split by messageId (Tynn #921, prism-acp G-312)', () => {
    it('prism-acp 0.43.0 puts the message id at the root of every Claude chunk (the premise)', () => {
        const s = open();
        s.send(start('msg_01A'));
        s.send(delta('one'));
        s.send(stop());
        s.send(delta('two'));
        const chunks = s.seen.filter((u) => u['sessionUpdate'] === 'agent_message_chunk');
        expect(chunks.map((u) => u['messageId'])[0]).toBe('msg_01A');
        // After its stop, a chunk with no start gets an id of its own, generated by prism.
        expect(String(chunks[1]!['messageId'])).toMatch(/^prism_msg_/);
    });

    it('THE OWNER’S TURN (#918): a reply, a subagent’s calls and task notices, another reply — two bubbles, the rows between them', async () => {
        const s = open();
        const FIRST = 'The crash-reports PR found and fixed two real problems. It\'s re-running its gate.';
        const SECOND = 'All three flaky checks are now tracked:\n- the Windows relaunch, in **#916**;';
        s.send(start('msg_01A'));
        s.send(delta('The crash-reports PR found and fixed two real problems. It\'s re-running its'));
        s.send(delta(' gate.'));
        s.send(stop());
        s.send(subagentCall('toolu_create', 'mcp__tynn__create'));
        s.emit(notice('task progress'));
        s.send(subagentResult('toolu_create'));
        s.emit(notice('task ended'));
        s.send(start('msg_01B'));
        s.send(delta('All three flaky checks are now tracked:\n'));
        s.send(delta('- the Windows relaunch, in **#916**;'));
        s.send(stop());
        s.end();

        expect(s.bubbles()).toEqual([FIRST, SECOND]);
        const order = ['message', 'tool', 'notice', 'tool', 'notice', 'message'];
        expect(s.kinds().slice(0, order.length)).toEqual(order);
        const stored = await s.stored();
        expect(stored.filter((e) => e.kind === 'message').map((e) => e.kind === 'message' && e.text)).toEqual([FIRST, SECOND]);
        expect(stored.map((e) => e.kind).slice(0, order.length)).toEqual(order);
    });

    it('a new id is a new row WHATEVER the text: no sentence end, no capital, mid-word — still two bubbles', () => {
        for (const [a, b] of [['Tracked in **#916**', 'and the rest'], ['the last C', 'I job.'], ['```ts\nconst x =', ' 1;\n```']] as const) {
            const s = open();
            s.send(start('msg_01A'));
            s.send(delta(a));
            s.send(stop());
            s.emit(notice('task ended'));
            s.send(start('msg_01B'));
            s.send(delta(b));
            expect(s.bubbles(), `${a} | ${b}`).toEqual([a, b]);
        }
    });

    it('the SAME id is one row WHATEVER the text: a finished sentence then a capital, with rows beside it, stays joined', () => {
        // What the #918 guess split: here the provider says it is one message, and the provider is right.
        for (const [a, b] of [['Ready.', 'Next one.'], ['Ready?', 'Next one.'], ['Run this:\n```bash\nnpm test\n```', 'That runs it.']] as const) {
            const s = open();
            s.send(start('msg_01A'));
            s.send(delta(a));
            s.send(subagentCall('toolu_read', 'Read'));
            s.emit(notice('task progress'));
            s.send(delta(b));
            expect(s.bubbles(), `${a} | ${b}`).toEqual([`${a}${b}`]);
        }
    });

    it('a message with no start keeps prism’s generated id until its stop: one row across held rows', () => {
        const s = open();
        s.send(delta('Done.'));
        s.emit(notice('task ended'));
        s.send(delta('Next.'));
        expect(s.bubbles()).toEqual(['Done.Next.']);
    });

    it('a subagent’s own message start does not lend its id to the main thread’s reply', () => {
        const s = open();
        s.send(start('msg_01A'));
        s.send(delta('The secrets inventory for'));
        s.send(start('msg_sub', 'toolu_spawner'));
        s.send(subagentCall('toolu_grep', 'Grep'));
        s.send(stop('toolu_spawner'));
        s.send(delta(' P3.4 did stop.'));
        expect(s.bubbles()).toEqual(['The secrets inventory for P3.4 did stop.']);
    });

    // CONTROLS: genie#1456's joins hold through the same id.

    it('CONTROL (genie#1456): one message cut mid-word by a subagent’s rows is one bubble, live and on disk', async () => {
        const REPLY = 'The secrets inventory for P3.4 did stop. I am watching the last CI job on the P1b merge.';
        const s = open();
        s.send(start('msg_01A'));
        s.send(delta('The secrets inventory for'));
        s.send(subagentCall('toolu_grep', 'Grep'));
        s.emit(notice('task progress'));
        s.send(subagentResult('toolu_grep'));
        s.send(delta(' P3.4 did stop. I am watching the last C'));
        s.send(subagentCall('toolu_read', 'Read'));
        s.send(delta('I job on the P1b mer'));
        s.send(subagentResult('toolu_read'));
        s.send(delta('ge.'));
        s.send(stop());
        s.end();
        expect(s.bubbles()).toEqual([REPLY]);
        const stored = await s.stored();
        expect(stored.filter((e) => e.kind === 'message').map((e) => e.kind === 'message' && e.text)).toEqual([REPLY]);
    });

    it('CONTROL: a reply resumed after the agent’s OWN tool call is its own row (a new message, a new id)', () => {
        const s = open();
        s.send(start('msg_01A'));
        s.send(delta('looking'));
        s.send(stop());
        s.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'Bash', title: 'Bash', status: 'pending' });
        s.send(start('msg_01B'));
        s.send(delta('found it'));
        expect(s.bubbles()).toEqual(['looking', 'found it']);
    });

    it('the INTERIM text rule is gone: session.ts neither exports nor holds startsAnotherReply', () => {
        expect(Object.keys(sessionModule)).not.toContain('startsAnotherReply');
        expect(readFileSync('src/core/session.ts', 'utf8')).not.toContain('startsAnotherReply');
    });
});

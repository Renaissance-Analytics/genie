import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeToAcp } from '@particle-academy/prism-acp';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { chatMessages, chatThreadFrom, waitingMessages, type ChatDetail } from '../src/core/chat-view.js';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { ChatWaiting } from '../src/renderer/components/ChatFlyout.js';

/**
 * A MESSAGE THE AGENT ALREADY ANSWERED IS NOT QUEUED (genie#1473). Both instances the owner saw, 2026-11-02:
 *
 *  - `fancy`, ledger 09bbd5bb rows 106958-106964: "can you do your testing…" at 16:07, "Bash 2m" and Interrupt and send
 *    beside it, the reply four seconds later directly under it.
 *  - `tynn`, ledger 4c3208bb rows 224072-224078: "this isn't right." at 16:08, "Bash 33s", the reply seven seconds later.
 *
 * In BOTH the step was a SUBAGENT's: `toolu_013bRoSy…` and `toolu_01J5gNWU…` (`gh pr checks --watch`) are `tool_use` blocks
 * in those subagents' transcripts, and in neither agent's own. The agent itself was between steps, so the message reached it
 * at once. The ledger could not say so, because the mark prism-acp puts on a subagent's call stopped at the session.
 *
 * WHAT MEASURING THE LEDGERS SAID (fancy, tynn and a Codex agent), which is where the rule comes from:
 *  - A message reaches a Claude agent when all of its own steps are done. Own steps, not its subagents'.
 *  - The agent's own words or thoughts arrive with an own step open almost never: 47 of about 17,000, and those are a step
 *    whose end was never recorded (a run killed under it) or a Codex completion row trailing its reply. So they prove the
 *    message was delivered, and that whatever still reads open is not holding anything up.
 *  - A later step of its own does NOT prove it. Claude starts a batch's calls while still writing them: tynn row 105100 is a
 *    message sent during a Write, with the Bash of the same batch starting five seconds later, and the agent read it after
 *    that Bash ended (105106). Calling it read at 105102 would take the button off a message still waiting.
 *  - A subagent's words never reach the ledger, only its calls (no text or thought of 80 subagent transcripts appears as an
 *    agent row, the CLI's own synthetic limit line aside).
 */
const T = Date.UTC(2026, 10, 2, 22, 7, 0);
const row = (id: string, event: unknown, at = T): TimedEvent => ({ id, event: event as StreamEvent, at });
const turn = (id = 't1') => row(id, { kind: 'turn', n: 1, by: 'you' });
const you = (id: string, text = 'hello?', at = T) => row(id, { kind: 'message', speaker: 'you', peerName: null, text }, at);
const agent = (id: string, text = 'Yes.') => row(id, { kind: 'message', speaker: 'agent', peerName: null, text });
const think = (id: string, text = 'weighing it') => row(id, { kind: 'think', text, tokens: null });
const step = (id: string, toolCallId: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', title: string | null = 'Bash', at = T) =>
    row(id, { kind: 'tool', toolCallId, name: title, title, status, toolKind: 'execute', rawInput: null }, at);
/** A subagent's call, as the ledger records one now. */
const theirs = (id: string, toolCallId: string, status: 'pending' | 'completed' = 'pending', title: string | null = 'Bash') =>
    row(id, { kind: 'tool', toolCallId, name: title, title, status, toolKind: 'execute', rawInput: null, parentToolCallId: 'toolu_spawner' });
const behind = (rows: TimedEvent[], id: string) => waitingMessages(rows).get(id)?.step ?? null;

describe('the agent’s own words say it has the message', () => {
    const inShell = [turn(), step('c1', 'toolu_bash', 'pending', 'Run the tests'), you('m1')];

    it('CONTROL, the owner’s original complaint: a long shell command and no reply yet, still queued, with the button', () => {
        const rows = [...inShell, row('n', { kind: 'notice', level: 'debug', message: 'task progress' })];
        const m = chatMessages({ agent: { id: 'a', name: 'moic', provider: 'claude', fidelity: 'declared' }, session: null, rows }).find((x) => x.id === 'm1')!;
        expect(m.waiting?.step).toBe('Run the tests');
        const html = renderToStaticMarkup(ChatWaiting({ id: 'm1', agentName: 'moic', waiting: m.waiting!, now: T + 120_000, onInterruptAndSend: () => {} }));
        expect(html).toContain('data-action="interrupt-and-send"');
    });

    it('a reply below it ends the wait, whatever the step is doing', () => {
        expect(behind([...inShell, agent('r1')], 'm1')).toBeNull();
    });

    it('a thought below it ends the wait; a wordless one says nothing', () => {
        expect(behind([...inShell, think('th')], 'm1')).toBeNull();
        expect(behind([...inShell, think('th', '   ')], 'm1')).toBe('Run the tests');
    });

    it('a reply with no words yet says nothing; the same row filled in does', () => {
        expect(behind([...inShell, agent('r1', '')], 'm1')).toBe('Run the tests');
        expect(behind([...inShell, agent('r1', 'Y')], 'm1')).toBeNull();
    });

    it('nobody else’s words count: another agent’s message, your own next one, a notice', () => {
        const peer = row('p', { kind: 'message', speaker: 'peer', peerName: 'wren', text: 'done' });
        const warned = row('w', { kind: 'notice', level: 'warning', message: 'Rate limit' });
        expect(behind([...inShell, peer], 'm1')).toBe('Run the tests');
        expect(behind([...inShell, warned], 'm1')).toBe('Run the tests');
        expect(behind([...inShell, you('m2')], 'm1')).toBe('Run the tests');
        expect(behind([...inShell, you('m2')], 'm2')).toBe('Run the tests');
    });

    it('only what was sent before the reply is answered: a message after it, in a step that started after it, waits', () => {
        const rows = [...inShell, agent('r1'), step('c2', 'toolu_next', 'pending', 'Next step'), you('m2')];
        expect(behind(rows, 'm1')).toBeNull();
        expect(behind(rows, 'm2')).toBe('Next step');
    });
});

describe('a step whose end never arrives', () => {
    // No own step of the ledgers stayed open and alive: a backgrounded call answers at once ("Command running in background"),
    // so its row completes (tynn 224065). What stays open is a run killed under it, or a result the provider never sent.
    const stale = [turn(), step('c1', 'toolu_lost', 'in_progress', 'Lost'), you('m1')];

    it('holds a message until the agent speaks, not for the rest of the turn', () => {
        expect(behind(stale, 'm1')).toBe('Lost');
        expect(behind([...stale, agent('r1')], 'm1')).toBeNull();
    });

    it('the agent speaking means it was not holding anything: a message after that does not wait behind it', () => {
        expect(behind([...stale, agent('r1'), you('m2')], 'm2')).toBeNull();
        expect(behind([...stale, think('th'), you('m2')], 'm2')).toBeNull();
    });

    it('its result arriving late changes nothing', () => {
        expect(behind([...stale, agent('r1'), step('c2', 'toolu_lost', 'completed', null), you('m2')], 'm2')).toBeNull();
    });
});

describe('several of its own steps at once', () => {
    const t0 = [turn(), step('a', 'toolu_a', 'in_progress', 'First')];

    it('a later step of its own starting does not end the wait: tynn 105098-105106, a batch being written', () => {
        const rows = [
            turn(),
            step('w1', 'toolu_012QdKgi', 'pending', 'Write'),
            you('m1', 'after you get the php stuff sorted out'),
            step('w2', 'toolu_012QdKgi', 'in_progress', null),
            step('b1', 'toolu_019hPrUE', 'pending', 'Bash'),
        ];
        expect(behind(rows, 'm1')).toBe('Write');
        // Its Write ended and its Bash is running: it has still not read the message, and it now waits behind the Bash.
        const written = [...rows, step('w3', 'toolu_012QdKgi', 'completed', null)];
        expect(behind(written, 'm1')).toBe('Bash');
        expect(behind([...written, step('b2', 'toolu_019hPrUE', 'completed', null)], 'm1')).toBeNull();
    });

    it('sent behind the last one started; that one ending leaves it behind the other', () => {
        const rows = [...t0, step('b', 'toolu_b', 'in_progress', 'Second'), you('m1')];
        expect(behind(rows, 'm1')).toBe('Second');
        const second = [...rows, step('b2', 'toolu_b', 'completed', null)];
        expect(behind(second, 'm1')).toBe('First');
        expect(behind([...second, step('a2', 'toolu_a', 'failed', null)], 'm1')).toBeNull();
    });

    it('the other one ending first leaves it where it was; the last ending ends it', () => {
        const rows = [...t0, step('b', 'toolu_b', 'in_progress', 'Second'), you('m1'), step('a2', 'toolu_a', 'completed', null)];
        expect(behind(rows, 'm1')).toBe('Second');
        expect(behind([...rows, step('b2', 'toolu_b', 'completed', null)], 'm1')).toBeNull();
    });

    it('since: the step it moved behind still counts from when THAT step started', () => {
        const rows = [turn(), step('a', 'toolu_a', 'pending', 'First', T), step('b', 'toolu_b', 'pending', 'Second', T + 5_000), you('m1', 'x', T + 9_000), step('b2', 'toolu_b', 'completed', null, T + 10_000)];
        expect(waitingMessages(rows).get('m1')?.since).toBe(T);
    });
});

describe('a subagent’s steps are not the agent’s', () => {
    it('a message never waits behind one', () => {
        expect(behind([turn(), theirs('s1', 'toolu_sub'), you('m1')], 'm1')).toBeNull();
    });

    it('nor once it reads in progress', () => {
        const rows = [turn(), theirs('s1', 'toolu_sub'), row('s2', { kind: 'tool', toolCallId: 'toolu_sub', name: null, title: '', status: 'in_progress', toolKind: null, rawInput: null, parentToolCallId: 'toolu_spawner' }), you('m1')];
        expect(behind(rows, 'm1')).toBeNull();
    });

    it('its calls say nothing about the agent having read it: own Bash running, subagent busy beside it, still queued behind the Bash', () => {
        const rows = [turn(), step('c1', 'toolu_bash', 'in_progress', 'Own Bash'), theirs('s1', 'toolu_sub', 'pending', 'Grep'), you('m1')];
        expect(behind(rows, 'm1')).toBe('Own Bash');
        const after = [...rows, theirs('s2', 'toolu_sub', 'completed', null), theirs('s3', 'toolu_sub2', 'pending', 'Read')];
        expect(behind(after, 'm1')).toBe('Own Bash');
    });

    it('its spawning step IS the agent’s: a foreground Agent call holds the message', () => {
        const rows = [turn(), step('c1', 'toolu_agent', 'in_progress', 'Agent'), theirs('s1', 'toolu_sub', 'pending', 'Grep'), you('m1')];
        expect(behind(rows, 'm1')).toBe('Agent');
        expect(behind([...rows, step('c2', 'toolu_agent', 'completed', null)], 'm1')).toBeNull();
    });
});

const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function openSession() {
    const dir = mkdtempSync(join(tmpdir(), 'genie-1473-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
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
        session, live,
        emit: (u: Record<string, unknown>) => events.onUpdate?.(u),
        // The CLI's own frames, through prism-acp's real mapper: nothing here assumes how it marks a subagent.
        send: (frame: unknown) => { for (const u of map.frame(frame)) events.onUpdate?.(u as Record<string, unknown>); },
        stored: async (): Promise<TimedEvent[]> => { await session.settled(); return (await readHistory(store, agentId)).rows.map((r, i) => ({ id: `s${i}`, event: r.event, at: null })); },
        end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }),
    };
}

const subagentCall = (id: string, command: string) => ({ type: 'assistant', parent_tool_use_id: 'toolu_spawner', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
/** The person's message in the rows it landed in. */
const messageId = (rows: readonly TimedEvent[], text: string) => rows.find((r) => r.event.kind === 'message' && r.event.speaker === 'you' && r.event.text === text)!.id;

describe('the two messages the owner saw, row for row through the real session', () => {
    it('`fancy`, 16:07: never queued, live or on disk, and its subagent’s Bash is still running', async () => {
        const s = openSession();
        s.session.prompt('the work');
        s.send(subagentCall('toolu_013bRoSyW5D1uyeU7CW1Qcvp', 'node panel-diff.mjs before.css after.css'));
        s.emit({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'task progress' } });
        const text = 'can you do your testing withotu opening hundreds of windows over and over?';
        s.session.prompt(text);
        expect(waitingMessages(s.live).has(messageId(s.live, text))).toBe(false);
        s.send(delta('Yes. That’s on me'));
        expect(waitingMessages(s.live).has(messageId(s.live, text))).toBe(false);
        s.end();
        const rows = await s.stored();
        expect(waitingMessages(rows).has(messageId(rows, text))).toBe(false);
    });

    it('`tynn`, 16:08: the same, behind `gh pr checks --watch`', async () => {
        const s = openSession();
        s.session.prompt('the work');
        s.send(subagentCall('toolu_01J5gNWU3FZz7wkM5fg1d4nS', 'gh pr checks 1471 --watch --interval 30'));
        s.session.prompt('this isn’t right.');
        expect(waitingMessages(s.live).has(messageId(s.live, 'this isn’t right.'))).toBe(false);
        s.end();
        const rows = await s.stored();
        expect(waitingMessages(rows).has(messageId(rows, 'this isn’t right.'))).toBe(false);
    });

    it('CONTROL: the same rows with the Bash the agent’s OWN is queued, until the words of its reply start to stream', async () => {
        const s = openSession();
        s.session.prompt('the work');
        s.emit({ sessionUpdate: 'tool_call', toolCallId: 'toolu_own', name: 'Bash', title: 'Bash', status: 'pending' });
        s.session.prompt('this isn’t right.');
        const id = messageId(s.live, 'this isn’t right.');
        expect(waitingMessages(s.live).get(id)?.step).toBe('Bash');
        s.emit({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_own', status: 'in_progress' });
        expect(waitingMessages(s.live).get(id)?.step).toBe('Bash');
        // Written to the thread once, when it closes: but on screen from its first words.
        s.send(delta('I read that as'));
        expect(waitingMessages(s.live).has(id)).toBe(false);
    });
});

describe('the mark reaches the ledger', () => {
    it('a subagent’s call carries the call that spawned it, live and on disk; the agent’s own carries nothing', async () => {
        const s = openSession();
        s.session.prompt('the work');
        s.emit({ sessionUpdate: 'tool_call', toolCallId: 'toolu_own', name: 'Bash', title: 'Bash', status: 'pending' });
        s.send(subagentCall('toolu_sub', 'ls'));
        s.end();
        const parents = (rows: readonly TimedEvent[]) => Object.fromEntries(rows.flatMap((r) => (r.event.kind === 'tool' ? [[r.event.toolCallId, (r.event as { parentToolCallId?: string }).parentToolCallId ?? null]] : [])));
        expect(parents(s.live)).toEqual({ toolu_own: null, toolu_sub: 'toolu_spawner' });
        expect(parents(await s.stored())).toEqual({ toolu_own: null, toolu_sub: 'toolu_spawner' });
    });

    it('a row of that call that comes unmarked is still marked in the ledger, so the call does not turn into the agent’s', () => {
        const s = openSession();
        s.session.prompt('the work');
        s.send(subagentCall('toolu_sub', 'ls'));
        s.emit({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_sub', status: 'in_progress' });
        s.session.prompt('hello?');
        expect(waitingMessages(s.live).has(messageId(s.live, 'hello?'))).toBe(false);
    });
});

describe('the whole chat and an update’s tail agree on all of it', () => {
    const detail = (rows: TimedEvent[]): ChatDetail => ({ agent: { id: 'a', name: 'tynn', provider: 'claude', fidelity: 'declared' }, session: null, rows });
    const padding = (from: string, n: number) => Array.from({ length: n }, (_, i) => agent(`${from}${i}`, `line ${i}`));

    it('a message behind its own step, one answered, one beside a subagent: the same in both, at every window', () => {
        const rows = [
            turn('t0'), ...padding('old', 40),
            turn('t1'), step('c1', 'toolu_a', 'in_progress', 'Own Bash'), you('queued'),
            turn('t2'), step('c2', 'toolu_b', 'in_progress', 'Answered'), you('answered'), agent('r1'),
            turn('t3'), theirs('s1', 'toolu_sub'), you('beside'), step('c3', 'toolu_c', 'in_progress', 'Still running'), you('waiting'),
        ];
        const full = chatThreadFrom(detail(rows), 'a', [], Date.now).messages;
        const waits = (ms: typeof full) => Object.fromEntries(ms.filter((m) => m.who === 'you').map((m) => [m.id, m.waiting?.step ?? null]));
        // CONTROL: the tail below has something to get wrong: a message waits, and answered and beside do not.
        expect(waits(full)).toEqual({ queued: null, answered: null, beside: null, waiting: 'Still running' });
        for (const lines of [1, 2, 5, 20, 500]) {
            const tail = chatThreadFrom(detail(rows), 'a', [], Date.now, lines);
            expect(tail.messages, `${lines} lines`).toEqual(full.slice(full.length - tail.messages.length));
            expect(tail.messages.find((m) => m.id === 'waiting')?.waiting?.step, `${lines} lines`).toBe('Still running');
        }
    });
});

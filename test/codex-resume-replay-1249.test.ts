import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chatMessages, type ChatDetail } from '../src/core/chat-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { prepareStream, StreamPrep } from '../src/core/stream-prep.js';
import { activityRows, type TimedEvent } from '../src/core/stream-view.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';

/**
 * A CODEX RESUME DOES NOT WRITE ITS HISTORY INTO THE LEDGER AGAIN (genie#1249). On `thread/resume` prism-acp's
 * CodexDriver pages the whole thread (`thread/turns/list` + `thread/items/list`) and emits every item as a session
 * update, before its `ready` resolves. Genie already dropped the replayed messages, thoughts, tools and plans
 * (test/codex-replay-not-recorded.test.ts), but not the compactions (`compaction_update` → a divider) nor the debug
 * notices the replay raises per item (`replayed reasoning item had no summary`, `unmapped Codex item: webSearch`).
 * Measured on the owner's miapa ledger (7c4304bb…jsonl, run 11b978e0, resumed 23:12:16 UTC): 16+ compaction dividers
 * and 3,036 `replayed …` notices in five minutes, and nothing else — every restart appended the history again.
 *
 * And the views tolerate what is already on disk: compaction dividers repeated with nothing between them but debug
 * notices are ONE compaction, in the Stream and in the chat.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const UNMAPPED = 'particle.academy/unmapped_frame';

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-replay-1249-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    let markReady: () => void = () => {};
    const ready = new Promise<void>((r) => { markReady = r; });
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, ready, get running() { return true; }, get cliSessionId() { return null; } } as never;
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({
        agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree,
        resumeSessionId: 'thread-7c4304bb', replaysTranscript: true,
    });
    session.start();
    const send = (update: Record<string, unknown>) => events.onUpdate?.(update);
    // prism-acp 0.27.0 codex/driver.js #mapItem, exactly as it emits a replayed item.
    const replayCompaction = () => send({ sessionUpdate: 'compaction_update', status: 'completed' });
    const replayReasoningNoSummary = (n: number) => send({
        sessionUpdate: 'notice', notice: { level: 'debug', message: 'replayed reasoning item had no summary' },
        _meta: { [UNMAPPED]: { reason: 'replayed reasoning item had no summary', frame: { type: 'reasoning', id: `rs_${n}`, summary: [], content: [] } } },
    });
    const replayUnmapped = () => send({
        sessionUpdate: 'notice', notice: { level: 'debug', message: 'unmapped Codex item: webSearch' },
        _meta: { [UNMAPPED]: { reason: 'unmapped Codex item: webSearch', frame: { type: 'webSearch', id: 'ws_1' } } },
    });
    const replayThought = (text: string) => send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
    const replayTool = (id: string) => send({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Run command', kind: 'execute', status: 'completed', rawInput: { command: 'ls' } });
    const replayMessage = (text: string) => send({ sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text } });
    const rows = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as StreamEvent);
    };
    return { session, send, replayCompaction, replayReasoningNoSummary, replayUnmapped, replayThought, replayTool, replayMessage, markReady, rows,
        end: () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null }) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a resumed Codex thread whose history holds N compactions and M reasoning items (genie#1249)', () => {
    it('adds no compaction or reasoning rows, and at most one notice', async () => {
        const s = open();
        const N = 7, M = 40;
        for (let i = 0; i < M; i += 1) {
            if (i % 6 === 0 && i / 6 < N) s.replayCompaction();
            s.replayReasoningNoSummary(i);
            if (i % 10 === 0) { s.replayThought('an earlier thought'); s.replayTool(`exec-${i}`); s.replayMessage('an earlier reply'); s.replayUnmapped(); }
        }
        s.markReady();
        await settle();
        const rows = await s.rows();
        expect(rows.filter((r) => r.kind === 'divider')).toEqual([]);
        expect(rows.filter((r) => r.kind === 'think' || r.kind === 'tool' || r.kind === 'message')).toEqual([]);
        expect(rows.filter((r) => r.kind === 'notice').length).toBeLessThanOrEqual(1);
    });

    it('still records the replay window’s readings about NOW: the model the resumed thread runs on (control)', async () => {
        const s = open();
        s.send({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'model' }, _meta: { 'particle.academy/model': 'gpt-6.1-sol' } });
        s.replayCompaction();
        s.replayReasoningNoSummary(1);
        s.markReady();
        await settle();
        const notices = (await s.rows()).filter((r) => r.kind === 'notice');
        expect(notices.some((n) => n.kind === 'notice' && n.model === 'gpt-6.1-sol')).toBe(true);
    });

    it('a REAL compaction after the resume still records, and so does a live debug notice (control)', async () => {
        const s = open();
        s.replayCompaction();
        s.replayCompaction();
        s.markReady();
        await settle();
        s.session.prompt('carry on', 'you');
        s.replayReasoningNoSummary(99); // the same shape, live now: recorded as ever
        s.send({ sessionUpdate: 'compaction_update', status: 'completed' });
        s.end();
        const rows = await s.rows();
        expect(rows.filter((r) => r.kind === 'divider')).toHaveLength(1);
        expect(rows.some((r) => r.kind === 'notice' && r.message === 'replayed reasoning item had no summary')).toBe(true);
    });
});

/** The rows a replay already wrote (miapa's ledger): dividers with only debug notices between them. */
function onDisk(): TimedEvent[] {
    const out: TimedEvent[] = [];
    let id = 0;
    const push = (event: StreamEvent) => { out.push({ id: `r${id += 1}`, event, at: id * 1000 }); };
    const debug = (message: string): StreamEvent => ({ kind: 'notice', level: 'debug', message, headroom: null, model: null, estimate: null });
    push({ kind: 'turn', n: 56, by: 'you' });
    push({ kind: 'tool', toolCallId: 'exec-1', name: null, title: 'sites', status: 'completed', toolKind: null, rawInput: null } as StreamEvent);
    push({ kind: 'usage', used: 185798, size: 475000, cost: null, inTokens: null, outTokens: null } as StreamEvent);
    for (let k = 0; k < 9; k += 1) {
        push(debug('replayed reasoning item had no summary'));
        push(debug('unmapped Codex item: webSearch'));
        push({ kind: 'divider', variant: 'compaction', before: null, after: null });
    }
    push({ kind: 'turn', n: 57, by: null });
    push({ kind: 'tool', toolCallId: 'exec-2', name: null, title: 'sites', status: 'completed', toolKind: null, rawInput: null } as StreamEvent);
    // A real compaction later on: kept.
    push({ kind: 'divider', variant: 'compaction', before: null, after: null });
    return out;
}

describe('the views tolerate the replayed compactions already on disk (genie#1249)', () => {
    const dividers = (rows: readonly TimedEvent[]) => rows.filter((r) => r.event.kind === 'divider').length;

    it('the Stream shows one compaction per run of repeats, and keeps a real later one', () => {
        expect(dividers(activityRows(onDisk()))).toBe(2);
        expect(dividers(prepareStream(onDisk()).rows)).toBe(2);
    });

    it('the Stream’s incremental fold agrees with its reference, row by row', () => {
        const ledger = onDisk();
        const prep = new StreamPrep();
        for (let n = 1; n <= ledger.length; n += 1) {
            const got = prep.update(ledger.slice(0, n));
            expect(got.rows.map((r) => r.id)).toEqual(prepareStream(ledger.slice(0, n)).rows.map((r) => r.id));
        }
    });

    it('the chat says one "Compacted the context" per run of repeats', () => {
        const detail = { agent: { id: 'a1', name: 'miapa', provider: 'codex', fidelity: 'declared' }, session: null, rows: onDisk() } as unknown as ChatDetail;
        expect(chatMessages(detail).filter((m) => m.text.startsWith('Compacted the context'))).toHaveLength(2);
    });

    it('CONTROL: two compactions with work between them stay two', () => {
        const rows: TimedEvent[] = [
            { id: 'a', event: { kind: 'divider', variant: 'compaction', before: null, after: null }, at: 1 },
            { id: 'b', event: { kind: 'turn', n: 2, by: 'you' }, at: 2 },
            { id: 'c', event: { kind: 'divider', variant: 'compaction', before: null, after: null }, at: 3 },
        ];
        expect(dividers(activityRows(rows))).toBe(2);
        const detail = { agent: { id: 'a1', name: 'miapa', provider: 'codex', fidelity: 'declared' }, session: null, rows } as unknown as ChatDetail;
        expect(chatMessages(detail).filter((m) => m.text.startsWith('Compacted the context'))).toHaveLength(2);
    });

    it('CONTROL: two compactions with DIFFERENT sizes are two compactions', () => {
        const rows: TimedEvent[] = [
            { id: 'a', event: { kind: 'divider', variant: 'compaction', before: 400000, after: 20000 }, at: 1 },
            { id: 'c', event: { kind: 'divider', variant: 'compaction', before: 380000, after: 21000 }, at: 3 },
        ];
        expect(dividers(activityRows(rows))).toBe(2);
    });
});

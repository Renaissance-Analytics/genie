import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { Stream } from '../src/renderer/components/Stream.js';

/**
 * THE LIVE `Thinking…` ROW (the board) — and the defect under it.
 *
 * A thought arrives as a stream of `agent_thought_chunk` frames. Each was mapped to its own `think` row and nothing
 * joined them, so one thought became a column of one-line fragments, each with its own time — exactly what the
 * message rows had before they were joined. The rule is the same: consecutive thought chunks are ONE row; anything
 * else closes it. While the open thought is the last row and the turn runs, the Stream marks it live: a pulsing bar
 * and `Thinking…`. No running token figure, because ACP carries none.
 *
 * Also here: the compaction divider's `turns 1–11 summarised`, derived from the turn markers before it.
 */
const dirs: string[] = [];
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-thought-'));
    dirs.push(d);
    return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function fakeDriver() {
    let events: DriverEvents = {};
    let running = false;
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => { running = true; },
            prompt: () => {},
            kill: () => { running = false; },
            get running() { return running; },
            get cliSessionId() { return null; },
        };
        return driver;
    };
    return { factory, emit: (u: Record<string, unknown>) => events.onUpdate?.(u) };
}

function open() {
    const dir = tempDir();
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const d = fakeDriver();
    const rows: StreamEvent[] = [];
    const replaced: boolean[] = [];
    const session = new AgentSession({
        agentId: id, cwd: dir, store, driverFactory: d.factory, processTree: noProcessTree,
        onEvent: (event, meta) => { rows.push(event); replaced.push(meta?.replacesLast === true); },
    });
    session.start();
    return { d, session, rows, replaced, thread: openAgentThread(store, id) };
}

const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const texts = (rows: readonly StreamEvent[]) => rows.map((r) => (r.kind === 'think' || r.kind === 'message' ? r.text : r.kind));

describe('a streamed thought is ONE row, not one row per chunk', () => {
    it('joins consecutive chunks, replacing after the first — and a tool call between two closes the first', () => {
        const { d, rows, replaced } = open();
        d.emit(thought('I should '));
        d.emit(thought('read the '));
        d.emit(thought('tests first.'));
        d.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'completed' });
        d.emit(thought('Now the fix.'));

        // Three frames, three emissions (a reader watches it type) — the last carrying the whole thought; the tool
        // call; then a NEW thought. The count is the assertion: three fragments would be three rows here.
        expect(replaced).toEqual([false, true, true, false, false]);
        expect(texts(rows.slice(2))).toEqual(['I should read the tests first.', 'tool', 'Now the fix.']);
    });

    it('a message chunk closes the thought (two rows, two kinds), and a thought does not join a message', () => {
        const { d, rows } = open();
        d.emit(thought('hmm'));
        d.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
        d.emit(thought('next'));
        expect(rows.map((r) => r.kind)).toEqual(['think', 'message', 'think']);
        expect(texts(rows)).toEqual(['hmm', 'Done.', 'next']);
    });

    // The owner, 2026-10-14, on beta.22: "it seems to be posting every chunk of a thinking content as individual posts"
    // — `Found` / `that Genie l` / `acks background-shell trac` …, and a column of `Reasoning not sent`. Claude sends a
    // `thinking_tokens` frame between thought deltas; prism-acp maps it to a DEBUG notice carrying the running estimate,
    // and that notice closed the open thought, so every delta opened a new row.
    const estimate = (n: number) => ({ sessionUpdate: 'notice', notice: { level: 'debug', message: 'thinking' }, _meta: { 'particle.academy/thinking_tokens_estimate': n } });

    it('a thinking-estimate notice between deltas does NOT close the thought — one row, carrying the newest estimate', () => {
        const { d, rows, replaced } = open();
        const before = rows.length;
        d.emit(thought('Found'));
        d.emit(estimate(4));
        d.emit(thought(' that Genie l'));
        d.emit(estimate(9));
        d.emit(thought('acks shell tracking.'));
        d.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'completed' });

        const mine = rows.slice(before);
        const opened = replaced.slice(before);
        // COUNTED: one thought opened (the rest replace it), no notice rows, then the tool call.
        expect(mine.filter((r, i) => r.kind === 'think' && !opened[i])).toHaveLength(1);
        expect(mine.filter((r) => r.kind === 'notice')).toHaveLength(0);
        const last = [...mine].reverse().find((r) => r.kind === 'think');
        expect(last).toMatchObject({ kind: 'think', text: 'Found that Genie lacks shell tracking.', estimate: 9 });
    });

    it('a thought the provider did not send (empty deltas with estimates between) is ONE "not sent" row, not one per frame', () => {
        const { d, rows, replaced } = open();
        const before = rows.length;
        d.emit(thought(''));
        d.emit(estimate(12));
        d.emit(thought(''));
        d.emit(estimate(30));
        d.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'completed' });
        const mine = rows.slice(before);
        const opened = replaced.slice(before);
        expect(mine.filter((r, i) => r.kind === 'think' && !opened[i])).toHaveLength(1);
        expect(mine.filter((r) => r.kind === 'notice')).toHaveLength(0);
    });

    it('an estimate with no thought open still arrives as its notice (nothing to fold it into)', () => {
        const { d, rows } = open();
        const before = rows.length;
        d.emit(estimate(3));
        expect(rows.slice(before).map((r) => r.kind)).toEqual(['notice']);
    });

    it('is written to the thread ONCE, when it closes', async () => {
        const { d, session, thread } = open();
        d.emit(thought('a'));
        d.emit(thought('b'));
        d.emit(thought('c'));
        d.emit({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'completed' });
        // Every row written, then counted — not polled against a 1 s clock a loaded Windows disk missed (beta.28 verify).
        await session.settled();
        expect(await thread.count()).toBe(2);
        const kinds = (await thread.messages()).map((m) => (m.message as { kind: string }).kind);
        expect(kinds).toEqual(['think', 'tool']);
    });
});

const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const think = (id: string, text: string, at: number): TimedEvent => t(id, { kind: 'think', text, tokens: null }, at);
const toolRow = (id: string, at: number): TimedEvent =>
    t(id, { kind: 'tool', toolCallId: id, name: 'Bash', title: 'php artisan test', status: 'completed', toolKind: 'execute', rawInput: null }, at);
const render = (rows: readonly TimedEvent[], live: boolean) =>
    renderToStaticMarkup(<Stream rows={rows} lanes={null} at={null} selectedId={null} onSelect={() => {}} agentName="sable" live={live} />);

describe('the live Thinking… row', () => {
    const thinking = [t('t1', { kind: 'turn', n: 1, by: 'you' }, 1_000), think('k1', 'reading the failing test', 1_200)];

    it('marks the last row while the turn runs and it is a thought: the pulsing bar and the word, on that row', () => {
        const html = render(thinking, true);
        expect(html).toMatch(/data-stream-row="k1"[\s\S]*?data-live="thinking"/);
        expect(html).toContain('Thinking…');
        expect((html.match(/data-live="thinking"/g) ?? []).length).toBe(1);
    });

    it('does NOT mark it when the turn is not running (a replayed thread), nor when something followed the thought', () => {
        // Positive control above: the same rows, live, carry the mark.
        expect(render(thinking, false)).not.toContain('data-live');
        expect(render([...thinking, toolRow('b1', 1_400)], true)).not.toContain('data-live');
    });

    it('carries no running token figure — ACP reports none per thought', () => {
        expect(render(thinking, true)).not.toMatch(/\d+ tok/);
    });
});

describe('the compaction divider names the turns it summarised', () => {
    const divider = (id: string, at: number): TimedEvent => t(id, { kind: 'divider', variant: 'compaction', before: 189_000, after: 46_000 }, at);

    it('from the turn markers before it: `turns 1–N`, `turn 1`, or nothing without a marker', () => {
        expect(ledgerRow(divider('c', 1), { summarisedTurns: 11 }).main).toBe('context compacted · 189k → 46k · turns 1–11 summarised');
        expect(ledgerRow(divider('c', 1), { summarisedTurns: 1 }).main).toBe('context compacted · 189k → 46k · turn 1 summarised');
        expect(ledgerRow(divider('c', 1), { summarisedTurns: 0 }).main).toBe('context compacted · 189k → 46k');
        expect(ledgerRow(divider('c', 1)).main).toBe('context compacted · 189k → 46k');
    });

    it('the Stream derives the count over the whole ledger, even with the turn markers behind a lane filter', () => {
        const rows = [
            t('t1', { kind: 'turn', n: 1, by: 'you' }, 1_000),
            think('k1', 'one', 1_100),
            t('t2', { kind: 'turn', n: 2, by: 'you' }, 2_000),
            toolRow('b1', 2_100),
            divider('cmp', 2_500),
            t('t3', { kind: 'turn', n: 3, by: 'you' }, 3_000),
        ];
        const html = renderToStaticMarkup(<Stream rows={rows} lanes={['edits']} at={null} selectedId={null} onSelect={() => {}} agentName="sable" />);
        expect(html).toContain('turns 1–2 summarised');
        expect(html).not.toContain('turns 1–3');
    });
});

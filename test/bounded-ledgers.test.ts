import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryPair } from '../src/core/line-transport.js';
import { agentRecord, mintAgentId, type AgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import * as threadStore from '../src/core/thread-store.js';
import { openAgentThread, openDurableStore, readHistory, threadLogFile, RUN_FIELD } from '../src/core/thread-store.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { sessionsDir } from '../src/main/paths.js';

/**
 * BOUNDED AGENT LEDGERS (Tynn story #386; .ai/plans/genie-crash-safe-mode-reporting-spec.md §3).
 *
 * The window's main hung twice on 2026-11-06. One agent's ledger was 959 MB / 384,564 rows: 57 MB in the 25 minutes
 * before the hang, rows up to 238 KB, each tool stored twice (in_progress and completed). At boot Genie resumed the
 * running agents and loaded up to 3,000 rows per agent with no byte bound, so the hang came back.
 *
 * The contract pinned here:
 *  - a tool row stores at most a 16 KB preview of its input and of its output; the full output is a sidecar file
 *    `<ledger>/tool-<id>.out` beside the ledger, named from the row;
 *  - an `in_progress` row never carries output;
 *  - a history load is bounded by bytes as well as rows, held to a host-side ceiling a caller cannot raise;
 *  - the window's rows carry the preview only, and the whole output is fetched on demand;
 *  - an old ledger is not rewritten: an oversized row in it is cut to the preview when it is read.
 *
 * Every payload here is synthetic: a HEAD marker, filler and a TAIL marker, so "the preview has the head and not the
 * tail" is a positive control and an absence in one assertion.
 */
const KB = 1024;
const PREVIEW = 16 * KB;
const HEAD = 'HEAD-OF-THE-OUTPUT ';
const TAIL = ' TAIL-OF-THE-OUTPUT';
const big = (bytes: number, head = HEAD, tail = TAIL): string => head + 'x'.repeat(bytes - head.length - tail.length) + tail;
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

let dir: string;
let hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-ledger-bound-')); hosts = []; });
afterEach(async () => { await Promise.all(hosts.map((h) => h.settled())); await rm(dir, { recursive: true, force: true }); });

const tree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const TOKEN = 'ledger-token';

function rig() {
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((o: { events: DriverEvents }) => {
        events = o.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    }) as unknown as SessionDriverFactory;
    const host = new SessionHost({ userData: dir, driverFor, processTree: tree });
    hosts.push(host);
    return { host, events: () => events };
}

/** The ledger's stored tool rows, read from the file itself (what the next boot reads). */
async function storedToolRows(agentId: AgentId): Promise<{ line: string; message: Record<string, unknown> }[]> {
    const text = await readFile(threadLogFile(sessionsDir(dir), agentId), 'utf8');
    return text.split('\n').filter((l) => l.trim() !== '').flatMap((line) => {
        const entry = JSON.parse(line) as { message: Record<string, unknown> };
        return entry.message['kind'] === 'tool' ? [{ line, message: entry.message }] : [];
    });
}

/** Where the spec puts a tool's whole output: a folder named like the ledger, beside it. */
function sidecarOf(agentId: AgentId, file: string): string {
    const log = threadLogFile(sessionsDir(dir), agentId);
    return join(dirname(log), basename(log, '.jsonl'), file);
}

/** One running agent that made one tool call: started, its input, then its 238 KB answer. */
async function oneHugeToolCall(r: ReturnType<typeof rig>, output = big(238 * KB)) {
    const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'atlas' });
    r.host.start(record, dir);
    r.host.prompt(record.id, 'Build it', 'you');
    r.events().onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Run the build', kind: 'execute', status: 'in_progress', rawInput: { command: 'make all' }, rawOutput: 'PARTIAL-OUTPUT-WHILE-RUNNING' } as never);
    r.events().onUpdate?.({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: output } as never);
    r.events().onTurnEnd?.({ stopReason: 'end_turn' } as never);
    await r.host.settled();
    return { record, output };
}

/** A ledger written in the OLD format (before this change): every row whole, as the 959 MB one was. */
async function seedOldLedger(agentId: AgentId, rows: readonly Record<string, unknown>[]): Promise<void> {
    const thread = openAgentThread(openDurableStore(sessionsDir(dir)), agentId);
    for (let i = 0; i < rows.length; i += 50) await thread.record(rows.slice(i, i + 50) as never);
}
const oldToolRow = (i: number, input: number, output: number): Record<string, unknown> => ({
    kind: 'tool', toolCallId: `old_${i}`, name: 'exec', title: `step ${i}`, status: 'completed', toolKind: 'execute',
    rawInput: { command: big(input, `INPUT-${i} `, ' INPUT-TAIL') }, output: big(output, `OUTPUT-${i} `, TAIL), [RUN_FIELD]: 'run-old',
});

/** Reached loosely: before the contract exists these are red by assertion, not by a type error in another file. */
const ceiling = (): number => {
    const value = (threadStore as Record<string, unknown>)['HISTORY_MAX_BYTES'];
    expect(value, 'thread-store HISTORY_MAX_BYTES').toBeTypeOf('number');
    return value as number;
};
type ToolOutputReply = { ok: true; text: string; bytes: number; cut: boolean } | { ok: false; reason: string };
const toolOutputOf = (target: object): ((agentId: AgentId, toolCallId: string) => Promise<ToolOutputReply>) => {
    const fn = (target as { toolOutput?: (a: AgentId, c: string) => Promise<ToolOutputReply> }).toolOutput;
    expect(fn, 'toolOutput').toBeTypeOf('function');
    return fn!.bind(target);
};

describe('a tool row is stored bounded (spec §3)', () => {
    it('a 238 KB output is stored as a preview of at most 16 KB, and the full bytes go in the sidecar the row names', async () => {
        const r = rig();
        const { record, output } = await oneHugeToolCall(r);
        const completed = (await storedToolRows(record.id)).filter((row) => row.message['status'] === 'completed');
        expect(completed).toHaveLength(1);
        const row = completed[0]!.message;
        // The preview: the head of the answer, never its tail, at most 16 KB.
        expect(typeof row['output']).toBe('string');
        expect(Buffer.byteLength(row['output'] as string, 'utf8')).toBeLessThanOrEqual(PREVIEW);
        expect(row['output'] as string).toContain(HEAD.trim());
        expect(row['output'] as string).not.toContain(TAIL.trim());
        // The whole row stays small: a preview, the input and the row's own fields.
        expect(Buffer.byteLength(completed[0]!.line, 'utf8')).toBeLessThan(PREVIEW + 4 * KB);
        // The row says how big the whole answer is and where it is.
        expect(row['outputBytes']).toBe(Buffer.byteLength(output, 'utf8'));
        expect(row['outputFile']).toBe('tool-call_1.out');
        const sidecar = sidecarOf(record.id, row['outputFile'] as string);
        expect((await stat(sidecar)).size).toBe(Buffer.byteLength(output, 'utf8'));
        expect(await readFile(sidecar, 'utf8')).toBe(output);
    });

    it('an in_progress row carries no output — only the completed one does', async () => {
        const r = rig();
        const { record } = await oneHugeToolCall(r);
        const rows = await storedToolRows(record.id);
        const running = rows.filter((row) => row.message['status'] === 'in_progress');
        expect(running).toHaveLength(1);
        expect(running[0]!.message).not.toHaveProperty('output');
        expect(running[0]!.line).not.toContain('PARTIAL-OUTPUT-WHILE-RUNNING');
        // Positive control: the same call's completed row does carry its (preview) output.
        expect(rows.find((row) => row.message['status'] === 'completed')!.message['output']).toEqual(expect.stringContaining(HEAD.trim()));
    });

    it('a 238 KB input is stored as a preview of at most 16 KB that keeps its shape', async () => {
        const r = rig();
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        r.host.start(record, dir);
        r.host.prompt(record.id, 'Write it', 'you');
        const content = big(238 * KB);
        r.events().onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'call_w', title: 'Write notes.md', kind: 'edit', status: 'completed', rawInput: { file_path: 'notes.md', content } } as never);
        r.events().onTurnEnd?.({ stopReason: 'end_turn' } as never);
        await r.host.settled();
        const [row] = await storedToolRows(record.id);
        const input = row!.message['rawInput'] as Record<string, unknown>;
        expect(bytesOf(input)).toBeLessThanOrEqual(PREVIEW);
        // The shape survives (the stream reads an edit's path from it); the long field is its head.
        expect(input['file_path']).toBe('notes.md');
        expect(input['content'] as string).toContain(HEAD.trim());
        expect(input['content'] as string).not.toContain(TAIL.trim());
        expect(row!.message['inputBytes']).toBe(bytesOf({ file_path: 'notes.md', content }));
    });
});

describe('a history load is bounded by bytes as well as rows (spec §3)', { timeout: 60_000 }, () => {
    it('a ledger of huge rows: the load stays within the byte ceiling and the row count, keeps the newest rows, and a caller cannot raise it', async () => {
        const id = mintAgentId();
        // 400 old rows of 40 KB input and 40 KB output: 32 MB on disk; even cut to previews, more than any ceiling.
        const total = 400;
        await seedOldLedger(id, Array.from({ length: total }, (_, i) => oldToolRow(i, 40 * KB, 40 * KB)));
        const limit = ceiling();
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(8 * 1024 * KB);
        const h = await readHistory(openDurableStore(sessionsDir(dir)), id, { limit: 3000, maxBytes: Number.MAX_SAFE_INTEGER } as never);
        expect(bytesOf(h.rows.map((row) => ({ event: row.event, at: row.at })))).toBeLessThanOrEqual(limit);
        expect(h.rows.length).toBeGreaterThan(0);
        expect(h.rows.length).toBeLessThan(total);
        // Nothing lost from the count: what was left out is `earlier`, and the newest row is the last one kept.
        expect(h.rows.length + h.earlier).toBe(total);
        expect((h.rows.at(-1)!.event as { toolCallId: string }).toolCallId).toBe(`old_${total - 1}`);
        // A smaller ask is honoured.
        const small = await readHistory(openDurableStore(sessionsDir(dir)), id, { limit: 3000, maxBytes: 100 * KB } as never);
        expect(bytesOf(small.rows.map((row) => ({ event: row.event, at: row.at })))).toBeLessThanOrEqual(100 * KB);
        expect(small.rows.length).toBeGreaterThan(0);
        // And the row bound still holds on its own.
        expect((await readHistory(openDurableStore(sessionsDir(dir)), id, { limit: 3 })).rows).toHaveLength(3);
    });

    it('the Agent view’s history at boot (ledgerFor) is held to the ceiling: 3,000 rows of 200 KB each never load whole', async () => {
        const id = mintAgentId();
        // The boot case: an agent resumed with a long ledger of big rows (3,000 of them, written short here: the bound
        // is the point, and 200 KB rows × 3,000 is 600 MB nobody needs on a runner). 300 rows of 200 KB = 60 MB.
        await seedOldLedger(id, Array.from({ length: 300 }, (_, i) => oldToolRow(i, 100 * KB, 100 * KB)));
        const r = rig();
        const record = agentRecord({ id, workspaceId: 'tynn', provider: 'codex', name: 'atlas' });
        const started = Date.now();
        const rows = await vi.waitFor(() => {
            const got = r.host.ledgerFor(record.id);
            expect(got.length).toBeGreaterThan(1);
            return got;
        }, { timeout: 30_000 });
        expect(bytesOf(rows)).toBeLessThanOrEqual(ceiling() + 64 * KB);
        for (const row of rows) expect(bytesOf(row)).toBeLessThan(2 * PREVIEW + 4 * KB);
        expect(JSON.stringify(rows)).not.toContain(TAIL.trim());
        // A time bound, loose enough for a slow runner: the whole 60 MB parse took the window seconds before.
        expect(Date.now() - started).toBeLessThan(25_000);
    });

    it('an old ledger with a 1 MB row loads bounded: the row is cut to the preview when it is read, never whole', async () => {
        const id = mintAgentId();
        await seedOldLedger(id, [
            { kind: 'message', speaker: 'you', peerName: null, text: 'before', [RUN_FIELD]: 'run-old' },
            oldToolRow(1, 1024 * KB, 1024 * KB),
            { kind: 'message', speaker: 'agent', peerName: null, text: 'after', [RUN_FIELD]: 'run-old' },
        ]);
        const h = await readHistory(openDurableStore(sessionsDir(dir)), id, { limit: 3000 });
        expect(h.rows.map((row) => row.event.kind)).toEqual(['message', 'tool', 'message']);
        const tool = h.rows[1]!.event as Record<string, unknown>;
        expect(bytesOf(tool)).toBeLessThan(2 * PREVIEW + 2 * KB);
        expect(tool['output'] as string).toContain('OUTPUT-1');
        expect(tool['output'] as string).not.toContain(TAIL.trim());
        expect(tool['outputBytes']).toBe(1024 * KB);
        // An old row has no sidecar: it names none, so the window never offers a whole it cannot fetch.
        expect(tool).not.toHaveProperty('outputFile');
        expect(((tool['rawInput'] as Record<string, unknown>)['command'] as string)).toContain('INPUT-1');
        expect(tool['inputBytes']).toBeGreaterThan(1024 * KB);
        // The file was not rewritten.
        expect((await stat(threadLogFile(sessionsDir(dir), id))).size).toBeGreaterThan(2 * 1024 * KB);
    });
});

describe('the window gets the preview; the whole output on demand (spec §3)', () => {
    it('the row patch over the engine link carries only the preview, and the whole output is fetched when asked', async () => {
        const server = new SessionEngineServer({ token: TOKEN, build: 't' });
        const r = rig();
        server.attach(r.host);
        const { record, output } = await oneHugeToolCall(r);
        const [h, w] = memoryPair();
        server.accept(h);
        const client = new SessionEngineClient();
        expect(await client.connect(w, TOKEN)).toMatchObject({ ok: true });
        const tool = await vi.waitFor(() => {
            const found = client.ledgerFor(record.id).find((row) => row.event.kind === 'tool' && row.event.status === 'completed');
            expect(found).toBeDefined();
            return found!;
        }, { timeout: 5000 });
        // What reached the window: the preview (positive control: its head), never the tail, the row small.
        expect(JSON.stringify(tool)).toContain(HEAD.trim());
        expect(JSON.stringify(tool)).not.toContain(TAIL.trim());
        expect(bytesOf(tool)).toBeLessThan(PREVIEW + 4 * KB);
        expect(JSON.stringify(client.ledgerFor(record.id))).not.toContain('PARTIAL-OUTPUT-WHILE-RUNNING');
        // Expanding the row: the whole output, from the host's sidecar, over the same link.
        const whole = await toolOutputOf(client)(record.id, 'call_1');
        expect(whole).toEqual({ ok: true, text: output, bytes: Buffer.byteLength(output, 'utf8'), cut: false });
        // A call with no sidecar is a refusal with a reason, never an empty answer.
        const none = await toolOutputOf(client)(record.id, 'call_missing');
        expect(none.ok).toBe(false);
        expect((none as { reason: string }).reason.length).toBeGreaterThan(0);
    });

    it('the host answers the whole output from its own store (SessionHost.toolOutput)', async () => {
        const r = rig();
        const { record, output } = await oneHugeToolCall(r);
        expect(await toolOutputOf(r.host)(record.id, 'call_1')).toEqual({ ok: true, text: output, bytes: Buffer.byteLength(output, 'utf8'), cut: false });
    });
});

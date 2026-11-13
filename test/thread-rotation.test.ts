import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import { openAgentThread, readHistory, readPromptRows, readWholeHistory, threadLogFile, ThreadStore, THREAD_ROTATE_BYTES, RUN_FIELD } from '../src/core/thread-store.js';

/*
 * Tynn #557. The owner's machine, 2026-11-08: a 1.03 GB thread log (and others in the hundreds of MB). deliverOwed
 * scanned it whole (`engine.deliverOwed ms=48251`), a restart counted every line, and every append synced the whole
 * file. Thread logs rotate at a size bound; the older segments are indexed once and read only when a page needs them.
 */
type Options = { rotateBytes?: number; slowMs?: number; onSlow?: (line: string) => void };
type Rotating = ThreadStore & { indexing?(key: string): Promise<void> };
const make = (directory: string, options: Options = {}): Rotating => new (ThreadStore as unknown as new (d: string, o?: Options) => Rotating)(directory, options);
const keyOf = (id: AgentId) => `genie:agent:${id}:thread`;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-rotation-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const segmentsOf = async (id: AgentId): Promise<string[]> => {
    const base = threadLogFile(dir, id).slice(dir.length + 1).replace(/\.jsonl$/, '');
    return (await readdir(dir)).filter((f) => f.startsWith(`${base}.`) && f.endsWith('.jsonl') && f !== `${base}.jsonl`);
};

/** `turns` turns written through the real store and Thread, by runs of 5 turns each; one pending draft in turn 2. */
async function seed(store: Rotating, id: AgentId, turns: number): Promise<number> {
    const thread = openAgentThread(store, id);
    let rows = 0;
    for (let t = 1; t <= turns; t += 1) {
        const run = `run-${Math.ceil(t / 5)}`;
        const batch: Record<string, unknown>[] = [{ kind: 'turn', n: t, by: 'you', [RUN_FIELD]: run }, { kind: 'message', speaker: 'you', peerName: null, text: `question ${t}`, [RUN_FIELD]: run }];
        if (t === 2) batch.push({ kind: 'message', speaker: 'you', peerName: null, text: 'a draft kept for later', pending: { id: 'draft-1', content: null }, [RUN_FIELD]: run }, { kind: 'prompt_delivery', id: 'draft-1', status: 'undelivered', [RUN_FIELD]: run });
        for (let i = 0; i < 6; i += 1) batch.push({ kind: 'tool', toolCallId: `c${t}-${i}`, name: null, title: `step ${i}`, status: 'completed', toolKind: 'execute', rawInput: { command: `echo ${i}` }, output: 'x'.repeat(300), [RUN_FIELD]: run });
        batch.push({ kind: 'message', speaker: 'agent', peerName: null, text: `answer ${t}`, [RUN_FIELD]: run }, { kind: 'finished', n: t, [RUN_FIELD]: run });
        await thread.record(batch as never);
        rows += batch.length;
    }
    return rows;
}

describe('a thread log rotates at its size bound', () => {
    it('the active log stays near the bound; positions run on across segments, and a restart counts them all', async () => {
        const id = mintAgentId(), store = make(dir, { rotateBytes: 16 * 1024 });
        const rows = await seed(store, id, 60);
        await store.indexing?.(keyOf(id));
        expect((await segmentsOf(id)).length).toBeGreaterThan(3);
        expect((await stat(threadLogFile(dir, id))).size).toBeLessThan(16 * 1024 + 8 * 1024);
        expect(await store.logLength(keyOf(id))).toBe(rows);
        // A restart: a fresh store instance, nothing cached.
        expect(await make(dir, { rotateBytes: 16 * 1024 }).logLength(keyOf(id))).toBe(rows);
        const whole = await readWholeHistory(store, id);
        expect(whole.rows.map((r) => r.position)).toEqual(Array.from({ length: rows }, (_, i) => i + 1));
    });

    it('history paging across segments is exactly the whole read, with every option', async () => {
        const id = mintAgentId(), store = make(dir, { rotateBytes: 16 * 1024 });
        await seed(store, id, 60);
        await store.indexing?.(keyOf(id));
        const fresh = make(dir, { rotateBytes: 16 * 1024 });
        expect((await segmentsOf(id)).length).toBeGreaterThan(3);
        for (const options of [{ limit: 0 }, { limit: 7 }, { limit: 150 }, { limit: 400 }, { limit: 5000 }, { limit: 50, run: 'run-12' }, { limit: 50, run: 'run-1' }, { limit: 30, maxBytes: 9000 }]) {
            const paged = await readHistory(fresh, id, options);
            const whole = await readWholeHistory(fresh, id, options);
            expect({ options, paged }).toEqual({ options, paged: whole });
        }
    });

    it('a draft owed from an old segment is still found, and a cleared thread leaves no segment behind', async () => {
        const id = mintAgentId(), store = make(dir, { rotateBytes: 16 * 1024 });
        await seed(store, id, 60);
        await store.indexing?.(keyOf(id));
        const prompt = await readPromptRows(make(dir, { rotateBytes: 16 * 1024 }), id);
        expect(prompt.rows.filter((r) => r.event.kind === 'message').map((r) => (r.event as { text: string }).text)).toEqual(['a draft kept for later']);
        expect(prompt.rows.some((r) => r.event.kind === 'prompt_delivery')).toBe(true);
        await store.clearLog(keyOf(id));
        expect(await segmentsOf(id)).toEqual([]);
        expect(await store.logLength(keyOf(id))).toBe(0);
    });

    it('CONTROL: a thread under the bound is one file, as before', async () => {
        const id = mintAgentId(), store = make(dir, { rotateBytes: 64 * 1024 * 1024 });
        const rows = await seed(store, id, 10);
        expect(await segmentsOf(id)).toEqual([]);
        expect(await store.logLength(keyOf(id))).toBe(rows);
    });
});

/** An old log written straight to disk up to `minimumBytes`, ending on a complete row; one draft near the start. */
async function bigOldLog(id: AgentId, minimumBytes: number): Promise<number> {
    const out = createWriteStream(threadLogFile(dir, id));
    const pad = 'y'.repeat(4000);
    let position = 0, bytes = 0;
    const line = (message: Record<string, unknown>) => `${JSON.stringify({ position: ++position, message, run_id: null, recorded_at: new Date(Date.UTC(2026, 9, 1) + position * 1000).toISOString() })}\n`;
    const write = (text: string) => new Promise<void>((resolve) => { bytes += text.length; if (out.write(text)) resolve(); else out.once('drain', () => resolve()); });
    await write(line({ kind: 'turn', n: 1, by: 'you', [RUN_FIELD]: 'old-run' }));
    await write(line({ kind: 'message', speaker: 'you', peerName: null, text: 'an old draft', pending: { id: 'old-draft', content: null }, [RUN_FIELD]: 'old-run' }));
    while (bytes < minimumBytes) await write(line({ kind: 'notice', level: 'info', message: pad, [RUN_FIELD]: 'old-run' }));
    await new Promise<void>((resolve) => out.end(() => resolve()));
    return position;
}

describe('a big old thread costs a page, not the file, once it has rotated', () => {
    it('deliverOwed, restart and history each take under 100 ms after appending past the default rotation bound', async () => {
        const id = mintAgentId();
        // Tynn #671: keep a LARGE-history speed case: a real 64 MiB history, the default store (no tiny test cap),
        // and all four <100 ms checks after indexing. One complete row past the cap triggers the real rotation path.
        // This no longer benchmarks 512 MiB specifically. prism-harness-0103 keeps >512 MiB functional/string-size
        // coverage, not these latency checks; the assertions below require the indexed segment and bounded active log.
        const rows = await bigOldLog(id, THREAD_ROTATE_BYTES + 1);
        const oldBytes = (await stat(threadLogFile(dir, id))).size;
        expect(oldBytes).toBeGreaterThan(THREAD_ROTATE_BYTES);
        expect(oldBytes).toBeLessThan(THREAD_ROTATE_BYTES + 8 * 1024);
        const store = make(dir);
        await openAgentThread(store, id).record([{ kind: 'notice', level: 'info', message: 'new run', [RUN_FIELD]: 'new-run' }] as never);
        await store.indexing?.(keyOf(id));
        expect(await segmentsOf(id)).toHaveLength(1);
        expect((await stat(threadLogFile(dir, id))).size).toBeLessThan(THREAD_ROTATE_BYTES);
        const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => { const t0 = performance.now(); const value = await fn(); return { value, ms: performance.now() - t0 }; };
        const restart = make(dir);
        const length = await timed(() => restart.logLength(keyOf(id)));
        expect(length.value).toBe(rows + 1);
        const owed = await timed(() => readPromptRows(make(dir), id));
        expect(owed.value.rows.map((r) => r.event.kind)).toContain('message');
        const counted = await timed(() => readHistory(make(dir), id, { limit: 0 }));
        expect(counted.value.earlier).toBe(rows + 1);
        const page = await timed(() => readHistory(make(dir), id, { limit: 50 }));
        expect(page.value.rows).toHaveLength(50);
        expect({ logLength: length.ms < 100, deliverOwed: owed.ms < 100, restart: counted.ms < 100, page: page.ms < 100 }).toEqual({ logLength: true, deliverOwed: true, restart: true, page: true });
    }, 120_000);
});

describe('a slow thread-store step names itself', () => {
    it('an append past the threshold logs each step it took: open, write, sync, close', async () => {
        const lines: string[] = [];
        const id = mintAgentId(), store = make(dir, { slowMs: 0, onSlow: (line) => lines.push(line) });
        await openAgentThread(store, id).record([{ kind: 'notice', level: 'info', message: 'hello' }] as never);
        for (const step of ['open', 'write', 'sync', 'close']) expect(lines.some((l) => l.includes('thread-store') && l.includes(`step=${step}`) && /ms=\d+/.test(l))).toBe(true);
    });

    it('CONTROL: nothing is logged under the threshold', async () => {
        const lines: string[] = [];
        const id = mintAgentId(), store = make(dir, { slowMs: 60_000, onSlow: (line) => lines.push(line) });
        await openAgentThread(store, id).record([{ kind: 'notice', level: 'info', message: 'hello' }] as never);
        expect(lines).toEqual([]);
    });
});

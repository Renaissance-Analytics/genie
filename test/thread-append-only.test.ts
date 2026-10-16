import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId, threadKeyFor } from '../src/core/identity.js';
import { openAgentThread, openDurableStore, readHistory } from '../src/core/thread-store.js';

/**
 * A NEW ROW COSTS ITS OWN SIZE, NOT THE THREAD'S (the owner's UI lag, 2026-10-16). prism-harness up to 0.6 re-read,
 * re-parsed and rewrote the WHOLE thread file on every `record()`. One agent's thread on the owner's machine was
 * 29,478 rows / 9.6 MB, rewritten on every streamed row. 0.7.0 keeps an append-only log beside the payload: one line
 * per row, the payload left alone.
 *
 * What Genie relies on, pinned here against the real package: appending writes a line to a log and does not touch the
 * old whole-thread file; and a thread already on disk in the old format reads back the same and carries on numbering.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-thread-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const row = (i: number) => ({ kind: 'notice', level: 'info', message: `row ${i}`, headroom: null, model: null, estimate: null });
const files = async () => (await readdir(dir)).sort();
const lines = async (name: string) => (await readFile(join(dir, name), 'utf8')).split('\n').filter((l) => l.trim() !== '').length;

describe('appending to a thread', () => {
    it('writes one line to an append-only log and leaves the whole-thread file untouched', async () => {
        const id = mintAgentId();
        const thread = openAgentThread(openDurableStore(dir), id);
        await thread.record(Array.from({ length: 200 }, (_, i) => row(i)));
        const logs = (await files()).filter((f) => f.endsWith('.jsonl'));
        expect(logs).toHaveLength(1);
        const log = logs[0]!;
        expect(await lines(log)).toBe(200);
        const payload = (await files()).find((f) => f.endsWith('.json'));
        const payloadBefore = payload ? (await stat(join(dir, payload))).size : null;

        await thread.record([row(200)]);

        expect(await lines(log)).toBe(201);
        // The whole-thread file is not rewritten for a new row (absent, or the same size).
        const payloadAfter = payload ? (await stat(join(dir, payload))).size : null;
        expect(payloadAfter).toBe(payloadBefore);
        expect(await thread.count()).toBe(201);
    });
});

describe('a thread written by the previous version', () => {
    it('CONTROL: reads back the same, row for row, and the next row continues its numbering', async () => {
        const id = mintAgentId();
        const key = threadKeyFor(id);
        const name = createHash('sha256').update(key).digest('hex').slice(0, 32);
        const messages = Array.from({ length: 50 }, (_, i) => ({ position: i + 1, message: row(i), run_id: null, recorded_at: new Date(Date.UTC(2026, 9, 14, 12, 0, i)).toISOString() }));
        await writeFile(join(dir, `${name}.json`), JSON.stringify({ key, payload: { messages }, expires_at: null }));
        const store = openDurableStore(dir);

        const before = await readHistory(store, id);
        expect(before.rows.map((r) => (r.event as { message?: string }).message)).toEqual(messages.map((m) => m.message.message));
        expect(before.rows.map((r) => r.position)).toEqual(messages.map((m) => m.position));

        await openAgentThread(store, id).record([row(50)]);
        const after = await readHistory(openDurableStore(dir), id);
        expect(after.rows).toHaveLength(51);
        expect(after.rows.at(-1)!.position).toBe(51);
        expect((after.rows.at(-1)!.event as { message?: string }).message).toBe('row 50');
    });
});

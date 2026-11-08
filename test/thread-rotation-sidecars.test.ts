import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import { openAgentThread, threadLogFile, ThreadStore, RUN_FIELD } from '../src/core/thread-store.js';

/*
 * prism-harness 0.10.2 keeps a line-count sidecar beside a log: `<log>.index.json`, matched to the file by size, times,
 * inode and device. Rotation renames the active log (Tynn #557) — a rename changes its ctime, so a moved sidecar would
 * never match its segment, and the one left behind describes a file that is gone. Rotation and clearLog take them along.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-sidecars-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const sidecars = async (): Promise<string[]> => (await readdir(dir)).filter((f) => f.endsWith('.index.json')).sort();
const record = (store: ThreadStore, id: AgentId, n: number) => openAgentThread(store, id).record([{ kind: 'notice', level: 'info', message: 'x'.repeat(2000), n, [RUN_FIELD]: 'run' }] as never);
const keyOf = (id: AgentId) => `genie:agent:${id}:thread`;

describe("the harness's log sidecar follows rotation and clearing", () => {
    it('a rotation removes the active log\'s sidecar; no segment carries one', async () => {
        const id = mintAgentId(), store = new ThreadStore(dir, { rotateBytes: 8 * 1024 });
        await record(store, id, 1);
        await writeFile(`${threadLogFile(dir, id)}.index.json`, '{"version":1}', 'utf8');
        for (let n = 2; n <= 8; n += 1) await record(store, id, n);
        await store.indexing(keyOf(id));
        expect((await readdir(dir)).filter((f) => /\.\d{6}\.jsonl$/.test(f)).length).toBeGreaterThan(0);
        expect(await sidecars()).toEqual([]);
    });

    it('clearLog removes every segment\'s sidecar and the active one', async () => {
        const id = mintAgentId(), store = new ThreadStore(dir, { rotateBytes: 8 * 1024 });
        for (let n = 1; n <= 12; n += 1) await record(store, id, n);
        await store.indexing(keyOf(id));
        const segments = (await readdir(dir)).filter((f) => /\.\d{6}\.jsonl$/.test(f));
        expect(segments.length).toBeGreaterThan(1);
        for (const seg of segments) await writeFile(join(dir, `${seg}.index.json`), '{"version":1}', 'utf8');
        await writeFile(`${threadLogFile(dir, id)}.index.json`, '{"version":1,"stale":true}', 'utf8');
        await store.clearLog(keyOf(id));
        expect(await sidecars()).toEqual([]);
    });

    it('CONTROL: an append that does not rotate leaves the active sidecar alone', async () => {
        const id = mintAgentId(), store = new ThreadStore(dir, { rotateBytes: 64 * 1024 * 1024 });
        await record(store, id, 1);
        await writeFile(`${threadLogFile(dir, id)}.index.json`, '{"version":1}', 'utf8');
        await record(store, id, 2);
        expect(await sidecars()).toHaveLength(1);
    });
});

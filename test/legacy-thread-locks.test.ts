import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSessionStore } from '@particle-academy/prism-harness';
import { mintAgentId } from '../src/core/identity.js';
import { openAgentThread, readWholeHistory, ThreadStore, RUN_FIELD } from '../src/core/thread-store.js';

/*
 * prism-harness 0.10 locks a thread with a DIRECTORY; 0.8.0 (what Genie ran) used a FILE (`<digest>.json.lock`, its
 * expiry stamp inside). 0.10 refuses a legacy lock file outright (`legacy_lock_requires_maintenance`), forever — and the
 * owner's sessions folder has such files left behind. A thread with one would never be written again. Genie's store
 * clears a legacy lock once its stamp has expired (waiting out one still live, as 0.8.0 did) before it locks.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-legacy-locks-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const lockOf = (id: string) => join(dir, `${createHash('sha256').update(`genie:agent:${id}:thread`).digest('hex').slice(0, 32)}.json.lock`);
const row = (text: string) => [{ kind: 'notice', level: 'info', message: text, [RUN_FIELD]: 'run' }] as never;

describe('a legacy thread lock file', () => {
    it('an expired one is cleared, and the thread is written', async () => {
        const id = mintAgentId();
        await writeFile(lockOf(id), `${Date.now() - 60_000}\n`, 'utf8');
        const store = new ThreadStore(dir);
        await openAgentThread(store, id).record(row('after the upgrade'));
        const history = await readWholeHistory(store, id);
        expect(history.rows.map((r) => (r.event as { message?: string }).message)).toEqual(['after the upgrade']);
    });

    it('a live one is waited out, then cleared, and the thread is written', async () => {
        const id = mintAgentId();
        await writeFile(lockOf(id), `${Date.now() + 400}\n`, 'utf8');
        const store = new ThreadStore(dir);
        const started = Date.now();
        await openAgentThread(store, id).record(row('after its holder'));
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        expect((await readWholeHistory(store, id)).rows).toHaveLength(1);
    });

    it('a stamp absurdly far ahead on an old file cannot hang the write: its age bounds it', async () => {
        const id = mintAgentId();
        await writeFile(lockOf(id), `${Date.now() + 3_600_000}\n`, 'utf8');
        const longAgo = new Date(Date.now() - 10 * 60_000);
        await utimes(lockOf(id), longAgo, longAgo);
        const store = new ThreadStore(dir);
        await openAgentThread(store, id).record(row('not hung'));
        expect((await readWholeHistory(store, id)).rows).toHaveLength(1);
    });

    it("CONTROL: a current lock held by another writer is respected until it is released", async () => {
        const id = mintAgentId(), key = `genie:agent:${id}:thread`;
        let release!: () => void, taken!: () => void;
        const held = new Promise<void>((r) => { release = r; }), isTaken = new Promise<void>((r) => { taken = r; });
        const holder = new FileSessionStore(dir).withLock(key, async () => { taken(); await held; }, 30, 1);
        await isTaken;
        const store = new ThreadStore(dir);
        let written = false;
        const writing = openAgentThread(store, id).record(row('after release')).then(() => { written = true; });
        await new Promise((r) => setTimeout(r, 300));
        expect(written).toBe(false);
        release();
        await holder;
        await writing;
        expect(written).toBe(true);
        await expect(stat(lockOf(id))).rejects.toThrow();
    });
});

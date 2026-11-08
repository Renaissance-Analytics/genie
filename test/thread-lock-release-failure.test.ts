import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSessionStore } from '@particle-academy/prism-harness';
import { mintAgentId } from '../src/core/identity.js';
import { openAgentThread, readWholeHistory, ThreadStore, RUN_FIELD } from '../src/core/thread-store.js';

/*
 * prism-harness 0.10's withLock can REJECT AFTER its callback ran: releasing the lock directory fails (EPERM on Windows,
 * a scanner holding a handle) and the SDK keeps the release for the next lock. 0.8.0's release never threw. The row is
 * already in the log by then, and the session's write retries on EPERM, so taking that rejection as a failed write
 * would append the same rows twice.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-lock-release-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
const row = (text: string) => [{ kind: 'notice', level: 'info', message: text, [RUN_FIELD]: 'run' }] as never;
const real = FileSessionStore.prototype.withLock;

describe('a lock release that fails after the write', () => {
    it('is not a failed write: the record resolves and the row is there once', async () => {
        vi.spyOn(FileSessionStore.prototype, 'withLock').mockImplementation(async function (this: FileSessionStore, key: string, callback: () => unknown, ttl?: number, wait?: number) {
            await real.call(this, key, callback as () => Promise<unknown>, ttl, wait);
            throw eperm();
        } as never);
        const id = mintAgentId(), store = new ThreadStore(dir);
        await openAgentThread(store, id).record(row('once'));
        vi.restoreAllMocks();
        expect((await readWholeHistory(store, id)).rows).toHaveLength(1);
    });

    it('CONTROL: a lock that was never taken still rejects, so the write is retried', async () => {
        vi.spyOn(FileSessionStore.prototype, 'withLock').mockImplementation((async () => { throw eperm(); }) as never);
        const id = mintAgentId(), store = new ThreadStore(dir);
        await expect(openAgentThread(store, id).record(row('never'))).rejects.toMatchObject({ code: 'EPERM' });
    });

    it('CONTROL: a callback that fails still rejects with its own error', async () => {
        const store = new ThreadStore(dir);
        await expect(store.withLock('genie:agent:x:thread', async () => { throw new Error('the callback failed'); })).rejects.toThrow('the callback failed');
    });
});

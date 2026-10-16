import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Thread } from '@particle-academy/prism-harness';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId, threadKeyFor } from '../src/core/identity.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';

/**
 * A THREAD SURVIVES A RESTART, AND IT IS FOUND UNDER THE SAME KEY THAT WROTE IT.
 *
 * Two separate claims, and the previous build failed the second one invisibly.
 *
 * Durability is `prism-harness`'s, not ours: `FileSessionStore` + `Thread`. We use the
 * durability half of that package and not its `AgentRuntime` — confirmed by its author as
 * the intended seam, because `AgentRuntime` takes `LlmClient = (req) => Promise<res>` and so
 * assumes Prism is the agent, where ours is an external CLI owning its own thread over a
 * streaming protocol.
 *
 * What we have to get right ourselves is the KEY. These tests simulate a restart by throwing
 * the store away and opening a new one over the same directory — which is the only way to
 * tell real persistence from an in-process cache that would pass every other assertion.
 */
const dirs: string[] = [];
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-thread-'));
    dirs.push(d);
    return d;
}
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('agent thread durability', () => {
    it('survives a restart — a NEW store over the same directory finds the messages', async () => {
        const dir = tempDir();
        const id = mintAgentId();

        const before = openAgentThread(openDurableStore(dir), id);
        await before.record([{ role: 'user', text: 'the pty host dies on upgrade' }]);
        await before.record([{ role: 'assistant', text: 'reading ipc.ts' }]);

        // The restart. Nothing of the old store survives into this.
        const after = openAgentThread(openDurableStore(dir), id);
        const messages = await after.messages();

        expect(messages).toHaveLength(2);
        expect(messages[0]?.message).toMatchObject({ role: 'user' });
        expect(messages[1]?.message).toMatchObject({ role: 'assistant' });
        // Positions are assigned by the thread and start at 1 — a restart must not renumber.
        expect(messages.map((m) => m.position)).toEqual([1, 2]);
    });

    it('reads under the key the writer used — the identity split, pinned', async () => {
        /**
         * THE beta.2 DEFECT. The writer stored under one id and the reader looked under
         * another; nothing threw and the UI rendered a correct, empty session forever.
         *
         * Asserted here by going around the front door: write through the agent helper, then
         * read through prism-harness's own `Thread` at `threadKeyFor` — the one key function —
         * and require the row to be there. If a second key shape is ever introduced, the writer
         * and this reader stop agreeing and this fails. (prism-harness 0.7.0 keeps a thread's
         * rows in an append-only log beside the payload, so the raw `get` of the key is no longer
         * where the rows are; the Thread at that key is.)
         */
        const dir = tempDir();
        const id = mintAgentId();

        await openAgentThread(openDurableStore(dir), id).record([{ role: 'user', text: 'hello' }]);

        const read = new Thread(openDurableStore(dir), threadKeyFor(id));
        expect(await read.count()).toBe(1);
        expect((await read.messages()).map((m) => m.message)).toEqual([{ role: 'user', text: 'hello' }]);
    });

    it('POSITIVE CONTROL: a different agent reads nothing — threads do not bleed', async () => {
        // Without this, "the reader finds it" would pass against a store that returned the
        // same payload for every key, which is the other way to make one thread look right.
        const dir = tempDir();
        const mine = mintAgentId();
        const theirs = mintAgentId();

        await openAgentThread(openDurableStore(dir), mine).record([{ role: 'user', text: 'mine' }]);

        expect(await openAgentThread(openDurableStore(dir), theirs).messages()).toEqual([]);
    });

    it('distinguishes NEVER RAN from RAN AND SAID NOTHING', async () => {
        // `[]` is a measured none. The agent record's `threadId: null` is "cannot see / never
        // ran". The UI renders these differently and the storage layer must not collapse them.
        const dir = tempDir();
        const thread = openAgentThread(openDurableStore(dir), mintAgentId());

        expect(await thread.count()).toBe(0);
        expect(await thread.messages()).toEqual([]);
    });

    it('refuses a volatile store for durable state', async () => {
        // `prism-harness` makes a store declare its own durability and the manager refuses a
        // volatile one for durable slots. Pinned because it is the guard that stops a
        // half-answered approval living in a cache — and because relying on it means we must
        // not accidentally hand it an ephemeral store.
        expect(openDurableStore(tempDir()).durability()).toBe('durable');
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { InboxStore, type InboxMessage } from '../src/main/inbox-store.js';

it('story394: a hidden message is never acknowledged by a later visible receive and returns after redock, even after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-ghost-inbox-394-'));
    const ghost = mintAgentId(), awake = mintAgentId();
    let hidden = true;
    const visible = (message: InboxMessage) => !hidden || (message.from !== ghost && message.to !== ghost);
    const configure = (inbox: InboxStore) => {
        const set = (inbox as unknown as { setVisibility?: (test: (message: InboxMessage) => boolean) => void }).setVisibility;
        expect(typeof set).toBe('function'); set!.call(inbox, visible);
    };
    try {
        const store = await InboxStore.open(dir);
        await store.send({ from: ghost, to: 'human', text: 'Deferred while hidden' });
        await store.send({ from: awake, to: 'human', text: 'Visible mail' });
        configure(store);
        const first = await store.receive({ participant: 'human' });
        expect(first.messages.map((message) => message.text)).toEqual(['Visible mail']);
        expect(store.all().map((message) => message.text)).toEqual(['Visible mail']);
        const reopened = await InboxStore.open(dir); configure(reopened);
        expect((await reopened.receive({ participant: 'human' })).messages).toEqual([]);
        hidden = false;
        expect(reopened.receipts(ghost)[0]!.readAt).toBeNull();
        expect(reopened.receipts(awake)[0]!.readAt).not.toBeNull();
        const redocked = await reopened.receive({ participant: 'human' });
        expect(redocked.messages.map((message) => message.text)).toEqual(['Deferred while hidden']);
        expect((await reopened.receive({ participant: 'human' })).messages).toEqual([]);
        expect(reopened.all().map((message) => message.text)).toEqual(['Deferred while hidden', 'Visible mail']);
        const replay = await reopened.receive({ participant: 'human', cursor: 0, acknowledge: false });
        expect(replay.messages).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

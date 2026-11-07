import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import * as pushes from '../src/main/agent-push.js';
import { InboxReplica } from '../src/main/agent-stores-replica.js';
import { InboxStore, type InboxMessage } from '../src/main/inbox-store.js';

interface Changes { onMessagesChanged(listener: (messages: readonly InboxMessage[]) => void): () => void }
const observe = (source: object, listener: (messages: readonly InboxMessage[]) => void) => {
    const changes = source as Changes;
    expect(typeof changes.onMessagesChanged).toBe('function');
    return changes.onMessagesChanged(listener);
};
const wire = (source: object, changed: (id: string) => void) => {
    const connect = (pushes as unknown as { wireInboxChatUpdates?: (inbox: Changes, changed: (id: string) => void) => () => void }).wireInboxChatUpdates;
    expect(typeof connect).toBe('function');
    return connect!(source as Changes, changed);
};
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-inbox-chat-672-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const sender = mintAgentId(), recipient = mintAgentId();

describe('mail-card changes reach only their participants after the inbox has adopted them', () => {
    it('the host announces arrival, refusal and provider acceptance once each, with readable current state', async () => {
        const inbox = await InboxStore.open(dir);
        const seen: string[][] = [];
        const off = observe(inbox, messages => {
            expect(messages.every(m => inbox.all().includes(m))).toBe(true);
            seen.push(messages.map(m => m.readAt !== null ? 'delivered' : m.deliveryRefusal?.reason ?? 'waiting'));
        });
        const mail = await inbox.send({ from: sender, to: recipient, text: 'Wait for me.' });
        await inbox.recordDeliveryRefusal(recipient, [mail.id], { attempts: 5, reason: 'Provider is paused' });
        await inbox.markDelivered(recipient, [mail.id]);
        expect(seen).toEqual([['waiting'], ['Provider is paused'], ['delivered']]);
        off();
        await inbox.send({ from: sender, to: recipient, text: 'No longer observed.' });
        expect(seen).toHaveLength(3);
    });

    it('the replica announces delta changes after adoption, without duplicating the later sent/read events', () => {
        const inbox = new InboxReplica(async () => { throw new Error('no write in this delta fixture'); });
        inbox.rebase({ messages: [], cursors: {} });
        const states: string[] = [];
        observe(inbox, messages => {
            expect(inbox.involving(recipient)).toContain(messages[0]);
            states.push(messages[0]!.readAt ? 'delivered' : messages[0]!.deliveryRefusal?.reason ?? 'waiting');
        });
        const mail: InboxMessage = { id: 'm1', seq: 1, from: sender, to: recipient, text: 'hello', attachments: [], sentAt: new Date(0).toISOString(), readAt: null };
        const apply = (appended: InboxMessage[], updated: InboxMessage[]) => inbox.apply({ store: 'inbox', kind: 'delta', appended, updated, removed: [], cursors: {} });
        apply([mail], []);
        inbox.apply({ store: 'inbox', kind: 'sent', to: recipient, messageId: mail.id });
        apply([], [{ ...mail, deliveryRefusal: { attempts: 5, reason: 'not ready', at: mail.sentAt } }]);
        apply([], [{ ...mail, readAt: new Date(1).toISOString() }]);
        inbox.apply({ store: 'inbox', kind: 'read', reader: recipient, ids: [mail.id] });
        expect(states).toEqual(['waiting', 'not ready', 'delivered']);
    });

    it('chat wiring refreshes both agent participants, excludes the human, and disconnects cleanly', async () => {
        const inbox = await InboxStore.open(dir);
        const changed: string[] = [];
        const off = wire(inbox, id => changed.push(id));
        const mail = await inbox.send({ from: sender, to: recipient, text: 'hello' });
        expect(changed).toEqual([sender, recipient]);
        changed.length = 0;
        await inbox.recordDeliveryRefusal(recipient, [mail.id], { attempts: 5, reason: 'wait' });
        expect(changed).toEqual([sender, recipient]);
        changed.length = 0;
        await inbox.markDelivered(recipient, [mail.id]);
        expect(changed).toEqual([sender, recipient]);
        changed.length = 0;
        await inbox.send({ from: 'human', to: recipient, text: 'The human is not an agent detail.' });
        expect(changed).toEqual([recipient]);
        off(); changed.length = 0;
        await inbox.send({ from: sender, to: recipient, text: 'No subscriptions remain.' });
        expect(changed).toEqual([]);
    });

    it('a failing chat observer cannot prevent durable mail or its delivery notification', async () => {
        const inbox = await InboxStore.open(dir);
        observe(inbox, () => { throw new Error('broken view'); });
        const sent: string[] = [];
        inbox.onSend((_to, message) => sent.push(message.id));
        const mail = await inbox.send({ from: sender, to: recipient, text: 'Must still arrive.' });
        expect(sent).toEqual([mail.id]);
        expect((await InboxStore.open(dir)).unread(recipient).map(m => m.id)).toEqual([mail.id]);
    });

    it('thread deletion and replica reconnect refresh the affected chats from their current state', async () => {
        const inbox = await InboxStore.open(dir);
        const mail = await inbox.send({ from: sender, to: recipient, text: 'Remove this card.' });
        const removed: string[] = [];
        observe(inbox, messages => {
            expect(inbox.involving(recipient)).toEqual([]);
            removed.push(...messages.map(m => m.id));
        });
        await inbox.deleteThread(sender, recipient);
        expect(removed).toEqual([mail.id]);
        const replica = new InboxReplica(async () => null);
        replica.rebase({ messages: [mail], cursors: {} });
        const changed: string[] = [];
        wire(replica, id => changed.push(id));
        replica.rebase({ messages: [], cursors: {} });
        expect(changed).toEqual([sender, recipient]);
        expect(replica.involving(recipient)).toEqual([]);
    });
});

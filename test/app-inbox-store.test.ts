import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appSenderId, type AppMessageMeta } from '../src/core/app-inbox.js';
import { mintAgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { InboxStore } from '../src/main/inbox-store.js';

/**
 * AN APP'S MAIL IN THE DURABLE INBOX (genie#1345). It is ordinary mail to the agent — durable, receipted, read only by its
 * own receive — with the sender's facts beside it. The store holds two rules of its own: an app's `from` must be the one
 * its facts name (nothing else may claim an app's identity, and an app cannot claim anyone else's), and an app attaches
 * nothing (a send's attachments are PATHS the store reads, which would let an app make Genie read any file).
 */

let dir: string;
let store: InboxStore;
const clerk = mintAgentId();
const meta: AppMessageMeta = { source: { kind: 'site', id: 'site_flabs', name: 'flabs', workspaceId: 'fancy' }, label: 'site:flabs@fancy', subject: '3 petitions queued', level: 'info' };
const from = appSenderId(meta.source);

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-app-inbox-store-'));
    store = await InboxStore.open(dir);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('an app message', () => {
    it('is stored with its sender’s facts, delivered to the agent, and survives a restart', async () => {
        const sent = await store.send({ from, to: clerk, text: 'Change #42 approved', app: meta });
        expect(sent.from).toBe('app:site:site_flabs');
        expect(sent.app).toEqual(meta);
        const reopened = await InboxStore.open(dir);
        const page = await reopened.receive({ participant: clerk });
        expect(page.messages).toHaveLength(1);
        expect(page.messages[0]).toMatchObject({ from, text: 'Change #42 approved', app: meta });
    });

    it('has receipts by its sender id: unread, then read when the agent collects it', async () => {
        const sent = await store.send({ from, to: clerk, text: 'b', app: meta });
        expect(store.receipts(from)[0]).toMatchObject({ message: { id: sent.id }, readAt: null });
        await store.receive({ participant: clerk });
        expect(store.receipts(from)[0]!.readAt).not.toBeNull();
    });

    it('is refused when its `from` is not the app its facts name — either way round', async () => {
        await expect(store.send({ from: HUMAN, to: clerk, text: 'x', app: meta })).rejects.toThrow(/app/);
        await expect(store.send({ from: mintAgentId(), to: clerk, text: 'x', app: meta })).rejects.toThrow(/app/);
        await expect(store.send({ from: 'app:site:other', to: clerk, text: 'x', app: meta })).rejects.toThrow(/app/);
        // An app id with no facts is refused too: nobody sends AS an app except through the app door.
        await expect(store.send({ from, to: clerk, text: 'x' })).rejects.toThrow(/app/);
        expect(store.all()).toHaveLength(0);
    });

    it('carries no attachments — a path is refused and nothing is read or stored', async () => {
        const file = join(dir, 'secret.txt');
        await writeFile(file, 'secret');
        await expect(store.send({ from, to: clerk, text: 'x', app: meta, attachments: [file] })).rejects.toThrow(/attach/);
        expect(store.all()).toHaveLength(0);
    });

    it('cannot be addressed TO an app', async () => {
        await expect(store.send({ from: clerk, to: from, text: 'reply' })).rejects.toThrow(/app/);
    });

    it('mail between people and agents is unchanged: no `app` field appears on it (the other direction)', async () => {
        const m = await store.send({ from: HUMAN, to: clerk, text: 'hi' });
        expect('app' in m).toBe(false);
    });
});

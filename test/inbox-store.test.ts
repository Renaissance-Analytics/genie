import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { InboxStore } from '../src/main/inbox-store.js';

/**
 * AGENTINBOX — the durable half (§6.4).
 *
 * Local, durable agent-to-agent messaging. Everything below is about the four properties that
 * made v1's inbox trustworthy: mail survives a restart; `receive` is the ONLY thing that marks
 * mail read and the cursor rewinds; long-poll wakes on delivery rather than polling; an
 * attachment is a BYTE COPY the recipient can read after the sender's file is gone.
 */

let dir: string;
let store: InboxStore;
const a = mintAgentId();
const b = mintAgentId();

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-inbox-'));
    store = await InboxStore.open(dir);
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('send and receive', () => {
    it('delivers to the recipient only, in order, with a sequence the cursor can hold', async () => {
        await store.send({ from: a, to: b, text: 'one' });
        await store.send({ from: a, to: b, text: 'two' });
        await store.send({ from: b, to: a, text: 'reply' });

        const forB = await store.receive({ participant: b });
        expect(forB.messages.map((m) => m.text)).toEqual(['one', 'two']);
        expect(forB.messages.map((m) => m.from)).toEqual([a, a]);
        expect(forB.cursor).toBe(forB.messages[1]!.seq);

        const forA = await store.receive({ participant: a });
        expect(forA.messages.map((m) => m.text)).toEqual(['reply']);
    });

    it('the human is a participant like any other', async () => {
        await store.send({ from: HUMAN, to: a, text: 'go' });
        await store.send({ from: a, to: HUMAN, text: 'done' });

        expect((await store.receive({ participant: a })).messages.map((m) => m.text)).toEqual(['go']);
        expect((await store.receive({ participant: HUMAN })).messages.map((m) => m.text)).toEqual(['done']);
    });

    it('survives a restart — the mail AND the cursor', async () => {
        await store.send({ from: a, to: b, text: 'before' });
        await store.receive({ participant: b });
        await store.send({ from: a, to: b, text: 'after' });

        const reopened = await InboxStore.open(dir);
        const got = await reopened.receive({ participant: b });
        // Only the unread one: the cursor was persisted, not just the messages.
        expect(got.messages.map((m) => m.text)).toEqual(['after']);
        expect(reopened.unreadCount(b)).toBe(0);
    });
});

describe('unread — a view that commits nothing', () => {
    it('lists the unread mail without marking it read; a committing receive then empties it', async () => {
        await store.send({ from: a, to: b, text: 'one' });
        await store.send({ from: a, to: b, text: 'two' });
        expect(store.unread(b).map((m) => m.text)).toEqual(['one', 'two']);
        expect(store.unread(b).map((m) => m.text)).toEqual(['one', 'two']);
        expect(store.receipts(a).every((r) => r.readAt === null)).toBe(true);
        await store.receive({ participant: b });
        expect(store.unread(b)).toEqual([]);
    });
});

describe('read receipts — your receive is the ONLY thing that marks mail read', () => {
    it('a receive with acknowledge:false leaves mail unread and the cursor where it was', async () => {
        await store.send({ from: a, to: b, text: 'peek' });

        const peeked = await store.receive({ participant: b, acknowledge: false });
        expect(peeked.messages).toHaveLength(1);
        expect(store.unreadCount(b)).toBe(1);
        expect(store.receipts(a)[0]!.readAt).toBeNull();

        // POSITIVE CONTROL: the default receive commits.
        const read = await store.receive({ participant: b });
        expect(read.messages).toHaveLength(1);
        expect(store.unreadCount(b)).toBe(0);
        expect(store.receipts(a)[0]!.readAt).not.toBeNull();
    });

    it('a sender sees who read what, newest first, capped', async () => {
        for (let i = 0; i < 3; i++) await store.send({ from: a, to: b, text: `m${i}` });
        await store.receive({ participant: b });
        await store.send({ from: a, to: b, text: 'unread' });

        const r = store.receipts(a, 2);
        expect(r.map((x) => x.message.text)).toEqual(['unread', 'm2']);
        expect(r[0]!.readAt).toBeNull();
        expect(r[1]!.readAt).not.toBeNull();
    });

    it('the cursor REWINDS: a lower cursor re-reads, and acknowledging that page recommits from there', async () => {
        await store.send({ from: a, to: b, text: 'first' });
        const second = await store.send({ from: a, to: b, text: 'second' });
        await store.receive({ participant: b });
        expect(store.unreadCount(b)).toBe(0);

        const again = await store.receive({ participant: b, cursor: 0 });
        expect(again.messages.map((m) => m.text)).toEqual(['first', 'second']);
        expect(again.cursor).toBe(second.seq);

        // Rewind to BEFORE `second` and acknowledge only `first`: second is unread again.
        const partial = await store.receive({ participant: b, cursor: 0, limit: 1 });
        expect(partial.messages.map((m) => m.text)).toEqual(['first']);
        expect(store.unreadCount(b)).toBe(1);
    });
});

describe('long-poll — never a poll loop', () => {
    it('a waiting receive is WOKEN by delivery, with the message', async () => {
        const waiting = store.receive({ participant: b, wait: true, timeoutMs: 5_000 });
        const before = Date.now();
        setTimeout(() => void store.send({ from: a, to: b, text: 'wake' }), 30);

        const got = await waiting;
        expect(got.messages.map((m) => m.text)).toEqual(['wake']);
        // Woken by the send, not by the timeout.
        expect(Date.now() - before).toBeLessThan(2_000);
    });

    it('a waiting receive with nothing arriving returns empty at the timeout, cursor unchanged', async () => {
        const got = await store.receive({ participant: b, wait: true, timeoutMs: 50 });
        expect(got.messages).toEqual([]);
        expect(got.cursor).toBe(0);
    });

    it('mail for SOMEONE ELSE does not wake you', async () => {
        const waiting = store.receive({ participant: b, wait: true, timeoutMs: 120 });
        setTimeout(() => void store.send({ from: a, to: HUMAN, text: 'not for b' }), 20);
        const got = await waiting;
        expect(got.messages).toEqual([]);
    });
});

describe('attachments are BYTE COPIES, never path references', () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');

    it('the recipient reads the bytes after the sender’s file is deleted', async () => {
        const src = join(dir, 'notes.md');
        await writeFile(src, 'hello attachment');
        const sent = await store.send({ from: a, to: b, text: 'see attached', attachments: [src] });
        await rm(src);

        const got = await store.receive({ participant: b });
        const att = got.messages[0]!.attachments[0]!;
        expect(att).toMatchObject({ name: 'notes.md', size: 16, sha256: sha('hello attachment') });
        expect((await store.attachmentBytes(b, att.id)).toString()).toBe('hello attachment');
        expect(sent.attachments[0]!.id).toBe(att.id);
    });

    it('identical files are stored ONCE', async () => {
        await writeFile(join(dir, 'x.md'), 'same bytes');
        await writeFile(join(dir, 'y.md'), 'same bytes');
        await store.send({ from: a, to: b, text: '1', attachments: [join(dir, 'x.md')] });
        await store.send({ from: a, to: b, text: '2', attachments: [join(dir, 'y.md')] });

        const stored = await readdir(store.attachmentsDir);
        expect(stored).toHaveLength(1);
        // And a DIFFERENT file makes a second blob — the positive control for "once".
        await writeFile(join(dir, 'z.md'), 'other bytes');
        await store.send({ from: a, to: b, text: '3', attachments: [join(dir, 'z.md')] });
        expect(await readdir(store.attachmentsDir)).toHaveLength(2);
    });

    it('one unreadable path fails the WHOLE send — nothing is delivered', async () => {
        await writeFile(join(dir, 'ok.md'), 'fine');
        await expect(
            store.send({ from: a, to: b, text: 'partial?', attachments: [join(dir, 'ok.md'), join(dir, 'missing.md')] }),
        ).rejects.toThrow(/missing\.md/);
        expect((await store.receive({ participant: b })).messages).toEqual([]);
        expect(await readdir(store.attachmentsDir).catch(() => [])).toEqual([]);
    });

    it('an executable is refused at the sending end', async () => {
        await writeFile(join(dir, 'tool.exe'), 'MZ');
        await expect(store.send({ from: a, to: b, text: 'run this', attachments: [join(dir, 'tool.exe')] })).rejects.toThrow(/executable/);
        expect((await store.receive({ participant: b })).messages).toEqual([]);
    });

    it('…and at the receiving end, even if a blob with that name is on disk', async () => {
        await writeFile(join(dir, 'tool.md'), 'MZ');
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: [join(dir, 'tool.md')] });
        await expect(store.saveAttachment(b, sent.attachments[0]!.id, join(dir, 'out', 'tool.cmd'))).rejects.toThrow(/executable/);
        // POSITIVE CONTROL: the same bytes save fine under a non-executable name.
        const saved = await store.saveAttachment(b, sent.attachments[0]!.id, join(dir, 'out', 'tool.md'));
        expect((await readFile(saved)).toString()).toBe('MZ');
    });

    it('a save that would clobber a file fails unless overwrite is asked for', async () => {
        await writeFile(join(dir, 'a.md'), 'new');
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: [join(dir, 'a.md')] });
        const dest = join(dir, 'existing.md');
        await writeFile(dest, 'old');
        await expect(store.saveAttachment(b, sent.attachments[0]!.id, dest)).rejects.toThrow(/exists/);
        expect((await readFile(dest)).toString()).toBe('old');
        await store.saveAttachment(b, sent.attachments[0]!.id, dest, { overwrite: true });
        expect((await readFile(dest)).toString()).toBe('new');
    });

    it('only a party to the message can fetch its bytes — the id alone is not access', async () => {
        await writeFile(join(dir, 'secret.md'), 'for b only');
        const sent = await store.send({ from: a, to: b, text: 'x', attachments: [join(dir, 'secret.md')] });
        const stranger = mintAgentId();
        await expect(store.attachmentBytes(stranger, sent.attachments[0]!.id)).rejects.toThrow(/not a party/);
        // Sender and recipient both can.
        expect((await store.attachmentBytes(a, sent.attachments[0]!.id)).toString()).toBe('for b only');
        expect((await store.attachmentBytes(b, sent.attachments[0]!.id)).toString()).toBe('for b only');
    });

    it('the per-file cap is enforced on the real size, before anything is copied', async () => {
        const big = join(dir, 'big.bin');
        await writeFile(big, Buffer.alloc(25 * 1024 * 1024 + 1));
        await expect(store.send({ from: a, to: b, text: 'x', attachments: [big] })).rejects.toThrow(/25 MB/);
        expect(await readdir(store.attachmentsDir).catch(() => [])).toEqual([]);
        expect((await stat(big)).size).toBe(25 * 1024 * 1024 + 1);
    });
});

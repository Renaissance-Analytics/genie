import { describe, expect, it } from 'vitest';
import { inboxThreads, pairKey, type ThreadMail, type ThreadSummary } from '../src/core/inbox-threads.js';

/**
 * THE AGENTINBOX'S THREADS ARE DERIVED INCREMENTALLY (Tynn #663). Every features snapshot in window main lists the threads
 * over ALL the mail; at the owner's scale (9,500 mails) rebuilding every thread — and joining every message's text into a
 * search haystack only to keep its last 20,000 characters — allocated about 2.7 GB per 5 minutes (the #662 soak's
 * sampling profile: `join`, `toLowerCase`, `replace` under `inboxThreads`). The inbox never edits a message in place: a
 * send appends one, a read or a refusal replaces it, a delete drops it. So a thread whose messages are the same objects
 * as last time, under the same two names, is the same thread, and is not built again.
 *
 * Messages are read through a counting `text` getter: a rebuild reads texts, a reuse reads none. The first call is the
 * positive control (it must read them).
 */
const T = Date.UTC(2026, 10, 13, 12, 0, 0);
let reads = 0;
let seq = 0;
const m = (from: string, to: string, text: string, readAt: string | null = null): ThreadMail => {
    seq += 1;
    const msg = { seq, id: `msg_${seq}`, from, to, attachments: [], sentAt: new Date(T + seq * 1000).toISOString(), readAt };
    return Object.defineProperty(msg, 'text', { enumerable: true, get: () => { reads += 1; return text; } }) as ThreadMail;
};
const names: Record<string, string> = { human: 'you', a1: 'atlas', a2: 'wren', a3: 'vesper' };
const name = (p: string): string => names[p] ?? p;
const byKey = (threads: readonly ThreadSummary[]) => Object.fromEntries(threads.map((t) => [t.key, t]));

describe('inboxThreads reuses what did not change (Tynn #663)', () => {
    it('the same mail in a fresh array (as the inbox hands it out): the same threads, and no message text read again', () => {
        seq = 0;
        const mail = Array.from({ length: 900 }, (_, i) => m(i % 3 === 0 ? 'human' : `a${(i % 3) + 0}`, i % 3 === 0 ? 'a1' : 'human', `message ${i}`));
        reads = 0;
        const first = inboxThreads(mail, name);
        // Positive control: building reads the texts.
        expect(reads).toBeGreaterThan(0);
        reads = 0;
        const second = inboxThreads([...mail], name);
        expect(second.map((t) => t.key)).toEqual(first.map((t) => t.key));
        second.forEach((t, i) => expect(t).toBe(first[i]));
        expect(reads).toBe(0);
    });

    it('a message sent in one thread: only that thread is built again, and it counts the new message', () => {
        seq = 0;
        const mail = [m('human', 'a1', 'ship it?'), m('a1', 'human', 'shipped'), m('a2', 'a3', 'cache work'), m('a3', 'human', 'review ready')];
        const first = byKey(inboxThreads(mail, name));
        reads = 0;
        const next = byKey(inboxThreads([...mail, m('a2', 'a3', 'handing over')], name));
        expect(next[pairKey('a1', 'human')]).toBe(first[pairKey('a1', 'human')]);
        expect(next[pairKey('a3', 'human')]).toBe(first[pairKey('a3', 'human')]);
        const changed = next[pairKey('a2', 'a3')]!;
        expect(changed).not.toBe(first[pairKey('a2', 'a3')]);
        expect(changed).toMatchObject({ count: 2, lastPreview: 'handing over', waiting: { agent: 'vesper', count: 2 } });
        expect(changed.haystack).toContain('handing over');
        // Only the changed thread's two messages were read (its haystack and preview), never the others'.
        expect(reads).toBeGreaterThan(0);
        expect(reads).toBeLessThanOrEqual(3);
    });

    it('a message READ (replaced by the inbox), a participant renamed, a thread deleted: each is seen', () => {
        seq = 0;
        const mail = [m('a1', 'human', 'notes ready'), m('a2', 'human', 'build green')];
        const first = byKey(inboxThreads(mail, name));
        expect(first[pairKey('a1', 'human')]!.unread).toBe(1);
        // The inbox's read: a new object for the message, the rest untouched.
        const read = Object.defineProperty({ ...mail[0]!, readAt: new Date(T).toISOString() }, 'text', { enumerable: true, value: 'notes ready' }) as ThreadMail;
        const afterRead = byKey(inboxThreads([read, mail[1]!], name));
        expect(afterRead[pairKey('a1', 'human')]!.unread).toBe(0);
        expect(afterRead[pairKey('a2', 'human')]).toBe(first[pairKey('a2', 'human')]);
        // Renamed: the names are in the summary and in what search reads.
        const renamed = byKey(inboxThreads([read, mail[1]!], (p) => (p === 'a2' ? 'kestrel' : name(p))));
        expect(renamed[pairKey('a2', 'human')]).toMatchObject({ aName: 'kestrel', lastFrom: 'kestrel' });
        expect(renamed[pairKey('a2', 'human')]!.haystack).toContain('kestrel');
        expect(renamed[pairKey('a1', 'human')]).toBe(afterRead[pairKey('a1', 'human')]);
        // Deleted: gone from the list.
        expect(inboxThreads([mail[1]!], name).map((t) => t.key)).toEqual([pairKey('a2', 'human')]);
    });

    it('a long thread’s haystack is its last 20,000 characters, read from the END: not every message’s text', () => {
        seq = 0;
        const texts = Array.from({ length: 2000 }, (_, i) => `Message ${i} ÄBC ${'x'.repeat(90)}`);
        const mail = texts.map((text, i) => m(i % 2 ? 'a1' : 'human', i % 2 ? 'human' : 'a1', text));
        reads = 0;
        const [thread] = inboxThreads(mail, name);
        // What it must equal: every name and text joined, lower-cased, the last 20,000 characters (as before #663).
        const expected = ['atlas', 'you', ...texts].join('\n').toLowerCase().slice(-20_000);
        expect(thread!.haystack).toBe(expected);
        expect(thread!.count).toBe(2000);
        // 2,000 texts of ~105 characters: about 190 fill the window, never all 2,000.
        expect(reads).toBeLessThan(400);
    });

    it('a thread shorter than the window keeps every name and text, in order', () => {
        seq = 0;
        const mail = [m('human', 'a1', 'Ship The Cache?'), m('a1', 'human', 'SHIPPED')];
        const [thread] = inboxThreads(mail, name);
        expect(thread!.haystack).toBe('atlas\nyou\nship the cache?\nshipped');
    });
});
